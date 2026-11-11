const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const BsvHeaders = require('bsv-headers').default;
const { Beef } = require('@bsv/sdk');
const { bananaBlocksFetch } = require('./bananablocks.cjs');
const {
  getWalletData,
  getWalletHeaderChain,
  saveWalletHeaderChain,
  getWalletTransactionProof,
  saveWalletTransactionProof,
  invalidateWalletProofs,
} = require('./wallet-data.cjs');

const API = 'https://bananablocks.com/api/v1';
const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const GENESIS_HEADER = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const MAINNET_POW_LIMIT = '00000000ffff0000000000000000000000000000000000000000000000000000';
const HEADER_BYTES = 80;
const HEADER_RANGE_LIMIT = 2016;
const HEADER_VALIDATION_VERSION = 3;
const PROOF_VALIDATION_VERSION = 1;
const BSV_CASH_FORK_HEIGHT = 478559;
const BSV_DAA_ACTIVATION_HEIGHT = 504032;
const MAX_FUTURE_SECONDS = 2 * 60 * 60;
const MAX_BEEF_HEX_BYTES = 32 * 1024 * 1024;
const HEADER_REQUEST_INTERVAL_MS = 300;
const HEADER_REQUEST_CONCURRENCY = 4;
const MAX_REQUEST_RETRIES = 3;

const progressListeners = new Set();
let requestQueue = Promise.resolve();
let nextRequestAt = 0;
let headerSyncPromise = null;
let activeState = null;
let requestIntervalMs = HEADER_REQUEST_INTERVAL_MS;

class CachedHeaderValidationError extends Error {
  constructor(cause, invalidRangeStart, validatedTipHeight, chainWork) {
    super(`The local SPV header cache failed validation: ${cause.message}`);
    this.name = 'CachedHeaderValidationError';
    this.cause = cause;
    this.invalidRangeStart = invalidRangeStart;
    this.validatedTipHeight = validatedTipHeight;
    this.chainWork = chainWork;
  }
}

function headerCachePath() {
  return path.join(app.getPath('userData'), 'spv', 'mainnet.headers');
}

function emitProgress(progress) {
  for (const listener of progressListeners) {
    try {
      listener(progress);
    } catch (error) {
      console.error('Could not notify a wallet SPV progress listener:', error.message);
    }
  }
}

function onProgress(listener) {
  if (typeof listener !== 'function') throw new Error('The SPV progress listener must be a function.');
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

function doubleSha256(bytes) {
  return crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(bytes).digest())
    .digest();
}

function headerHash(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== HEADER_BYTES) throw new Error('A BSV block header must be exactly 80 bytes.');
  return Buffer.from(doubleSha256(bytes)).reverse().toString('hex');
}

function headerMerkleRoot(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== HEADER_BYTES) throw new Error('A BSV block header must be exactly 80 bytes.');
  return Buffer.from(bytes.subarray(36, 68)).reverse().toString('hex');
}

function headerTime(bytes) {
  return bytes.readUInt32LE(68);
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function medianTimePast(window, readStart, height) {
  const times = [];
  for (let previousHeight = Math.max(0, height - 11); previousHeight < height; previousHeight++) {
    const offset = (previousHeight - readStart) * HEADER_BYTES;
    if (offset < 0 || offset + HEADER_BYTES > window.length) throw new Error(`The local SPV header window is missing block ${previousHeight}.`);
    times.push(headerTime(window.subarray(offset, offset + HEADER_BYTES)));
  }
  return times.length ? median(times) : null;
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const result = await handle.read(buffer, total, length - total, position + total);
    if (result.bytesRead === 0) throw new Error('The local SPV header cache ended unexpectedly.');
    total += result.bytesRead;
  }
  return buffer;
}

async function readFileRange(filePath, startHeight, endHeight) {
  if (endHeight < startHeight) return Buffer.alloc(0);
  const handle = await fs.open(filePath, 'r');
  try {
    return await readExact(handle, (endHeight - startHeight + 1) * HEADER_BYTES, startHeight * HEADER_BYTES);
  } finally {
    await handle.close();
  }
}

