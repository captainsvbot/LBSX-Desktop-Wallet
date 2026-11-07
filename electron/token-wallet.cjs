const fs = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const { bananaBlocksFetch, waitForRateLimitBudget } = require('./bananablocks.cjs');
const {
  cacheVerifiedBsvUtxos,
  cacheVerifiedTokenUtxos,
  getWalletTokenLocks,
  saveWalletTokenLocks,
  getSpendableBsvUtxos,
  getSpendableTokenUtxos,
  getSpendableUtxoBlocklist,
  getTrackedTransactionHex,
  recordMintedToken,
  saveWalletPeerChatSnapshot,
} = require('./wallet-data.cjs');
const { broadcastTrackedTransaction, reconcileDefinitivelyRejectedTransactions } = require('./transaction-tracker.cjs');
const { ADMIN_DISCOVERY_ADDRESS } = require('./constants.cjs');
const BSV_SEND_SERVICE_FEE_SATS = 10000;
const TOKEN_MINT_SERVICE_FEE_SATS = 50000000;
const { ensureHeaderChain, verifyTransactionProof } = require('./spv.cjs');
const { fetchAllUnspentUtxos } = require('./bsv-unspent.cjs');
const { encryptPeerChatContent } = require('./peer-chat-crypto.cjs');

const API = 'https://bananablocks.com/api/v1';
const SCHEDULE_SECONDS = { daily: 86400, weekly: 604800, monthly: 2592000, yearly: 31536000 };
const TXID_RE = /^[0-9a-f]{64}$/i;
const API_MAX_RETRIES = 5;
const MAX_BSV21_AMOUNT = (1n << 64n) - 1n;

async function getLocks(address) {
  const encrypted = await getWalletTokenLocks(address);
  try {
    const legacyPath = path.join(app.getPath('userData'), 'token-locks.json');
    const rows = JSON.parse(await fs.readFile(legacyPath, 'utf8'));
    if (!Array.isArray(rows)) throw new Error('The previous local token locker file has an unsupported format.');
    if (rows.some(row => row.ownerAddress !== address)) throw new Error('The previous token locker file contains records for another wallet; unlock that wallet before migrating its records.');
    const merged = [...encrypted];
    for (const row of rows) if (!merged.some(item => item.id === row.id)) merged.push(row);
    await saveWalletTokenLocks(address, merged);
    await fs.unlink(legacyPath);
    return merged;
  } catch (error) {
    if (error.code === 'ENOENT') return encrypted;
    throw error;
  }
}

async function saveLocks(address, rows) {
  await saveWalletTokenLocks(address, rows);
}

async function json(url, options = {}) {
  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
    await waitForRateLimitBudget();
    const response = await bananaBlocksFetch(url, { headers: { Accept: 'application/json', ...options.headers }, signal: AbortSignal.timeout(20000), ...options });
    if (response.status === 429 && attempt < API_MAX_RETRIES) {
      await response.text().catch(() => '');
      continue;
    }
    const bodyText = await response.text();
    if (!response.ok) throw new Error(`BananaBlocks returned HTTP ${response.status}${bodyText ? `: ${bodyText.slice(0, 160)}` : ''}`);
    try { return JSON.parse(bodyText); } catch { throw new Error('BananaBlocks returned an unreadable response.'); }
  }
  throw new Error('BananaBlocks returned HTTP 429: rate limit exceeded');
}

function push(data) {
  if (!data.length) return Buffer.from([0]);
  if (data.length <= 75) return Buffer.concat([Buffer.from([data.length]), Buffer.from(data)]);
  if (data.length <= 255) return Buffer.concat([Buffer.from([0x4c, data.length]), Buffer.from(data)]);
  if (data.length <= 65535) return Buffer.concat([Buffer.from([0x4d, data.length & 255, data.length >> 8]), Buffer.from(data)]);
  throw new Error('Script field exceeds the supported size.');
}

function pushData(data) {
  const value = Buffer.from(data);
  if (value.length <= 65535) return push(value);
  if (value.length > 0xffffffff) throw new Error('The image is too large to store on-chain.');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(value.length);
  return Buffer.concat([Buffer.from([0x4e]), length, value]);
}

function bsv21DeployScript(address, symbol, amountBase, decimals, iconOutpoint) {
  const metadata = {
    p: 'bsv-20',
    op: 'deploy+mint',
    amt: String(amountBase),
    sym: symbol,
    ...(decimals > 0 ? { dec: String(decimals) } : {}),
    icon: iconOutpoint,
  };
  const inscription = Buffer.concat([
    Buffer.from([0x00, 0x63]),
    push(Buffer.from('ord', 'utf8')),
    Buffer.from([0x51]),
    push(Buffer.from('application/bsv-20', 'utf8')),
    Buffer.from([0x00]),
    push(Buffer.from(JSON.stringify(metadata), 'utf8')),
    Buffer.from([0x68]),
    bsv.Script.buildPublicKeyHashOut(address).toBuffer(),
  ]);
  return bsv.Script.fromBuffer(inscription);
}

function parseMintImage(dataUrl, filename) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(String(dataUrl || ''));
  if (!match || match[2].length % 4 !== 0) throw new Error('Choose a valid PNG, JPEG, or WebP token image.');
  const mimeType = match[1].toLowerCase();
  const imageBytes = Buffer.from(match[2], 'base64');
  if (!imageBytes.length || imageBytes.length > 512 * 1024
    || imageBytes.toString('base64') !== match[2]) {
    throw new Error('The token image must be valid base64 and no larger than 512 KB.');
  }
  const signatureIsValid = mimeType === 'image/png'
    ? imageBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mimeType === 'image/jpeg'
      ? imageBytes[0] === 0xff && imageBytes[1] === 0xd8 && imageBytes[2] === 0xff
      : imageBytes.length >= 12 && imageBytes.toString('ascii', 0, 4) === 'RIFF' && imageBytes.toString('ascii', 8, 12) === 'WEBP';
  if (!signatureIsValid) throw new Error('The selected file does not match its image type.');
  const safeFilename = String(filename || 'token-icon').replace(/[^\w.-]/g, '_').slice(0, 80) || 'token-icon';
  return { imageBytes, mimeType, filename: safeFilename };
}

function encodeScriptNum(number) {
  let value = number;
  const bytes = [];
  while (value > 0) { bytes.push(value & 255); value = Math.floor(value / 256); }
  if (!bytes.length) return Buffer.from([0]);
  if (bytes.at(-1) & 0x80) bytes.push(0);
  return Buffer.from(bytes);
}

