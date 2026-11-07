const { requestBananaBlocks } = require('./chain.cjs');
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const { ADMIN_DISCOVERY_ADDRESS } = require('./constants.cjs');
const { ensureHeaderChain, verifyTransactionProof } = require('./spv.cjs');
const { getWalletAdminIndexSnapshot, saveWalletAdminIndexSnapshot } = require('./wallet-data.cjs');

const API = 'https://bananablocks.com/api/v1';
const HISTORY_LIMIT = 1000;
const HISTORY_PAGE_LIMIT = 8;
const SYNC_CACHE_MS = 30000;
const BULK_BATCH_SIZE = 20;
const API_MAX_RETRIES = 3;
const TXID_RE = /^[0-9a-f]{64}$/i;
const TOKEN_ID_RE = /^[0-9a-f]{64}_\d+$/i;
const BSV20_MARKER = '6170706c69636174696f6e2f6273762d3230';
const syncs = new Map();
const utf8Decoder = new TextDecoder('utf-8');
const tokenMetadata = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Rate limiting reuses the working queue from electron/chain.cjs: requests are
// serialised, spaced out, and a 429 pushes the whole queue back so the server
// can recover. A rate-limited request surfaces as BANANABLOCKS_RATE_LIMIT so
// the caller can degrade gracefully instead of losing the scan.
async function request(url, { accept = 'application/json', headers = {}, method = 'GET', body = null, timeout = 20000 } = {}) {
  let response;
  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
    const init = { method, headers: { Accept: accept, ...headers }, timeout };
    if (body != null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      response = await requestBananaBlocks(url, attempt, init);
    } catch (error) {
      if (attempt === API_MAX_RETRIES) throw error;
      await sleep(1000 * (2 ** attempt));
      continue;
    }
    if (response.status !== 429 || attempt === API_MAX_RETRIES) break;
    await response.text().catch(() => '');
  }
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`BananaBlocks returned HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
    error.status = response.status;
    if (response.status === 429) error.code = 'BANANABLOCKS_RATE_LIMIT';
    throw error;
  }
  return { text, response };
}

async function fetchJson(url, options = {}) {
  const { text } = await request(url, options);
  try { return JSON.parse(text); } catch { throw new Error('BananaBlocks returned an unreadable response.'); }
}

function unwrap(value) {
  return value?.result || value?.transaction || value;
}

function getTxid(row) {
  const txid = String(row?.tx_hash || row?.txid || row?.hash || '').toLowerCase();
  return TXID_RE.test(txid) ? txid : null;
}

function normalizeCachedSnapshot(snapshot) {
  const confirmed = Array.isArray(snapshot.transactions) ? snapshot.transactions : [];
  const pending = Array.isArray(snapshot.pendingTransactions) ? snapshot.pendingTransactions : [];
  const transactions = [...confirmed, ...pending];
  return {
    address: ADMIN_DISCOVERY_ADDRESS,
    source: snapshot.syncedAt ? 'Encrypted local SPV index' : 'Not synced',
    syncedAt: snapshot.syncedAt,
    lastScannedTxid: snapshot.lastScannedTxid,
    historyCursor: snapshot.historyCursor,
    historyComplete: snapshot.historyComplete === true,
    scannedTransactions: transactions.length,
    lookupFailures: 0,
    transactions,
    errors: [],
    status: {
      phase: snapshot.historyComplete === true ? 'complete' : 'scanning',
      complete: snapshot.historyComplete === true,
      checked: transactions.length,
      total: transactions.length,
      indexed: transactions.length,
      candidates: 0,
      pagesRead: 0,
      remaining: 0,
      rateLimited: false,
    },
  };
}

function historyRefs(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    txid: getTxid(row),
    height: Number(row?.height ?? row?.block_height ?? 0),
  })).filter(ref => ref.txid && Number.isSafeInteger(ref.height) && ref.height > 0);
}

// Converts a BSV decimal amount to satoshis without floating point drift.
function bsvToSats(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (match) {
    const fraction = (match[2] || '').padEnd(8, '0').slice(0, 8);
    return String(Number(match[1]) * 1e8 + Number(fraction));
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return '0';
  return String(Math.round(parsed * 1e8));
}

// BSV-20 token outputs embed their token id and amount in the locking script.
function readTokenPayload(scriptHex) {
  const hex = String(scriptHex || '').toLowerCase();
  if (!hex.includes(BSV20_MARKER)) return null;
  let chunks;
  try { chunks = bsv.Script.fromHex(hex).chunks; } catch { return null; }
  for (const chunk of chunks) {
    if (!chunk?.buf) continue;
    let text;
    try { text = utf8Decoder.decode(Buffer.from(chunk.buf)); } catch { continue; }
    if (!text.includes('bsv-20')) continue;
    try {
      const record = JSON.parse(text);
      if (record?.p !== 'bsv-20') continue;
      const tokenId = String(record.id || '');
      if (!TOKEN_ID_RE.test(tokenId)) continue;
      return { tokenId, amount: String(record.amt ?? ''), op: String(record.op || '') };
    } catch {}
  }
  return null;
}

// Turns a bulk-screened transaction into the same shape the rest of the app
// already consumes from a single-transaction lookup.
function buildBulkDetails(tx) {
  const outputs = (Array.isArray(tx?.vout) ? tx.vout : []).map((vout, position) => {
    const scriptHex = String(vout?.scriptPubKey?.hex || '').toLowerCase();
    const address = (Array.isArray(vout?.scriptPubKey?.addresses) ? vout.scriptPubKey.addresses : [])[0] || '';
    const token = readTokenPayload(scriptHex);
    return {
      index: Number.isSafeInteger(Number(vout?.n)) ? Number(vout.n) : position,
      address,
      value: bsvToSats(vout?.value),
      spent: false,
      script_pubkey: scriptHex,
      ...(token ? { parsed: { bsv21: { valid: true, op: token.op, id: token.tokenId, amt: token.amount, sym: '', dec: '' } } } : {}),
    };
  });
  const inputs = (Array.isArray(tx?.vin) ? tx.vin : []).map(vin => ({
    address: (Array.isArray(vin?.voutDetails?.scriptPubKey?.addresses) ? vin.voutDetails.scriptPubKey.addresses : [])[0] || '',
  }));
  const blockHeight = Number(tx?.blockheight || 0);
  return {
    txid: getTxid(tx),
    block_height: blockHeight,
    block_time: Number(tx?.blocktime || 0),
    confirmed: blockHeight > 0,
    inputs,
    outputs,
  };
}

// Screens many transactions with a single request instead of one request each.
async function fetchBulkTransactions(txids) {
  const results = new Map();
  const failures = [];
  for (let offset = 0; offset < txids.length; offset += BULK_BATCH_SIZE) {
    const batch = txids.slice(offset, offset + BULK_BATCH_SIZE);
    let body;
    try {
      body = await fetchJson(`${API}/bsv/main/txs`, { method: 'POST', body: { txids: batch } });
    } catch (error) {
      error.bulkTxids = batch;
      throw error;
    }
    const rows = Array.isArray(body) ? body : body?.result || body?.items || [];
    for (const row of rows) {
      const txid = getTxid(row);
      if (!txid) continue;
      if (row?.error) { failures.push({ txid, reason: String(row.error) }); continue; }
      results.set(txid, row);
    }
    for (const txid of batch) {
      if (!results.has(txid) && !failures.some(row => row.txid === txid)) {
        failures.push({ txid, reason: 'missing' });
      }
    }
  }
  return { transactions: results, failures };
}

// Symbol and decimals are not part of a token output, so they are looked up
// once per distinct token and then reused.
async function resolveTokenMetadata(tokenIds) {
  const missing = [...new Set(tokenIds)].filter(id => id && !tokenMetadata.has(id));
  for (const tokenId of missing) {
    try {
      const body = unwrap(await fetchJson(`${API}/token/${encodeURIComponent(tokenId)}`));
      tokenMetadata.set(tokenId, {
        symbol: String(body?.symbol || ''),
        decimals: Number.isFinite(Number(body?.decimals)) ? Number(body.decimals) : 0,
      });
    } catch {
      tokenMetadata.set(tokenId, { symbol: '', decimals: 0 });
    }
  }
  return tokenMetadata;
}

async function getAdminWalletIndex(walletAddress) {
  return normalizeCachedSnapshot(await getWalletAdminIndexSnapshot(walletAddress));
}

async function fetchHistory(cursor = null) {
  const query = new URLSearchParams({ limit: String(HISTORY_LIMIT) });
  if (cursor) query.set('cursor', cursor);
  const { text, response } = await request(
    `${API}/bsv/main/address/${encodeURIComponent(ADMIN_DISCOVERY_ADDRESS)}/history?${query}`,
  );
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('BananaBlocks admin-wallet history was unreadable.'); }
  const rows = Array.isArray(body) ? body : body?.result || body?.items || body?.transactions;
  if (!Array.isArray(rows)) throw new Error('BananaBlocks returned an unexpected admin-wallet history response.');
  const hasMoreHeader = response.headers.get('x-has-more');
  const nextCursor = response.headers.get('x-next-cursor') || null;
  const hasMore = hasMoreHeader == null
    ? Boolean(nextCursor) || rows.length >= HISTORY_LIMIT
    : hasMoreHeader.toLowerCase() === 'true';
  if (hasMore && !nextCursor) throw new Error('BananaBlocks reports more admin-wallet history but supplied no continuation cursor.');
  return { rows, nextCursor, hasMore };
}

async function fetchUnconfirmedHistory() {
  const { text } = await request(
    `${API}/bsv/main/address/${encodeURIComponent(ADMIN_DISCOVERY_ADDRESS)}/unconfirmed/history`,
  );
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('BananaBlocks pending admin-wallet history was unreadable.'); }
  const rows = Array.isArray(body) ? body : body?.result || body?.items || body?.transactions;
  if (!Array.isArray(rows)) throw new Error('BananaBlocks returned an unexpected pending admin-wallet history response.');
  return rows.map(row => getTxid(row)).filter(Boolean);
}

async function loadIndexedTransaction(ref, walletAddress, { details = null, headerState = null } = {}) {
  const loaded = details || unwrap(await fetchJson(`${API}/tx/${encodeURIComponent(ref.txid)}`));
  const detailsTxid = getTxid(loaded);
  if (detailsTxid && detailsTxid !== ref.txid) throw new Error('BananaBlocks returned details for a different transaction.');
  let rawTxHex = null;
  if (hasRelevantProtocolPayload(loaded)) {
    const state = headerState || await ensureHeaderChain(walletAddress);
    const proof = await verifyTransactionProof(walletAddress, ref.txid, ref.height, state);
    if (proof.blockHeight !== ref.height) throw new Error('The BEEF proof height does not match admin-wallet history.');
    rawTxHex = proof.rawTxHex;
  }
  const blockTime = Number(loaded.block_time || 0);
  return {
    txid: ref.txid,
    blockHeight: ref.height,
    blockTime: Number.isSafeInteger(blockTime) && blockTime > 0 ? blockTime : 0,
    confirmed: true,
    rawTxHex,
    details: { ...loaded, block_height: ref.height, confirmed: true },
  };
}

async function loadPendingTransaction(txid) {
  const details = unwrap(await fetchJson(`${API}/tx/${encodeURIComponent(txid)}`));
  const detailsTxid = getTxid(details);
  if (detailsTxid && detailsTxid !== txid) throw new Error('BananaBlocks returned details for a different transaction.');
  let rawTxHex = null;
  if (hasRelevantProtocolPayload(details)) {
    const { text } = await request(`${API}/tx/${encodeURIComponent(txid)}/hex`, { accept: 'text/plain' });
    rawTxHex = text.trim().toLowerCase();
    let transaction;
    try { transaction = new bsv.Transaction(rawTxHex); }
    catch { throw new Error('BananaBlocks returned invalid pending transaction bytes.'); }
    if (transaction.id.toLowerCase() !== txid) throw new Error('BananaBlocks returned bytes for a different pending transaction.');
  }
  return {
    txid,
    blockHeight: 0,
    blockTime: 0,
    confirmed: false,
    rawTxHex,
    details: { ...details, block_height: 0, block_time: 0, confirmed: false },
  };
}

function hasRelevantProtocolPayload(details) {
  for (const output of Array.isArray(details?.outputs) ? details.outputs : []) {
    const scriptHex = String(output?.script_pubkey || output?.scriptPubKey || '').toLowerCase();
    if (!/^(?:[0-9a-f]{2})+$/i.test(scriptHex)) continue;
    try {
      for (const chunk of bsv.Script.fromHex(scriptHex).chunks) {
        const text = chunk.buf?.toString('utf8');
        if (!text) continue;
        if (text.includes('peer_chat')) return true;
        try {
          const record = JSON.parse(text);
          if (record?.p === 'lbsx' && record?.op === 'sell') return true;
        } catch {}
      }
    } catch {}
  }
  return false;
}

// Finds the transactions that carry a peer chat message or a sell order.
function classifyProtocolOutputs(details) {
  let peerChat = false;
  let sellOrder = false;
  for (const output of Array.isArray(details?.outputs) ? details.outputs : []) {
    const scriptHex = String(output?.script_pubkey || '').toLowerCase();
    if (!/^(?:[0-9a-f]{2})+$/i.test(scriptHex)) continue;
    try {
      for (const chunk of bsv.Script.fromHex(scriptHex).chunks) {
        const text = chunk.buf?.toString('utf8');
        if (!text) continue;
        if (text.includes('peer_chat')) peerChat = true;
        try {
          const record = JSON.parse(text);
          if (record?.p === 'lbsx' && record?.op === 'sell') sellOrder = true;
        } catch {}
      }
    } catch {}
  }
  return { peerChat, sellOrder };
}

async function fetchAddressSummary() {
  try {
    const body = unwrap(await fetchJson(`${API}/address/${encodeURIComponent(ADMIN_DISCOVERY_ADDRESS)}`));
    const txCount = Number(body?.tx_count);
    return {
      totalTransactions: Number.isSafeInteger(txCount) && txCount > 0 ? txCount : 0,
      balanceSats: Number(body?.balance ?? 0) || 0,
    };
  } catch {
    return { totalTransactions: 0, balanceSats: 0 };
  }
}

async function syncAdminWalletIndexOnce(walletAddress, { onProgress = null } = {}) {
  const prior = await getWalletAdminIndexSnapshot(walletAddress);
  if (prior.syncedAt && Date.now() - Date.parse(prior.syncedAt) < SYNC_CACHE_MS) {
    return normalizeCachedSnapshot(prior);
  }

  const errors = [];
  const known = new Set(prior.transactions.map(row => row.txid));
  const report = (progress) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(progress); } catch { /* progress reporting must never fail a sync */ }
  };

  report({ phase: 'history', checked: 0, total: 0, indexed: 0 });

  // Phase 1 - the newest region of history, up to the saved marker.
  const latestPage = await fetchHistory();
  const latestRefs = historyRefs(latestPage.rows);
  const latestTxid = latestRefs[0]?.txid || prior.lastScannedTxid;
  let foundMarker = !prior.lastScannedTxid;
  const phase1Refs = [];
  for (const ref of latestRefs) {
    if (prior.lastScannedTxid && ref.txid === prior.lastScannedTxid) {
      foundMarker = true;
      break;
    }
    if (!known.has(ref.txid)) phase1Refs.push(ref);
  }

  // Phase 2 - walk forward through the older history from the saved cursor.
  const batches = [];
  batches.push({
    refs: phase1Refs,
    cursorAfter: prior.historyComplete
      ? null
      : (prior.historyCursor || (latestPage.hasMore ? latestPage.nextCursor : null)),
  });
  let pagesRead = 1;
  if (!prior.historyComplete) {
    let cursor = prior.historyCursor || (latestPage.hasMore ? latestPage.nextCursor : null);
    while (cursor && pagesRead < HISTORY_PAGE_LIMIT) {
      const page = await fetchHistory(cursor);
      pagesRead++;
      const refs = historyRefs(page.rows).filter(ref =>
        !known.has(ref.txid) && !(prior.lastScannedTxid && ref.txid === prior.lastScannedTxid));
      batches.push({ refs, cursorAfter: page.hasMore ? page.nextCursor : null });
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
  }
  if (!foundMarker && prior.lastScannedTxid) {
    errors.push('The saved admin-wallet marker was not found in the newest history page, so it was preserved to avoid skipping records.');
  }

  // Screen every candidate transaction with bulk requests instead of one
  // request per transaction, which is what used to trip the rate limit.
  const summary = await fetchAddressSummary();
  const totalTransactions = summary.totalTransactions;
  const refByTxid = new Map();
  for (const batch of batches) for (const ref of batch.refs) refByTxid.set(ref.txid, ref);

  const screened = new Map();
  let checked = 0;
  let rateLimited = false;
  let processedBatches = 0;
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    let batchFailed = false;
    for (let offset = 0; offset < batch.refs.length; offset += BULK_BATCH_SIZE) {
      const chunk = batch.refs.slice(offset, offset + BULK_BATCH_SIZE);
      try {
        const result = await fetchBulkTransactions(chunk.map(ref => ref.txid));
        for (const [txid, row] of result.transactions) screened.set(txid, buildBulkDetails(row));
        for (const failure of result.failures) {
          // A single oversized or unknown transaction is looked up on its own.
          try {
            const ref = refByTxid.get(failure.txid);
            const loaded = await loadIndexedTransaction(ref, walletAddress);
            screened.set(failure.txid, { ...loaded.details, outputs: loaded.details.outputs || [] });
          } catch (error) {
            errors.push(`Admin transaction ${failure.txid.slice(0, 10)} could not be indexed: ${error.message}`);
          }
        }
      } catch (error) {
        batchFailed = true;
        rateLimited = error?.code === 'BANANABLOCKS_RATE_LIMIT';
        errors.push(rateLimited
          ? 'BananaBlocks is rate limiting requests. The remaining admin-wallet history has been saved for a later sync.'
          : `Admin-wallet screening stopped early: ${error.message}`);
        break;
      }
      checked += chunk.length;
      report({
        phase: 'screening',
        checked: prior.transactions.length + checked,
        total: totalTransactions || (prior.transactions.length + checked),
        indexed: prior.transactions.length + screened.size,
      });
    }
    if (batchFailed) break;
    processedBatches = index + 1;
  }

  // Token symbol and decimals are not part of the transaction, so they are
  // resolved once per distinct token.
  const tokenIds = new Set();
  for (const details of screened.values()) {
    for (const output of details.outputs || []) {
      const id = output?.parsed?.bsv21?.id;
      if (id) tokenIds.add(id);
    }
  }
  if (tokenIds.size) await resolveTokenMetadata([...tokenIds]);
  for (const details of screened.values()) {
    for (const output of details.outputs || []) {
      const parsed = output?.parsed?.bsv21;
      if (!parsed) continue;
      const meta = tokenMetadata.get(parsed.id);
      if (meta) {
        parsed.sym = meta.symbol;
        parsed.dec = String(meta.decimals);
      }
    }
  }

  // Only transactions that carry a protocol payload need a verified proof or
  // a full single-transaction lookup.
  const candidates = [];
  for (const [txid, details] of screened) {
    const kinds = classifyProtocolOutputs(details);
    if (!kinds.peerChat && !kinds.sellOrder) continue;
    candidates.push({ ref: refByTxid.get(txid), details, ...kinds });
  }
  report({
    phase: 'verifying',
    checked: prior.transactions.length + checked,
    total: totalTransactions || (prior.transactions.length + checked),
    indexed: prior.transactions.length + screened.size,
    candidates: candidates.length,
  });

  let lookupFailures = 0;
  let headerState = null;
  let verified = 0;
  const transactions = [];
  for (const candidate of candidates) {
    try {
      let details = candidate.details;
      if (candidate.sellOrder) {
        // A sell order is settled against a locked output, so it needs the
        // full transaction to know whether that output is still unspent.
        const native = unwrap(await fetchJson(`${API}/tx/${encodeURIComponent(candidate.ref.txid)}`));
        if (native) details = { ...native, block_height: candidate.ref.height, confirmed: true };
      }
      if (!headerState) headerState = await ensureHeaderChain(walletAddress);
      const loaded = await loadIndexedTransaction(candidate.ref, walletAddress, { details, headerState });
      transactions.push(loaded);
    } catch (error) {
      lookupFailures++;
      errors.push(`Admin transaction ${candidate.ref.txid.slice(0, 10)} could not be verified: ${error.message}`);
    }
    verified++;
    if (verified % 5 === 0 || verified === candidates.length) {
      report({
        phase: 'verifying',
        checked: prior.transactions.length + checked,
        total: totalTransactions || (prior.transactions.length + checked),
        indexed: prior.transactions.length + screened.size,
        candidates: candidates.length,
        verified,
      });
    }
  }
  const candidateIds = new Set(candidates.map(candidate => candidate.ref.txid));
  for (const [txid, details] of screened) {
    if (candidateIds.has(txid)) continue;
    const ref = refByTxid.get(txid);
    if (!ref) continue;
    transactions.push({
      txid,
      blockHeight: ref.height,
      blockTime: Number(details.block_time || 0),
      confirmed: true,
      rawTxHex: null,
      details: { ...details, block_height: ref.height, confirmed: true },
    });
  }

  let pendingHistoryFailed = false;
  let pendingIds = [];
  try {
    pendingIds = [...new Set(await fetchUnconfirmedHistory())].filter(txid => !known.has(txid));
  } catch (error) {
    pendingHistoryFailed = true;
    errors.push(`Pending admin-wallet history could not be refreshed: ${error.message}`);
  }
  const confirmedIds = new Set([...prior.transactions, ...transactions].map(row => row.txid));
  const priorPendingByTxid = new Map((prior.pendingTransactions || []).map(row => [row.txid, row]));
  const pendingTransactions = [];
  let pendingLookupFailures = 0;
  if (pendingHistoryFailed) {
    pendingTransactions.push(...(prior.pendingTransactions || []));
  } else {
    for (const txid of pendingIds) {
      if (confirmedIds.has(txid)) continue;
      const cached = priorPendingByTxid.get(txid);
      if (cached) { pendingTransactions.push(cached); continue; }
      try { pendingTransactions.push(await loadPendingTransaction(txid)); }
      catch (error) {
        pendingLookupFailures++;
        errors.push(`Pending admin transaction ${txid.slice(0, 10)} could not be indexed: ${error.message}`);
      }
    }
  }

  // The saved cursor points at the first history page that is still unscanned.
  const lastBatch = batches[Math.max(0, processedBatches - 1)];
  const historyCursor = processedBatches === 0
    ? prior.historyCursor
    : (lastBatch.cursorAfter || null);
  const historyComplete = processedBatches === batches.length && !lastBatch?.cursorAfter;
  const syncedAt = new Date().toISOString();
  const lastScannedTxid = lookupFailures === 0 && foundMarker && !rateLimited
    ? latestTxid
    : prior.lastScannedTxid;
  const saved = await saveWalletAdminIndexSnapshot(walletAddress, {
    transactions,
    pendingTransactions,
    lastScannedTxid,
    syncedAt: lookupFailures === 0 && pendingLookupFailures === 0 && !pendingHistoryFailed ? syncedAt : prior.syncedAt,
    historyCursor,
    historyComplete,
  });
  const status = {
    phase: rateLimited ? 'paused' : (historyComplete ? 'complete' : 'scanning'),
    complete: historyComplete && !rateLimited,
    checked: prior.transactions.length + checked,
    total: totalTransactions || (prior.transactions.length + checked),
    indexed: prior.transactions.length + transactions.length,
    candidates: candidates.length,
    pagesRead,
    remaining: Math.max(0, (totalTransactions || 0) - (prior.transactions.length + checked)),
    rateLimited,
  };
  report({ phase: status.phase, checked: status.checked, total: status.total, indexed: status.indexed });
  return {
    ...normalizeCachedSnapshot(saved),
    source: 'BananaBlocks history with locally verified confirmed proofs and cached pending records',
    scannedTransactions: prior.transactions.length + checked + pendingIds.length,
    lookupFailures: lookupFailures + pendingLookupFailures,
    status,
    errors,
  };
}

async function syncAdminWalletIndex(walletAddress, options = {}) {
  const existing = syncs.get(walletAddress);
  if (existing) return existing;
  const sync = syncAdminWalletIndexOnce(walletAddress, options);
  syncs.set(walletAddress, sync);
  try { return await sync; }
  finally { if (syncs.get(walletAddress) === sync) syncs.delete(walletAddress); }
}

module.exports = {
  getAdminWalletIndex,
  syncAdminWalletIndex,
  _test: { getTxid, normalizeCachedSnapshot, bsvToSats, buildBulkDetails, classifyProtocolOutputs },
};