async function readHeader(filePath, height) {
  if (!Number.isSafeInteger(height) || height < 0) throw new Error('The requested SPV block height is invalid.');
  return readFileRange(filePath, height, height);
}

async function digestFile(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function writeHeaderRange(filePath, startHeight, bytes) {
  const offset = startHeight * HEADER_BYTES;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let handle;
  try {
    handle = await fs.open(filePath, 'r+');
  } catch (error) {
    if (error.code !== 'ENOENT' || startHeight !== 0) throw error;
    handle = await fs.open(filePath, 'w+');
  }
  try {
    await handle.truncate(offset);
    let total = 0;
    while (total < bytes.length) {
      const result = await handle.write(bytes, total, bytes.length - total, offset + total);
      if (result.bytesWritten === 0) throw new Error('Could not write the local SPV header cache.');
      total += result.bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function truncateHeaderCache(filePath, byteLength) {
  const handle = await fs.open(filePath, 'r+');
  try {
    await handle.truncate(byteLength);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function windowSeedHeight(startHeight) {
  if (startHeight <= 0) return 0;
  return Math.floor(startHeight / HEADER_RANGE_LIMIT) * HEADER_RANGE_LIMIT - HEADER_RANGE_LIMIT;
}

function createHeaderValidator(anchor, seedHeight) {
  return new BsvHeaders({
    network: {
      name: 'BSV',
      genesisHeader: anchor,
      maxTarget: MAINNET_POW_LIMIT,
      difficultyAlgorithm: 'cash',
      cashForkHeight: BSV_CASH_FORK_HEIGHT - seedHeight,
      cashDaaActivationHeight: BSV_DAA_ACTIVATION_HEIGHT - seedHeight,
      targetSpacing: 10 * 60,
      retargetInterval: HEADER_RANGE_LIMIT,
      targetTimespan: 14 * 24 * 60 * 60,
    },
    genesisHeader: anchor,
    maxTarget: MAINNET_POW_LIMIT,
    maxReorgDepth: 0,
    validateProofOfWork: true,
    validateDifficulty: true,
  });
}

function addHeaderForRange(headers, bytes, height, startHeight) {
  const validateDifficulty = headers.validateDifficulty;
  headers.validateDifficulty = validateDifficulty && height >= startHeight;
  try {
    return headers.addHeader({ buf: bytes });
  } finally {
    headers.validateDifficulty = validateDifficulty;
  }
}

async function validateHeaderRange(filePath, startHeight, endHeight, chunk, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(startHeight) || startHeight < 0
    || !Number.isSafeInteger(endHeight) || endHeight < startHeight
    || endHeight - startHeight + 1 > HEADER_RANGE_LIMIT
    || !Buffer.isBuffer(chunk) || chunk.length !== (endHeight - startHeight + 1) * HEADER_BYTES) {
    throw new Error('The supplied BSV header range is malformed or exceeds 2,016 headers.');
  }

  const seedHeight = windowSeedHeight(startHeight);
  const readStart = Math.max(0, seedHeight - 11);
  const prefix = startHeight > readStart
    ? await readFileRange(filePath, readStart, startHeight - 1)
    : Buffer.alloc(0);
  const window = Buffer.concat([prefix, chunk]);
  const anchorOffset = (seedHeight - readStart) * HEADER_BYTES;
  const anchor = window.subarray(anchorOffset, anchorOffset + HEADER_BYTES);
  if (anchor.length !== HEADER_BYTES) throw new Error('The SPV header cache is missing its difficulty anchor.');
  if (seedHeight === 0 && headerHash(anchor) !== GENESIS_HASH) {
    throw new Error('The local SPV header chain does not begin at the BSV mainnet genesis block.');
  }

  const headers = createHeaderValidator(anchor, seedHeight);
  let rejectionReason = null;
  headers.logger = { warn: message => { rejectionReason = message; } };

  for (let height = seedHeight + 1; height <= endHeight; height++) {
    const offset = (height - readStart) * HEADER_BYTES;
    const bytes = window.subarray(offset, offset + HEADER_BYTES);
    if (bytes.length !== HEADER_BYTES) throw new Error(`The SPV header window is missing block ${height}.`);
    const previousMedian = medianTimePast(window, readStart, height);
    if (previousMedian !== null && headerTime(bytes) <= previousMedian) {
      throw new Error(`BSV block ${height} violates median-time-past.`);
    }
    if (headerTime(bytes) > nowSeconds + MAX_FUTURE_SECONDS) {
      throw new Error(`BSV block ${height} is more than two hours in the future.`);
    }
    rejectionReason = null;
    if (!addHeaderForRange(headers, bytes, height, startHeight)) {
      const detail = rejectionReason ? ` (${rejectionReason})` : '';
      throw new Error(`BSV block header ${height} failed proof-of-work, difficulty, or linkage validation${detail}.`);
    }
  }

  const tip = headers.getTip();
  const expectedLocalHeight = endHeight - seedHeight;
  if (tip.height !== expectedLocalHeight || tip.hash !== headerHash(window.subarray((endHeight - readStart) * HEADER_BYTES, (endHeight - readStart + 1) * HEADER_BYTES))) {
    throw new Error(`The BSV header chain did not select the expected best-work header at height ${endHeight}.`);
  }
  const totalWork = headers.getChainWork(headers.getHash(expectedLocalHeight));
  const previousWork = startHeight === 0
    ? 0n
    : headers.getChainWork(headers.getHash(startHeight - 1 - seedHeight));
  return {
    tipHeight: endHeight,
    tipHash: tip.hash,
    chainWork: (totalWork - previousWork).toString(),
  };
}

async function requestSlot() {
  const operation = requestQueue.catch(() => {}).then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    nextRequestAt = Date.now() + requestIntervalMs;
  });
  requestQueue = operation.catch(() => {});
  return operation;
}

function retryAfterMs(response, attempt) {
  const retryAfter = response.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60000, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(60000, Math.max(0, date - Date.now()));
  }
  return Math.min(30000, 1000 * (2 ** attempt));
}

async function fetchBananaBlocks(url, accept) {
  let response;
  for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt++) {
    await requestSlot();
    response = await bananaBlocksFetch(url, {
      headers: { Accept: accept },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status !== 429 || attempt === MAX_REQUEST_RETRIES) break;
    const waitMs = retryAfterMs(response, attempt);
    nextRequestAt = Math.max(nextRequestAt, Date.now() + waitMs);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  return response;
}

async function fetchJson(url) {
  const response = await fetchBananaBlocks(url, 'application/json');
  const text = await response.text();
  if (!response.ok) throw new Error(`BananaBlocks returned HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
  try { return JSON.parse(text); } catch { throw new Error('BananaBlocks returned an unreadable SPV response.'); }
}

async function fetchHeaderRange(startHeight, endHeight) {
  if (endHeight - startHeight + 1 > HEADER_RANGE_LIMIT) throw new Error('A BananaBlocks SPV request cannot exceed 2,016 headers.');
  const response = await fetchBananaBlocks(`${API}/bsv/main/block/headers/${startHeight}-${endHeight}`, 'application/octet-stream');
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`BananaBlocks could not supply headers ${startHeight}-${endHeight} (HTTP ${response.status})${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== (endHeight - startHeight + 1) * HEADER_BYTES) {
    throw new Error(`BananaBlocks returned an incomplete header range ${startHeight}-${endHeight}.`);
  }
  return bytes;
}

async function fetchRemoteTip() {
  const body = await fetchJson(`${API}/block/tip`);
  const height = Number(body?.height);
  const hash = String(body?.hash || '').toLowerCase();
  if (!Number.isSafeInteger(height) || height < 0 || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error('BananaBlocks returned an invalid BSV mainnet tip.');
  }
  return { height, hash };
}

async function fetchRemoteBlockHash(height) {
  const body = await fetchJson(`${API}/block/${height}`);
  const hash = String(body?.hash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash) || Number(body?.height) !== height) {
    throw new Error(`BananaBlocks returned an invalid block at height ${height}.`);
  }
  return hash;
}

async function findCommonAncestor(filePath, upperHeight) {
  const genesis = await readHeader(filePath, 0);
  if (headerHash(genesis) !== GENESIS_HASH) throw new Error('The local SPV chain no longer matches BSV mainnet genesis.');
  let low = 0;
  let high = upperHeight;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const localHash = headerHash(await readHeader(filePath, middle));
    const remoteHash = await fetchRemoteBlockHash(middle);
    if (localHash === remoteHash) low = middle;
    else high = middle;
  }
  return low;
}

async function validateFullCache(filePath, totalHeaders, validateRange = validateHeaderRange) {
  if (!Number.isSafeInteger(totalHeaders) || totalHeaders < 1) throw new Error('The local SPV header cache is empty.');
  let chainWork = 0n;
  let validatedTipHeight = -1;
  const tipHeight = totalHeaders - 1;
  for (let start = 0; start <= tipHeight; start += HEADER_RANGE_LIMIT) {
    const end = Math.min(tipHeight, start + HEADER_RANGE_LIMIT - 1);
    const chunk = await readFileRange(filePath, start, end);
    let result;
    try {
      result = await validateRange(filePath, start, end, chunk);
    } catch (error) {
      throw new CachedHeaderValidationError(error, start, validatedTipHeight, chainWork.toString());
    }
    chainWork += BigInt(result.chainWork);
    validatedTipHeight = end;
    emitProgress({ phase: 'validating', completed: end + 1, total: totalHeaders, height: end });
  }
  return {
    tipHeight,
    tipHash: headerHash(await readHeader(filePath, tipHeight)),
    chainWork: chainWork.toString(),
  };
}

async function loadValidatedCache(address, filePath, validateRange = validateHeaderRange) {
  let stat;
  try { stat = await fs.stat(filePath); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const completeBytes = stat.size - (stat.size % HEADER_BYTES);
  if (completeBytes !== stat.size) {
    await truncateHeaderCache(filePath, completeBytes);
    stat = await fs.stat(filePath);
  }
  if (stat.size < HEADER_BYTES) return null;

  const tipHeight = stat.size / HEADER_BYTES - 1;
  const tipHash = headerHash(await readHeader(filePath, tipHeight));
  const digest = await digestFile(filePath);
  if (activeState?.digest === digest && activeState.tipHeight === tipHeight && activeState.tipHash === tipHash) {
    return { ...activeState, digest };
  }

  const saved = await getWalletHeaderChain(address);
  if (saved?.validationVersion === HEADER_VALIDATION_VERSION && saved.digest === digest
    && saved.tipHeight === tipHeight && saved.tipHash === tipHash && /^\d+$/.test(String(saved.chainWork || ''))) {
    return { ...saved, digest, validationVersion: HEADER_VALIDATION_VERSION };
  }

  emitProgress({ phase: 'validating', completed: 0, total: tipHeight + 1, height: 0 });
  let validated;
  try {
    validated = await validateFullCache(filePath, tipHeight + 1, validateRange);
  } catch (error) {
    if (!(error instanceof CachedHeaderValidationError)) throw error;
    activeState = null;
    if (error.validatedTipHeight < 0) return null;
    return {
      tipHeight: error.validatedTipHeight,
      tipHash: headerHash(await readHeader(filePath, error.validatedTipHeight)),
      chainWork: error.chainWork,
      repairFromHeight: error.invalidRangeStart,
    };
  }
  const state = { ...validated, digest: await digestFile(filePath), validationVersion: HEADER_VALIDATION_VERSION };
  activeState = state;
  return state;
}

async function verifyCachedProofs(address, filePath, tipHeight) {
  const data = await getWalletData(address);
  const invalid = new Set();
  const records = [
    ...(Array.isArray(data.proofs) ? data.proofs : []),
    ...data.bsvUtxos.filter(row => row.spvVerified === true),
    ...data.tokenUtxos.filter(row => row.spvVerified === true),
  ];
  const hashes = new Map();
  for (const record of records) {
    const txid = String(record.txid || '').toLowerCase();
    const height = Number(record.blockHeight ?? record.proofHeight);
    const blockHash = String(record.blockHash ?? record.proofBlockHash ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(height) || height < 0
      || !/^[0-9a-f]{64}$/.test(blockHash)) {
      if (txid) invalid.add(txid);
      continue;
    }
    if (height > tipHeight) {
      invalid.add(txid);
      continue;
    }
    let canonicalHash = hashes.get(height);
    if (!canonicalHash) {
      canonicalHash = headerHash(await readHeader(filePath, height));
      hashes.set(height, canonicalHash);
    }
    if (canonicalHash !== blockHash) invalid.add(txid);
  }
  if (invalid.size) await invalidateWalletProofs(address, [...invalid]);
}

async function syncCanonicalHeaders(address) {
  const filePath = headerCachePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let state = await loadValidatedCache(address, filePath);
  if (state && state.repairFromHeight === undefined) activeState = state;
  const remoteTip = await fetchRemoteTip();

  if (state?.repairFromHeight !== undefined && state.repairFromHeight > remoteTip.height) {
    await truncateHeaderCache(filePath, state.repairFromHeight * HEADER_BYTES);
    const { repairFromHeight, ...validatedPrefix } = state;
    state = { ...validatedPrefix, digest: await digestFile(filePath), validationVersion: HEADER_VALIDATION_VERSION };
  }

  if (state) {
    const compareHeight = Math.min(state.tipHeight, remoteTip.height);
    const remoteHash = compareHeight === remoteTip.height
      ? remoteTip.hash
      : await fetchRemoteBlockHash(compareHeight);
    const localHash = headerHash(await readHeader(filePath, compareHeight));
    if (localHash !== remoteHash) {
      const commonHeight = await findCommonAncestor(filePath, compareHeight);
      const keepHeaders = Math.max(1, Math.floor((commonHeight + 1) / HEADER_RANGE_LIMIT) * HEADER_RANGE_LIMIT);
      await truncateHeaderCache(filePath, keepHeaders * HEADER_BYTES);
      state = await validateFullCache(filePath, keepHeaders);
      state = { ...state, digest: await digestFile(filePath), validationVersion: HEADER_VALIDATION_VERSION };
      activeState = state;
      emitProgress({ phase: 'reorg', completed: state.tipHeight + 1, total: remoteTip.height + 1, height: state.tipHeight });
    } else if (remoteTip.height < state.tipHeight) {
      state = { ...state, remoteTipHeight: remoteTip.height, staleRemoteTip: true };
    }
  }

  let nextHeight = state ? state.tipHeight + 1 : 0;
  let chainWork = BigInt(state?.chainWork || '0');
  while (nextHeight <= remoteTip.height) {
    const batch = [];
    let batchStart = nextHeight;
    for (let index = 0; index < HEADER_REQUEST_CONCURRENCY && batchStart <= remoteTip.height; index++) {
      const endHeight = Math.min(remoteTip.height, batchStart + HEADER_RANGE_LIMIT - 1);
      batch.push({ startHeight: batchStart, endHeight });
      batchStart = endHeight + 1;
    }
    const chunks = await Promise.all(batch.map(async range => ({
      ...range,
      bytes: await fetchHeaderRange(range.startHeight, range.endHeight),
    })));
    for (const range of chunks) {
      const result = await validateHeaderRange(filePath, range.startHeight, range.endHeight, range.bytes);
      await writeHeaderRange(filePath, range.startHeight, range.bytes);
      chainWork += BigInt(result.chainWork);
      nextHeight = range.endHeight + 1;
      emitProgress({
        phase: 'downloading',
        completed: nextHeight,
        total: remoteTip.height + 1,
        height: range.endHeight,
      });
    }
    state = {
      tipHeight: nextHeight - 1,
      tipHash: headerHash(await readHeader(filePath, nextHeight - 1)),
      chainWork: chainWork.toString(),
    };
  }

  if (!state) throw new Error('The local SPV header chain could not be initialized.');
  if (remoteTip.height >= state.tipHeight && remoteTip.height === state.tipHeight && remoteTip.hash !== state.tipHash) {
    throw new Error('BananaBlocks tip does not match the locally validated BSV header chain.');
  }
  const completed = {
    tipHeight: state.tipHeight,
    tipHash: state.tipHash,
    chainWork: state.chainWork,
    remoteTipHeight: remoteTip.height,
    staleRemoteTip: remoteTip.height < state.tipHeight,
    digest: await digestFile(filePath),
    validationVersion: HEADER_VALIDATION_VERSION,
  };
  activeState = completed;
  await verifyCachedProofs(address, filePath, completed.tipHeight);
  await saveWalletHeaderChain(address, completed);
  emitProgress({
    phase: 'complete',
    completed: completed.tipHeight + 1,
    total: completed.tipHeight + 1,
    height: completed.tipHeight,
  });
  return completed;
}

async function ensureHeaderChain(address) {
  if (!headerSyncPromise) {
    const sync = syncCanonicalHeaders(address);
    headerSyncPromise = sync;
    try {
      const state = await sync;
      return state;
    } finally {
      headerSyncPromise = null;
    }
  }
  const state = await headerSyncPromise;
  await saveWalletHeaderChain(address, state);
  return state;
}

function createChainTracker(state) {
  const filePath = headerCachePath();
  const rootCache = new Map();
  return {
    async currentHeight() {
      return state.tipHeight;
    },
    async isValidRootForHeight(root, height) {
      if (!Number.isSafeInteger(height) || height < 0 || height > state.tipHeight
        || !/^[0-9a-f]{64}$/i.test(String(root || ''))) return false;
      let expectedRoot = rootCache.get(height);
      if (!expectedRoot) {
        expectedRoot = headerMerkleRoot(await readHeader(filePath, height));
        rootCache.set(height, expectedRoot);
      }
      return expectedRoot === String(root).toLowerCase();
    },
  };
}

async function verifyBeefHex(txid, beefHex, chainTracker, expectedHeight = 0, state = null) {
  const id = String(txid || '').toLowerCase();
  const hex = String(beefHex || '').trim();
  if (!/^[0-9a-f]{64}$/.test(id) || !/^(?:[0-9a-f]{2})+$/i.test(hex) || hex.length > MAX_BEEF_HEX_BYTES) {
    throw new Error('The BEEF transaction proof is malformed or too large.');
  }

  let beef;
  try { beef = Beef.fromString(hex, 'hex'); }
  catch (error) { throw new Error(`BananaBlocks returned an invalid BEEF bundle: ${error.message}`); }
  if (!beef.isAtomic(id)) throw new Error('The BEEF bundle is not an atomic proof for the requested transaction.');
  const subject = beef.findTxid(id);
  const bump = beef.findBump(id);
  if (!subject?.rawTx || !bump) throw new Error('The BEEF bundle does not include transaction bytes and a Merkle proof for the requested transaction.');
  const blockHeight = Number(bump.blockHeight);
  if (!Number.isSafeInteger(blockHeight) || blockHeight < 0
    || (expectedHeight > 0 && blockHeight !== expectedHeight)
    || (state && blockHeight > state.tipHeight)) {
    throw new Error('The BEEF proof block height does not match the wallet history or validated header chain.');
  }
  const result = beef.verifyValid();
  if (!result.valid) throw new Error('The BEEF bundle failed structural validation.');
  if (!(await beef.verify(chainTracker))) throw new Error('The BEEF Merkle proof does not match the locally validated BSV header chain.');
  const merkleRoot = result.roots[blockHeight];
  if (!/^[0-9a-f]{64}$/i.test(String(merkleRoot || ''))) {
    throw new Error('The BEEF bundle does not prove the requested transaction at its stated block height.');
  }

  const rawTxHex = Buffer.from(subject.rawTx).toString('hex');
  const parsed = require('bsv');
  const bsv = parsed.default || parsed;
  const transaction = new bsv.Transaction(rawTxHex);
  if (transaction.id.toLowerCase() !== id) throw new Error('The BEEF transaction bytes do not match the requested txid.');
  const header = state ? await readHeader(headerCachePath(), blockHeight) : null;
  const blockHash = header ? headerHash(header) : null;
  if (state && headerMerkleRoot(header) !== String(merkleRoot).toLowerCase()) {
    throw new Error('The BEEF Merkle root does not match its locally validated block header.');
  }
  return {
    txid: id,
    blockHeight,
    blockHash,
    merkleRoot: String(merkleRoot).toLowerCase(),
    rawTxHex,
    beefHex: hex.toLowerCase(),
    verified: true,
    validationVersion: PROOF_VALIDATION_VERSION,
  };
}

async function fetchTransactionProof(address, txid, expectedHeight = 0, state = null) {
  const id = String(txid || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('The transaction id for the BEEF proof is invalid.');
  const chainState = state || await ensureHeaderChain(address);
  const tracker = createChainTracker(chainState);
  const cached = await getWalletTransactionProof(address, id);
  if (cached?.verified === true && cached.validationVersion === PROOF_VALIDATION_VERSION
    && cached.blockHash && cached.blockHeight <= chainState.tipHeight
    && (!expectedHeight || cached.blockHeight === expectedHeight)
    && headerHash(await readHeader(headerCachePath(), cached.blockHeight)) === cached.blockHash) {
    return verifyBeefHex(id, cached.beefHex, tracker, expectedHeight, chainState);
  }

  const response = await fetchBananaBlocks(`${API}/tx/${id}/beef/hex`, 'text/plain');
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not load BEEF for ${id.slice(0, 10)}… (HTTP ${response.status})${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  if (contentLength > MAX_BEEF_HEX_BYTES) throw new Error('BananaBlocks returned an oversized BEEF proof.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BEEF_HEX_BYTES) throw new Error('BananaBlocks returned an oversized BEEF proof.');
  const beefHex = bytes.toString('ascii').trim();
  const proof = await verifyBeefHex(id, beefHex, tracker, expectedHeight, chainState);
  await saveWalletTransactionProof(address, proof);
  return proof;
}

async function ensureAndVerifyTransactionProof(address, txid, expectedHeight = 0, state = null) {
  const chainState = state || await ensureHeaderChain(address);
  return fetchTransactionProof(address, txid, expectedHeight, chainState);
}

function subscribeProgress(listener) {
  return onProgress(listener);
}

module.exports = {
  ensureHeaderChain,
  verifyTransactionProof: ensureAndVerifyTransactionProof,
  onProgress: subscribeProgress,
  reportProgress: emitProgress,
  _test: {
    validateHeaderRange,
    createHeaderValidator,
    addHeaderForRange,
    validateFullCache,
    verifyBeefHex,
    loadValidatedCache,
    headerHash,
    headerMerkleRoot,
    setRequestIntervalMs(value) {
      if (!Number.isFinite(value) || value < 0) throw new Error('The SPV test request interval must be non-negative.');
      requestIntervalMs = value;
      nextRequestAt = 0;
      requestQueue = Promise.resolve();
    },
    resetState() {
      activeState = null;
      headerSyncPromise = null;
      nextRequestAt = 0;
      requestQueue = Promise.resolve();
    },
  },
};