function p2pkh(address) {
  const hash = bsv.Address.fromString(address).hashBuffer;
  return Buffer.concat([Buffer.from([0x76, 0xa9]), push(hash), Buffer.from([0x88, 0xac])]);
}

function ordinalImageScript(imageBytes, mimeType, address) {
  return bsv.Script.fromBuffer(Buffer.concat([
    Buffer.from([0x00, 0x63]),
    push(Buffer.from('ord', 'utf8')),
    Buffer.from([0x51]),
    push(Buffer.from(mimeType, 'utf8')),
    Buffer.from([0x00]),
    pushData(imageBytes),
    Buffer.from([0x68]),
    p2pkh(address),
  ]));
}

function addressMatches(candidate, address) {
  const value = String(candidate || '').trim();
  const prefix = address.slice(0, 16);
  return value === address || (prefix && value.startsWith(prefix));
}

function transferScript(address, tokenOutpoint, amountBase, unlockAt = null) {
  const envelope = Buffer.concat([
    Buffer.from([0x00, 0x63]), push(Buffer.from('ord')), Buffer.from([0x51]),
    push(Buffer.from('application/bsv-20')), Buffer.from([0x00]),
    push(Buffer.from(JSON.stringify({ p: 'bsv-20', op: 'transfer', id: tokenOutpoint, amt: String(amountBase) }))),
    Buffer.from([0x68]),
  ]);
  const cltv = unlockAt == null ? Buffer.alloc(0) : Buffer.concat([push(encodeScriptNum(unlockAt)), Buffer.from([0xb1, 0x75])]);
  return bsv.Script.fromBuffer(Buffer.concat([envelope, cltv, p2pkh(address)]));
}

function toBaseUnits(displayAmount, decimals) {
  const text = String(displayAmount ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) || /[eE]/.test(text)) throw new Error('Enter a positive decimal amount without exponent notation.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error(`This token supports at most ${decimals} decimal places.`);
  const base = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction.padEnd(decimals, '0') || '0'));
  if (base <= 0n) throw new Error('Amount must be greater than zero.');
  return base;
}

function fromBaseUnits(base, decimals) {
  const v = BigInt(base);
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const fraction = decimals ? (v % scale).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function readInscription(scriptHex) {
  const chunks = bsv.Script.fromHex(scriptHex).chunks;
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i].buf?.toString('utf8');
    if (!text || !text.startsWith('{')) continue;
    try {
      const data = JSON.parse(text);
      const amount = String(data.amt ?? data.amount ?? '');
      if (['bsv-20', 'bsv-21'].includes(String(data.p || '').toLowerCase())
        && ['transfer', 'mint', 'deploy+mint'].includes(String(data.op || '').toLowerCase())
        && /^\d+$/.test(amount)) return { ...data, amt: amount };
    } catch {}
  }
  return null;
}

function inscriptionTokenId(inscription, txid, vout) {
  if (String(inscription?.op || '').toLowerCase() === 'deploy+mint') {
    return `${String(txid).toLowerCase()}_${Number(vout)}`;
  }
  const id = String(inscription?.id ?? inscription?.token_id ?? inscription?.tokenId ?? '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(id)) return `${id}_1`;
  return /^[0-9a-f]{64}_[0-9]+$/.test(id) ? id : '';
}

function readOrdinalImageData(scriptHex) {
  const chunks = bsv.Script.fromHex(scriptHex).chunks;
  for (let index = 0; index < chunks.length; index++) {
    if (chunks[index].buf?.toString('utf8') !== 'ord'
      || chunks[index + 1]?.opcodenum !== 0x51
      || chunks[index + 3]?.opcodenum !== 0) continue;
    const mimeType = chunks[index + 2]?.buf?.toString('utf8') || '';
    const imageBytes = chunks[index + 4]?.buf;
    if (!imageBytes || imageBytes.length > 512 * 1024
      || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) return null;
    const dataUrl = `data:${mimeType};base64,${imageBytes.toString('base64')}`;
    try { parseMintImage(dataUrl, 'token-icon'); return dataUrl; }
    catch { return null; }
  }
  return null;
}

async function getTokenIconData(address, token = {}) {
  const tokenId = normalizeTokenOutpoint(token.tokenId);
  const icon = String(token.icon || '').trim();
  const iconOutpoint = /^_[0-9]+$/.test(icon)
    ? `${tokenId.split('_')[0]}${icon}`
    : /^[0-9a-f]{64}_[0-9]+$/i.test(icon) ? icon.toLowerCase() : '';
  if (!iconOutpoint) return null;
  const [txid, voutText] = iconOutpoint.split('_');
  const vout = Number(voutText);
  if (!TXID_RE.test(txid) || !Number.isSafeInteger(vout)) return null;
  let rawTxHex = await getTrackedTransactionHex(address, txid);
  if (!rawTxHex) {
    const response = await bananaBlocksFetch(`${API}/bsv/main/tx/${txid}/hex`, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Could not load the token image transaction (${response.status}).`);
    rawTxHex = (await response.text()).trim();
  }
  if (!/^(?:[0-9a-f]{2})+$/i.test(rawTxHex) || rawTxHex.length > 8 * 1024 * 1024) {
    throw new Error('The token image transaction has invalid or oversized data.');
  }
  const transaction = new bsv.Transaction(rawTxHex);
  const output = transaction.outputs[vout];
  return output ? readOrdinalImageData(output.script.toHex()) : null;
}

async function broadcastRawHex(rawtx, expected) {
  rawtx = String(rawtx || '').trim();
  expected = String(expected || '').toLowerCase();
  if (!/^(?:[0-9a-f]{2})+$/i.test(rawtx) || !TXID_RE.test(expected)) throw new Error('The locally built transaction is malformed.');
  let last = '';
  for (const route of [
    { url: `${API}/tx/broadcast`, body: { rawtx } },
    { url: `${API}/bsv/main/tx/raw`, body: { txhex: rawtx } },
  ]) {
    try {
      const response = await bananaBlocksFetch(route.url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(route.body), signal: AbortSignal.timeout(20000) });
      const text = await response.text();
      let received = text.trim().replace(/^"|"$/g, '');
      let parsed;
      try { parsed = JSON.parse(text); } catch {}
      const entry = Array.isArray(parsed) ? parsed[0] : parsed;
      const rejectionMessage = [...new Set([
        entry?.error,
        entry?.extraInfo,
        entry?.resultDescription,
        entry?.message,
      ].flatMap(value => {
        if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
        if (value && typeof value === 'object') return [JSON.stringify(value)];
        return [];
      }))].join(' | ') || text;
      const explicitRejection = entry && (entry.txStatus === 'REJECTED'
        || entry.txStatus === 'DOUBLE_SPEND_ATTEMPTED'
        || entry.status === 'REJECTED');
      const validationRejection = response.status === 400
        && /invalid outputs|transaction is invalid|transaction rejected by peer|dust/i.test(rejectionMessage);
      if (explicitRejection || validationRejection) {
        const error = new Error(`BananaBlocks rejected the transaction: ${rejectionMessage.slice(0, 180)}`);
        error.code = 'BROADCAST_REJECTED';
        throw error;
      }
      if (!response.ok) { last = `HTTP ${response.status}: ${text.slice(0, 180)}`; if (response.status !== 429 && response.status < 500) break; continue; }
      received = entry?.txid || entry?.txId || entry?.result || received;
      if (typeof received === 'string' && TXID_RE.test(received)) {
        if (received.toLowerCase() !== expected) throw new Error('BananaBlocks returned a txid that does not match the locally built transaction.');
        if (entry?.accepted === false && entry?.error) throw new Error(`BananaBlocks did not accept the transaction: ${entry.error}`);
        return expected;
      }
      last = `Unexpected broadcast response: ${text.slice(0, 180)}`;
    } catch (error) {
      if (error.code === 'BROADCAST_REJECTED') throw error;
      last = error.message;
    }
  }
  // BananaBlocks' ARC can validate scripts with pre-Chronicle rules and reject
  // valid Chronicle-era scripts (e.g. OrdLock v2 purchases use OP_2MUL) with ARC 461.
  if (/ARC 461/i.test(last)) {
    let arcRejection = null;
    try {
      const relayed = await broadcastViaGorillaPoolArc(rawtx, expected);
      if (relayed) return relayed;
    } catch (error) {
      if (error?.code !== 'BROADCAST_REJECTED') throw error;
      arcRejection = error;
    }
    const relayed = await broadcastViaWhatsOnChain(rawtx, expected);
    if (relayed) return relayed;
    if (arcRejection) throw arcRejection;
  }
  throw new Error(`BananaBlocks did not confirm broadcast acceptance. Check the transaction before retrying. ${last}`);
}

async function broadcastViaGorillaPoolArc(rawtx, expected) {
  let response;
  let text;
  try {
    response = await fetch('https://arc.gorillapool.io/v1/tx', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawTx: rawtx }),
      signal: AbortSignal.timeout(20000),
    });
    text = await response.text();
  } catch { return null; }
  let entry;
  try { entry = JSON.parse(text); } catch { return null; }
  const status = String(entry?.txStatus || '');
  const accepted = response.ok
    && ['QUEUED', 'RECEIVED', 'STORED', 'ANNOUNCED_TO_NETWORK', 'REQUESTED_BY_NETWORK', 'SENT_TO_NETWORK', 'ACCEPTED_BY_NETWORK', 'SEEN_ON_NETWORK', 'MINED'].includes(status)
    && String(entry?.txid || '').toLowerCase() === expected;
  if (accepted) return expected;
  if (status === 'REJECTED' || status === 'DOUBLE_SPEND_ATTEMPTED' || (response.status >= 400 && response.status < 500 && entry?.status >= 400)) {
    const detail = [entry?.title, entry?.detail, entry?.extraInfo].filter(value => typeof value === 'string' && value).join(' - ');
    const error = new Error(`The transaction was rejected by the network relay: ${detail.slice(0, 180) || status}`);
    error.code = 'BROADCAST_REJECTED';
    throw error;
  }
  return null;
}

async function broadcastViaWhatsOnChain(rawtx, expected) {
  let response;
  let text;
  try {
    response = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: rawtx }),
      signal: AbortSignal.timeout(30000),
    });
    text = await response.text();
  } catch { return null; }
  const reported = String(text || '').replace(/["\s]/g, '').toLowerCase();
  if (response.ok && reported === expected) return expected;
  if (response.status >= 400 && response.status < 500 && /mandatory-script-verify|script|bad-txns|missing inputs|txn-/i.test(text)) {
    const error = new Error(`The transaction was rejected by the network relay: ${String(text).replace(/\s+/g, ' ').slice(0, 220)}`);
    error.code = 'BROADCAST_REJECTED';
    throw error;
  }
  return null;
}

async function broadcast(tx) {
  return broadcastRawHex(tx.toString(), tx.id.toLowerCase());
}

async function fetchSpendableTokenOutput(address, tokenOutpoint) {
  const local = (await getSpendableTokenUtxos(address, tokenOutpoint))
    .sort((a, b) => BigInt(a.amount) > BigInt(b.amount) ? -1 : BigInt(a.amount) < BigInt(b.amount) ? 1 : 0);
  for (const candidate of local) {
    try {
      const parent = new bsv.Transaction(candidate.rawTxHex);
      const output = parent.outputs[candidate.vout];
      const inscription = output && readInscription(output.script.toHex());
      if (!output || output.satoshis !== candidate.satoshis || !inscription
        || output.script.chunks.some(chunk => chunk.opcodenum === 0xb1)
        || inscriptionTokenId(inscription, candidate.txid, candidate.vout) !== tokenOutpoint
        || BigInt(inscription.amt) !== BigInt(candidate.amount)
        || !output.script.toHex().endsWith(p2pkh(address).toString('hex'))) continue;
      return {
        txid: candidate.txid,
        vout: candidate.vout,
        satoshis: output.satoshis,
        scriptHex: output.script.toHex(),
        amount: BigInt(inscription.amt),
        rawTxHex: candidate.rawTxHex,
      };
    } catch {}
  }
  const historyUrl = `${API}/address/${encodeURIComponent(address)}/token/${encodeURIComponent(tokenOutpoint)}/history?limit=100`;
  const history = await json(historyUrl);
  // BananaBlocks may truncate to_address in /history responses. Match its
  // stable address prefix here; the parent script and token inscription are
  // checked below before the output is ever signed or spent.
  let candidates = (history.transfers || []).filter(item => {
    return addressMatches(item.to_address, address)
      && item.txid && Number.isInteger(Number(item.vout));
  });
  // The token's original deploy+mint UTXO may not appear in transfer history.
  // Mirror LocalBSV's mint-output recovery before concluding that no token UTXO exists.
  if (!candidates.length) {
    const canonicalTxid = tokenOutpoint.split('_')[0];
    try {
      const mintTx = await json(`${API}/tx/${canonicalTxid}`);
      const mintOutput = (mintTx.outputs || []).find(output =>
        Number(output.index ?? output.vout) === 1
        && addressMatches(output.address, address)
        && output.spent === false
        && output.spend_unknown !== true
        && output.parsed?.bsv21?.valid !== false
        && String(output.parsed?.bsv21?.id ?? output.parsed?.bsv21?.token_id ?? tokenOutpoint) === tokenOutpoint,
      );
      if (mintOutput) candidates = [{
        txid: canonicalTxid,
        vout: Number(mintOutput.index ?? mintOutput.vout),
        to_address: address,
        amount: mintOutput.parsed?.bsv21?.amt ?? mintOutput.parsed?.bsv21?.amount,
      }];
    } catch (_) { /* The history route's precise error is reported below if fallback misses. */ }
  }
  candidates = candidates.filter(item => item.amount != null && /^\d+$/.test(String(item.amount)));
  const checked = await Promise.all(candidates.slice(0, 100).map(async item => {
    try {
      const outpoint = `${item.txid}_${item.vout}`;
      const [spend, txo] = await Promise.all([
        json(`${API}/txo/${item.txid}/${item.vout}/spend`),
        json(`${API}/txo/${item.txid}/${item.vout}`),
      ]);
      if (spend?.spent || spend?.spend_unknown === true || spend?.unknown === true
        || txo?.spent || txo?.spend_unknown === true || txo?.unknown === true || txo?.script_type !== 'p2pkh'
        || (txo?.address && !addressMatches(txo.address, address))) return null;
      const amount = BigInt(String(item.amount ?? item.amt ?? txo?.bsv21?.amt ?? '0'));
      if (amount <= 0n) return null;
      const reportedHeight = Number(item.height ?? item.block_height ?? txo?.height ?? txo?.block_height ?? 0);
      return {
        ...item, outpoint, amount,
        blockHeight: Number.isSafeInteger(reportedHeight) && reportedHeight > 0 ? reportedHeight : 0,
      };
    } catch { return null; }
  }));
  const ordered = checked.filter(Boolean).sort((a, b) => a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1);
  if (!ordered.length) throw new Error('No spendable BSV-21 token output was found. Sync tokens and verify the token is not already spent.');
  let sawTimelockedOutput = false;
  let verificationError = null;
  let firstVerifiedOutput = null;
  const verifiedTokenOutputs = [];
  const expectedP2pkh = p2pkh(address).toString('hex');
  let headerState;
  try {
    headerState = await ensureHeaderChain(address);
  } catch (error) {
    throw new Error(`Could not validate the local BSV header chain before spending this token: ${error.message}`);
  }
  for (const candidate of ordered.slice(0, 20)) {
    const [txid, voutText] = candidate.outpoint.split('_');
    const vout = Number(voutText);
    try {
      const proof = await verifyTransactionProof(address, txid, candidate.blockHeight, headerState);
      const txHex = proof.rawTxHex;
      const previous = new bsv.Transaction(txHex);
      const output = previous.outputs[vout];
      if (!output) {
        verificationError = 'The indexed token output is missing from its parent transaction.';
        continue;
      }
      const inscription = readInscription(output.script.toHex());
      if (!inscription || inscriptionTokenId(inscription, txid, vout) !== tokenOutpoint) {
        verificationError = 'An indexed token output did not contain the expected BSV-21 inscription.';
        continue;
      }
      if (output.script.chunks.some(chunk => chunk.opcodenum === 0xb1)) {
        sawTimelockedOutput = true;
        continue;
      }
      if (!output.script.toHex().endsWith(expectedP2pkh)) {
        verificationError = 'An indexed token output is not locked to this wallet address.';
        continue;
      }
      if (BigInt(inscription.amt) < candidate.amount) {
        verificationError = 'The token indexer amount exceeds the inscription amount; refusing to spend.';
        continue;
      }
      const verifiedOutput = {
        txid,
        vout,
        satoshis: output.satoshis,
        scriptHex: output.script.toHex(),
        amount: String(inscription.amt),
        tokenId: tokenOutpoint,
        rawTxHex: txHex,
        spvVerified: true,
        blockHeight: proof.blockHeight,
        blockHash: proof.blockHash,
      };
      verifiedTokenOutputs.push(verifiedOutput);
      if (!firstVerifiedOutput) {
        firstVerifiedOutput = {
          txid, vout, satoshis: output.satoshis, scriptHex: output.script.toHex(),
          amount: BigInt(inscription.amt), rawTxHex: txHex,
        };
      }
    } catch (error) {
      verificationError = error.message || 'Could not verify the indexed token output.';
    }
  }
  if (firstVerifiedOutput) {
    await cacheVerifiedTokenUtxos(address, verifiedTokenOutputs);
    return firstVerifiedOutput;
  }
  if (sawTimelockedOutput && !verificationError) throw new Error('This BSV-21 token output is time-locked and cannot be spent with the regular token send flow.');
  if (verificationError) throw new Error(`Could not verify a spendable BSV-21 token output: ${verificationError}`);
  throw new Error('No spendable BSV-21 token output was found. Sync tokens and verify the token is not already spent.');
}

async function fetchFeeUtxos(address, minimum) {
  return fetchCashInputs(address, minimum);
}

function bsvToSatoshis(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(text)) throw new Error('Enter a positive BSV amount with no more than 8 decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const satoshis = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
  if (satoshis <= 0n || satoshis > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The BSV amount is outside the supported range.');
  return Number(satoshis);
}

// Port the LocalBSV `cashOnly` safeguard: verify the actual parent output is
// plain P2PKH before using it as cash. Indexer labels alone can misclassify a
// token carrier as an ordinary BSV UTXO.
async function fetchCashInputs(address, neededSatoshis) {
  await reconcileDefinitivelyRejectedTransactions(address);
  const expectedScript = bsv.Script.buildPublicKeyHashOut(address).toHex();
  const cached = await getSpendableBsvUtxos(address);
  const blocked = await getSpendableUtxoBlocklist(address);
  const selected = [];
  const selectedOutpoints = new Set();
  let total = 0;
  for (const row of cached.sort((a, b) => b.satoshis - a.satoshis)) {
    const outpoint = `${row.txid}.${row.vout}`;
    if (blocked.has(outpoint) || row.scriptHex !== expectedScript) continue;
    try {
      const parent = new bsv.Transaction(row.rawTxHex);
      const output = parent.outputs[row.vout];
      if (!output || output.satoshis !== row.satoshis || output.script.toHex() !== expectedScript) continue;
      selected.push({ txid: row.txid, vout: row.vout, satoshis: output.satoshis, script: expectedScript });
      selectedOutpoints.add(outpoint);
      total += output.satoshis;
      if (total >= neededSatoshis) return selected;
    } catch {}
  }

  const items = await fetchAllUnspentUtxos(address);
  const verified = await verifyCashUtxoRows(address, items, {
    minimumSatoshis: neededSatoshis,
    selectedOutpoints,
    selected,
    total,
    blocked,
  });
  if (verified.total < neededSatoshis) throw new Error('Not enough confirmed, verified BSV UTXOs to cover this payment and its network fee. Token carriers and unconfirmed external outputs are excluded.');
  return verified.selected;
}

async function verifyCashUtxoRows(address, rows, {
  minimumSatoshis = 0,
  cacheAll = false,
  selectedOutpoints = new Set(),
  selected = [],
  total = 0,
  blocked = null,
  onProgress = null,
} = {}) {
  if (!Array.isArray(rows)) throw new Error('The BSV UTXO response had an unexpected format.');
  const expectedScript = bsv.Script.buildPublicKeyHashOut(address).toHex();
  const unavailable = blocked || await getSpendableUtxoBlocklist(address);
  const candidates = rows
    .filter(row => row?.tx_hash && TXID_RE.test(String(row.tx_hash)) && Number.isInteger(Number(row.tx_pos))
      && Number.isSafeInteger(Number(row.value)) && Number(row.value) > 1 && !row.spent && !row.spent_txid
      && Number(row.height ?? row.block_height ?? 0) > 0)
    .filter(row => {
      const outpoint = `${String(row.tx_hash).toLowerCase()}.${Number(row.tx_pos)}`;
      return !unavailable.has(outpoint) && !selectedOutpoints.has(outpoint);
    })
    .sort((a, b) => Number(b.value) - Number(a.value));
  const headerState = candidates.length ? await ensureHeaderChain(address) : null;
  const parentCache = new Map();
  const verified = [];
  let failures = 0;
  onProgress?.({ completed: 0, total: candidates.length });
  for (let index = 0; index < candidates.length; index++) {
    const row = candidates[index];
    try {
      const txid = String(row.tx_hash).toLowerCase();
      const vout = Number(row.tx_pos);
      let parentPromise = parentCache.get(txid);
      if (!parentPromise) {
        parentPromise = verifyTransactionProof(
          address,
          txid,
          Number(row.height ?? row.block_height ?? 0),
          headerState,
        ).then(proof => ({
          ...proof,
          transaction: new bsv.Transaction(proof.rawTxHex),
        }));
        parentCache.set(txid, parentPromise);
      }
      const [txo, parentData] = await Promise.all([
        json(`${API}/txo/${txid}/${vout}`),
        parentPromise,
      ]);
      const parent = parentData.transaction;
      const output = parent.outputs[vout];
      const indexedHeight = Number(row.height ?? row.block_height ?? 0);
      if (txo?.spent || txo?.spend_unknown === true || txo?.unknown === true
        || txo?.address !== address || txo?.script_type !== 'p2pkh'
        || (Number.isSafeInteger(indexedHeight) && indexedHeight > 0 && indexedHeight !== parentData.blockHeight)
        || !output || output.satoshis !== Number(row.value) || output.script.toHex() !== expectedScript) continue;
      selected.push({ txid, vout, satoshis: output.satoshis, script: expectedScript });
      selectedOutpoints.add(`${txid}.${vout}`);
      total += output.satoshis;
      verified.push({
        txid, vout, satoshis: output.satoshis, scriptHex: expectedScript,
        rawTxHex: parentData.rawTxHex, spvVerified: true,
        blockHeight: parentData.blockHeight, blockHash: parentData.blockHash,
      });
      if (!cacheAll && total >= minimumSatoshis) break;
    } catch (error) {
      failures++;
      if (process.env.LBSX_DEBUG_SEND === '1') console.warn('Skipping unverified cash UTXO', row?.tx_hash, error.message);
    } finally {
      onProgress?.({ completed: index + 1, total: candidates.length });
    }
  }
  await cacheVerifiedBsvUtxos(address, verified);
  return {
    selected,
    total,
    verifiedCount: verified.length,
    failures,
    candidatesCount: candidates.length,
  };
}

async function syncSpendableBsvUtxos(address, rows, onProgress = null) {
  const cached = await getSpendableBsvUtxos(address);
  const selected = [];
  const selectedOutpoints = new Set();
  let total = 0;
  const expectedScript = bsv.Script.buildPublicKeyHashOut(address).toHex();
  const blocked = await getSpendableUtxoBlocklist(address);
  for (const row of cached) {
    const outpoint = `${row.txid}.${row.vout}`;
    if (blocked.has(outpoint) || row.scriptHex !== expectedScript) continue;
    try {
      const parent = new bsv.Transaction(row.rawTxHex);
      const output = parent.outputs[row.vout];
      if (!output || output.satoshis !== row.satoshis || output.script.toHex() !== expectedScript) continue;
      selected.push({ txid: row.txid, vout: row.vout, satoshis: output.satoshis, script: expectedScript });
      selectedOutpoints.add(outpoint);
      total += output.satoshis;
    } catch {}
  }
  return verifyCashUtxoRows(address, rows, {
    cacheAll: true,
    selectedOutpoints,
    selected,
    total,
    blocked,
    onProgress,
  });
}

async function buildBsvSend(privateKey, payload = {}) {
  const address = privateKey.toAddress().toString();
  const recipient = String(payload.recipient || '').trim();
  if (!bsv.Address.isValid(recipient, 'livenet')) throw new Error('Enter a valid BSV mainnet recipient address.');
  const amountSats = bsvToSatoshis(payload.amount);
  const note = String(payload.note || '').trim();
  if (Buffer.byteLength(note, 'utf8') > 200) throw new Error('The public payment note must be 200 bytes or less.');
  const inputs = await fetchCashInputs(address, amountSats + BSV_SEND_SERVICE_FEE_SATS + 1000);
  const tx = new bsv.Transaction().from(inputs).to(recipient, amountSats).to(ADMIN_DISCOVERY_ADDRESS, BSV_SEND_SERVICE_FEE_SATS);
  const timestamp = new Date().toISOString();
  const memo = ['LBSX', 'v2', 'bsv_send', address, recipient, String(amountSats), timestamp, `service_fee:${BSV_SEND_SERVICE_FEE_SATS}sat:wallet_maintenance`];
  if (note) memo.push(`msg:${note}`);
  tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.buildSafeDataOut(memo), satoshis: 0 }));
  tx.change(address).feePerKb(1000).sign(privateKey);
  return { address, recipient, amountSats, inputs, tx };
}

async function estimateBsvSendFee(privateKey, payload = {}) {
  const { amountSats, tx } = await buildBsvSend(privateKey, payload);
  return { feeSats: tx.getFee(), amountSats, serviceFeeSats: BSV_SEND_SERVICE_FEE_SATS, sizeBytes: tx.toString().length / 2 };
}

async function sendBsv(privateKey, payload = {}) {
  const { address, recipient, amountSats, inputs, tx } = await buildBsvSend(privateKey, payload);
  const feeSats = tx.getFee();
  const txid = tx.id.toLowerCase();
  await broadcastTrackedTransaction({
    address,
    txid,
    rawHex: tx.toString(),
    type: 'bsv-send',
    inputOutpoints: inputs.map(input => `${input.txid}.${input.vout}`),
    details: { title: 'BSV sent', amountSats, recipient, feeSats, serviceFeeSats: BSV_SEND_SERVICE_FEE_SATS },
    broadcast: () => broadcastRawHex(tx.toString(), txid),
  });
  return { txid, recipient, amountSats, feeSats, serviceFeeSats: BSV_SEND_SERVICE_FEE_SATS };
}

async function sendPeerChatMessage(privateKey, payload = {}) {
  const address = privateKey.toAddress().toString();
  const content = String(payload.message || '').trim();
  if (!content || content.length > 500 || Buffer.byteLength(content, 'utf8') > 2048) {
    throw new Error('A peer chat message must be between 1 and 500 characters (2,048 UTF-8 bytes).');
  }
  const timestamp = new Date().toISOString();
  const encryptedContent = encryptPeerChatContent(content);
  const inputs = await fetchCashInputs(address, 3500);
  const tx = new bsv.Transaction().from(inputs)
    .to(ADMIN_DISCOVERY_ADDRESS, 1000)
    .addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildSafeDataOut(['LBSX', 'v2', 'peer_chat', address, timestamp, encryptedContent]),
      satoshis: 0,
    }));
  tx.change(address).feePerKb(1000).sign(privateKey);

  const txid = tx.id.toLowerCase();
  const rawHex = tx.toString();
  const feeSats = tx.getFee();
  await broadcastTrackedTransaction({
    address,
    txid,
    rawHex,
    type: 'peer-chat-message',
    inputOutpoints: inputs.map(input => `${input.txid}.${input.vout}`),
    details: { title: 'Peer Chat message', recipient: ADMIN_DISCOVERY_ADDRESS, message: content, feeSats },
    broadcast: () => broadcastRawHex(rawHex, txid),
  });
  await saveWalletPeerChatSnapshot(address, {
    messages: [{ txid, senderAddress: address, content, isEncrypted: true, timestamp, status: 'pending', blockHeight: 0 }],
    syncedAt: new Date().toISOString(),
  });
  return { txid, senderAddress: address, content, isEncrypted: true, timestamp, status: 'pending', feeSats };
}

async function mintBsv21Token(privateKey, payload = {}) {
  const address = privateKey.toAddress().toString();
  const symbol = String(payload.symbol || '').trim();
  if (!/^[A-Za-z0-9]{1,28}$/.test(symbol)) {
    throw new Error('Enter a token ticker of 1 to 28 letters or numbers.');
  }
  const decimals = Number(payload.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Choose between 0 and 18 token decimal places.');
  const amountBase = toBaseUnits(payload.supply, decimals);
  if (amountBase > MAX_BSV21_AMOUNT) throw new Error('The token supply exceeds the supported BSV-21 amount range.');
  const image = parseMintImage(payload.imageDataUrl, payload.imageName);

  const tx = new bsv.Transaction();
  const inputs = await fetchCashInputs(address, image.imageBytes.length + 25000 + TOKEN_MINT_SERVICE_FEE_SATS);
  tx.from(inputs);
  tx.addOutput(new bsv.Transaction.Output({
    script: ordinalImageScript(image.imageBytes, image.mimeType, address),
    satoshis: 1,
  }));
  tx.addOutput(new bsv.Transaction.Output({
    script: bsv21DeployScript(address, symbol, amountBase, decimals, '_0'),
    satoshis: 1,
  }));
  tx.to(ADMIN_DISCOVERY_ADDRESS, TOKEN_MINT_SERVICE_FEE_SATS);
  tx.addOutput(new bsv.Transaction.Output({
    script: bsv.Script.buildSafeDataOut(['LBSX', 'v2', 'mint', address, symbol, String(amountBase), String(decimals), new Date().toISOString(), `service_fee:${TOKEN_MINT_SERVICE_FEE_SATS}sat:wallet_maintenance`]),
    satoshis: 0,
  }));
  tx.change(address).feePerKb(1000).sign(privateKey);

  const txid = tx.id.toLowerCase();
  const tokenId = `${txid}_1`;
  const iconOutpoint = `${txid}_0`;
  const adminIndexOutpoint = `${txid}_2`;
  await broadcastTrackedTransaction({
    address,
    txid,
    rawHex: tx.toString(),
    type: 'token-mint',
    inputOutpoints: inputs.map(input => `${input.txid}.${input.vout}`),
    details: {
      title: `${symbol} BSV-21 token minted`,
      tokenId,
      tokenAmount: String(amountBase),
      decimals,
      symbol,
      icon: iconOutpoint,
      imageMimeType: image.mimeType,
      imageFilename: image.filename,
      adminIndexOutpoint,
      serviceFeeSats: TOKEN_MINT_SERVICE_FEE_SATS,
    },
    broadcast: () => broadcastRawHex(tx.toString(), txid),
  });
  try {
    await recordMintedToken(address, {
      tokenId,
      symbol,
      name: symbol,
      decimals,
      balance: String(amountBase),
      icon: iconOutpoint,
    });
  } catch (error) {
    throw new Error(`The token was broadcast as ${txid}, but its local token snapshot could not be updated: ${error.message}`);
  }
  return {
    txid,
    imageTxid: txid,
    tokenId,
    symbol,
    supply: String(payload.supply),
    amountBase: String(amountBase),
    decimals,
    icon: iconOutpoint,
    adminIndexOutpoint,
    serviceFeeSats: TOKEN_MINT_SERVICE_FEE_SATS,
  };
}

function addInscriptionInput(tx, tokenUtxo, privateKey) {
  const dummyP2pkh = bsv.Script.buildPublicKeyHashOut(privateKey.toAddress());
  tx.from({ txid: tokenUtxo.txid, vout: tokenUtxo.vout, satoshis: tokenUtxo.satoshis, script: dummyP2pkh.toHex() });
}

function signInscriptionInput(tx, tokenUtxo, privateKey) {
  const type = bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID;
  const fullScript = bsv.Script.fromHex(tokenUtxo.scriptHex);
  const hash = bsv.Transaction.Sighash.sighash(tx, type, 0, fullScript, new bsv.crypto.BN(tokenUtxo.satoshis));
  const signature = bsv.crypto.ECDSA.sign(hash, privateKey, 'little');
  signature.nhashtype = type;
  tx.inputs[0].setScript(new bsv.Script().add(signature.toTxFormat()).add(privateKey.toPublicKey().toBuffer()));
}

async function addFeeInputs(tx, address, privateKey, minimum = 2500) {
  const feeUtxos = await fetchFeeUtxos(address, minimum);
  const p2pkhHex = bsv.Script.buildPublicKeyHashOut(privateKey.toAddress()).toHex();
  for (const u of feeUtxos) tx.from({ txid: u.txid, vout: u.vout, satoshis: u.satoshis, script: p2pkhHex });
  tx.change(address).feePerKb(1000).sign(privateKey);
  return feeUtxos;
}

async function sendToken(privateKey, payload = {}) {
  const address = privateKey.toAddress().toString();
  const recipient = String(payload.recipient || '').trim();
  if (!bsv.Address.isValid(recipient, 'livenet')) throw new Error('Enter a valid BSV mainnet recipient address.');
  const decimals = Math.min(18, Math.max(0, Number(payload.decimals) || 0));
  const tokenOutpoint = normalizeTokenOutpoint(payload.tokenId);
  const amountBase = toBaseUnits(payload.amount, decimals);
  const tokenUtxo = await fetchSpendableTokenOutput(address, tokenOutpoint);
  if (amountBase > tokenUtxo.amount) throw new Error('The requested amount is larger than the spendable token output. Sync balances and try again.');
  const change = tokenUtxo.amount - amountBase;
  const tx = new bsv.Transaction();
  addInscriptionInput(tx, tokenUtxo, privateKey);
  tx.addOutput(new bsv.Transaction.Output({ script: transferScript(recipient, tokenOutpoint, amountBase), satoshis: 1 }));
  if (change > 0n) tx.addOutput(new bsv.Transaction.Output({ script: transferScript(address, tokenOutpoint, change), satoshis: 1 }));
  const feeUtxos = await addFeeInputs(tx, address, privateKey, 4000);
  signInscriptionInput(tx, tokenUtxo, privateKey);
  const txid = tx.id.toLowerCase();
  await broadcastTrackedTransaction({
    address,
    txid,
    rawHex: tx.toString(),
    type: 'token-send',
    inputOutpoints: [`${tokenUtxo.txid}.${tokenUtxo.vout}`, ...feeUtxos.map(input => `${input.txid}.${input.vout}`)],
    details: { title: 'BSV-21 token sent', tokenId: tokenOutpoint, tokenAmount: String(amountBase), decimals, symbol: String(payload.symbol || '') },
    broadcast: () => broadcastRawHex(tx.toString(), txid),
  });
  return { txid, amount: String(payload.amount), tokenId: tokenOutpoint, recipient };
}

function normalizeTokenOutpoint(tokenId) {
  const value = String(tokenId || '').trim();
  if (/^[0-9a-f]{64}_[0-9]+$/i.test(value)) return value;
  if (/^[0-9a-f]{64}$/i.test(value)) return `${value}_1`;
  throw new Error('This token is missing a valid BSV-21 token id/outpoint. Sync token balances and retry.');
}

async function getTokenLocks(address, tokenId) {
  const id = normalizeTokenOutpoint(tokenId);
  const rows = await getLocks(address);
  return rows.filter(row => row.tokenId === id).sort((a, b) => a.unlockTimestamp - b.unlockTimestamp);
}

async function migrateLegacyTokenLocks(address) {
  await getLocks(address);
}

async function createTokenLock(privateKey, payload = {}) {
  const address = privateKey.toAddress().toString();
  const tokenOutpoint = normalizeTokenOutpoint(payload.tokenId);
  const decimals = Math.min(18, Math.max(0, Number(payload.decimals) || 0));
  const amountBase = toBaseUnits(payload.amount, decimals);
  const schedule = String(payload.schedule || 'monthly');
  if (!SCHEDULE_SECONDS[schedule]) throw new Error('Choose a supported release schedule.');
  const trancheCount = Number(payload.tranches);
  if (!Number.isInteger(trancheCount) || trancheCount < 1 || trancheCount > 24) throw new Error('Choose between 1 and 24 tranches.');
  if (amountBase < BigInt(trancheCount)) throw new Error('The amount is too small to split across that many tranches.');
  const tokenUtxo = await fetchSpendableTokenOutput(address, tokenOutpoint);
  if (amountBase > tokenUtxo.amount) throw new Error('The requested amount is larger than the spendable token output. Sync balances and try again.');
  const interval = SCHEDULE_SECONDS[schedule];
  const now = Math.floor(Date.now() / 1000);
  const per = amountBase / BigInt(trancheCount);
  const trancheBases = Array(trancheCount).fill(per);
  trancheBases[trancheCount - 1] += amountBase - per * BigInt(trancheCount);
  const plans = trancheBases.map((base, i) => ({ amountBase: String(base), amount: fromBaseUnits(base, decimals), unlockTimestamp: now + interval * (i + 1) }));
  const tokenChange = tokenUtxo.amount - amountBase;
  const tx = new bsv.Transaction();
  addInscriptionInput(tx, tokenUtxo, privateKey);
  for (const plan of plans) tx.addOutput(new bsv.Transaction.Output({ script: transferScript(address, tokenOutpoint, plan.amountBase, plan.unlockTimestamp), satoshis: 1 }));
  if (tokenChange > 0n) tx.addOutput(new bsv.Transaction.Output({ script: transferScript(address, tokenOutpoint, tokenChange), satoshis: 1 }));
  const feeUtxos = await addFeeInputs(tx, address, privateKey, 3000 + trancheCount * 350);
  signInscriptionInput(tx, tokenUtxo, privateKey);

  const txid = tx.id.toLowerCase();
  const existing = await getLocks(address);
  const records = plans.map((plan, i) => ({
    id: `${txid}_${i}`, tokenId: tokenOutpoint, ticker: String(payload.symbol || 'Token'), decimals,
    ownerAddress: address, amount: plan.amount, amountBase: plan.amountBase,
    schedule, trancheIndex: i + 1, totalTranches: trancheCount,
    lockTxid: txid, outpoint: `${txid}_${i}`, unlockTimestamp: plan.unlockTimestamp,
    status: 'broadcasting', createdAt: new Date().toISOString(),
  }));
  await saveLocks(address, [...existing, ...records]);
  try {
    await broadcastTrackedTransaction({
      address,
      txid,
      rawHex: tx.toString(),
      type: 'token-lock',
      inputOutpoints: [`${tokenUtxo.txid}.${tokenUtxo.vout}`, ...feeUtxos.map(input => `${input.txid}.${input.vout}`)],
      details: { title: 'BSV-21 tokens locked', tokenId: tokenOutpoint, tokenAmount: String(amountBase), decimals, symbol: String(payload.symbol || '') },
      excludeTokenVouts: plans.map((_, index) => index),
      broadcast: () => broadcastRawHex(tx.toString(), txid),
    });
    await saveLocks(address, [...(await getLocks(address)).map(row => row.lockTxid === txid && row.status === 'broadcasting' ? { ...row, status: 'locked' } : row)]);
  } catch (error) {
    // The broadcaster can time out after accepting a tx. Preserve the deterministic txid and
    // outputs so a retry cannot silently create duplicate locks.
    await saveLocks(address, [...(await getLocks(address)).map(row => row.lockTxid === txid ? { ...row, status: 'broadcast-uncertain', lastError: error.message } : row)]);
    throw new Error(`${error.message} The planned lock is saved locally as broadcast-uncertain with txid ${txid}; check that tx before retrying.`);
  }
  return { txid, totalLocked: fromBaseUnits(amountBase, decimals), tranches: trancheCount };
}

async function claimTokenLock(privateKey, lockId) {
  const address = privateKey.toAddress().toString();
  const rows = await getLocks(address);
  const lock = rows.find(row => row.id === lockId);
  if (!lock) throw new Error('This lock was not found in the local locker.');
  if (lock.ownerAddress !== address) throw new Error('This wallet does not own the selected lock.');
  if (lock.status !== 'locked') throw new Error(`This tranche is ${lock.status}; only confirmed locked tranches can be claimed.`);
  if (Math.floor(Date.now() / 1000) < lock.unlockTimestamp) throw new Error('This tranche has not reached its unlock time yet.');
  const [txid, voutText] = lock.outpoint.split('_');
  const vout = Number(voutText);
  const parentHex = await getTrackedTransactionHex(address, txid) || await bananaBlocksFetch(`${API}/bsv/main/tx/${txid}/hex`, { headers: { Accept: 'text/plain' }, signal: AbortSignal.timeout(20000) }).then(async r => {
    if (!r.ok) throw new Error(`Could not retrieve the lock transaction (${r.status}).`);
    return (await r.text()).trim();
  });
  const parent = new bsv.Transaction(parentHex);
  const output = parent.outputs[vout];
  if (!output) throw new Error('The locked token output is missing from its parent transaction.');
  const inscription = readInscription(output.script.toHex());
  if (!inscription || String(inscription.id) !== lock.tokenId || BigInt(inscription.amt) !== BigInt(lock.amountBase)) throw new Error('The on-chain lock output does not match this local locker record.');
  const tokenUtxo = { txid, vout, satoshis: output.satoshis, scriptHex: output.script.toHex() };
  const tx = new bsv.Transaction();
  addInscriptionInput(tx, tokenUtxo, privateKey);
  tx.addOutput(new bsv.Transaction.Output({ script: transferScript(address, lock.tokenId, lock.amountBase), satoshis: 1 }));
  const feeUtxos = await addFeeInputs(tx, address, privateKey, 4000);
  tx.nLockTime = lock.unlockTimestamp;
  for (const input of tx.inputs) input.sequenceNumber = 0xfffffffe;
  tx.sign(privateKey);
  signInscriptionInput(tx, tokenUtxo, privateKey);
  const releaseTxid = tx.id.toLowerCase();
  await broadcastTrackedTransaction({
    address,
    txid: releaseTxid,
    rawHex: tx.toString(),
    type: 'token-unlock',
    inputOutpoints: [`${txid}.${vout}`, ...feeUtxos.map(input => `${input.txid}.${input.vout}`)],
    details: { title: 'BSV-21 lock claimed', tokenId: lock.tokenId, tokenAmount: lock.amountBase, decimals: lock.decimals, symbol: lock.ticker },
    broadcast: () => broadcastRawHex(tx.toString(), releaseTxid),
  });
  await saveLocks(address, (await getLocks(address)).map(row => row.id === lock.id ? { ...row, status: 'released', releaseTxid, releasedAt: new Date().toISOString() } : row));
  return { txid: releaseTxid, amount: lock.amount, tokenId: lock.tokenId };
}

async function reconcileLocks(address, tokenId) {
  const id = normalizeTokenOutpoint(tokenId);
  const rows = await getLocks(address);
  const selected = rows.filter(row => row.tokenId === id && ['broadcasting', 'broadcast-uncertain'].includes(row.status));
  if (!selected.length) return rows.filter(row => row.tokenId === id).sort((a, b) => a.unlockTimestamp - b.unlockTimestamp);
  const byTx = [...new Set(selected.map(row => row.lockTxid))];
  const results = await Promise.all(byTx.map(async txid => {
    try { return [txid, await json(`${API}/tx/${txid}/status`)]; } catch { return [txid, null]; }
  }));
  const statusByTx = new Map(results);
  const updated = rows.map(row => {
    if (!statusByTx.has(row.lockTxid) || !['broadcasting', 'broadcast-uncertain'].includes(row.status)) return row;
    const txStatus = statusByTx.get(row.lockTxid)?.txStatus;
    if (['MINED', 'CONFIRMED', 'SEEN_ON_NETWORK', 'ACCEPTED_BY_NETWORK', 'SEEN_IN_ORPHAN_MEMPOOL', 'SENT_TO_NETWORK', 'ANNOUNCED_TO_NETWORK', 'REQUESTED_BY_NETWORK', 'RECEIVED', 'STORED', 'QUEUED'].includes(txStatus)) return { ...row, status: 'locked', networkStatus: txStatus };
    if (['REJECTED', 'DOUBLE_SPEND_ATTEMPTED'].includes(txStatus)) return { ...row, status: 'rejected', networkStatus: txStatus };
    return row;
  });
  if (updated !== rows) await saveLocks(address, updated);
  return updated.filter(row => row.tokenId === id).sort((a, b) => a.unlockTimestamp - b.unlockTimestamp);
}

module.exports = {
  sendBsv, estimateBsvSendFee, sendPeerChatMessage, sendToken, mintBsv21Token, createTokenLock, claimTokenLock, getTokenLocks: reconcileLocks, migrateLegacyTokenLocks, getTokenIconData,
  _market: { fetchSpendableTokenOutput, syncSpendableBsvUtxos, broadcastRawHex },
  _test: {
    transferScript,
    toBaseUnits,
    fromBaseUnits,
    readInscription,
    inscriptionTokenId,
    readOrdinalImageData,
    normalizeTokenOutpoint,
    ordinalImageScript,
    bsv21DeployScript,
    parseMintImage,
  },
};
