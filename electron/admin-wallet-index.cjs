const { bananaBlocksFetch } = require('./bananablocks.cjs');
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const { ADMIN_DISCOVERY_ADDRESS } = require('./constants.cjs');
const { ensureHeaderChain, verifyTransactionProof } = require('./spv.cjs');
const { getWalletAdminIndexSnapshot, saveWalletAdminIndexSnapshot } = require('./wallet-data.cjs');

const API = 'https://bananablocks.com/api/v1';
const HISTORY_LIMIT = 100;
const SYNC_CACHE_MS = 30000;
const MAX_CONCURRENT_LOOKUPS = 4;
const TXID_RE = /^[0-9a-f]{64}$/i;
const syncs = new Map();

async function fetchJson(url) {
  const response = await bananaBlocksFetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`BananaBlocks returned HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
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
  };
}

async function getAdminWalletIndex(walletAddress) {
  return normalizeCachedSnapshot(await getWalletAdminIndexSnapshot(walletAddress));
}

async function fetchHistory(cursor = null) {
  const query = new URLSearchParams({ limit: String(HISTORY_LIMIT) });
  if (cursor) query.set('cursor', cursor);
  const response = await bananaBlocksFetch(
    `${API}/bsv/main/address/${encodeURIComponent(ADMIN_DISCOVERY_ADDRESS)}/history?${query}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`BananaBlocks admin-wallet history returned HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
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
  const response = await bananaBlocksFetch(
    `${API}/bsv/main/address/${encodeURIComponent(ADMIN_DISCOVERY_ADDRESS)}/unconfirmed/history`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`BananaBlocks pending admin-wallet history returned HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('BananaBlocks pending admin-wallet history was unreadable.'); }
  const rows = Array.isArray(body) ? body : body?.result || body?.items || body?.transactions;
  if (!Array.isArray(rows)) throw new Error('BananaBlocks returned an unexpected pending admin-wallet history response.');
  return rows.map(row => getTxid(row)).filter(Boolean);
}

async function loadIndexedTransaction(ref, walletAddress) {
  const details = unwrap(await fetchJson(`${API}/tx/${encodeURIComponent(ref.txid)}`));
  const detailsTxid = getTxid(details);
  if (detailsTxid && detailsTxid !== ref.txid) throw new Error('BananaBlocks returned details for a different transaction.');
  let rawTxHex = null;
  if (hasRelevantProtocolPayload(details)) {
    const headerState = await ensureHeaderChain(walletAddress);
    const proof = await verifyTransactionProof(walletAddress, ref.txid, ref.height, headerState);
    if (proof.blockHeight !== ref.height) throw new Error('The BEEF proof height does not match admin-wallet history.');
    rawTxHex = proof.rawTxHex;
  }
  const blockTime = Number(details.block_time || 0);
  return {
    txid: ref.txid,
    blockHeight: ref.height,
    blockTime: Number.isSafeInteger(blockTime) && blockTime > 0 ? blockTime : 0,
    confirmed: true,
    rawTxHex,
    details: { ...details, block_height: ref.height, confirmed: true },
  };
}

async function loadPendingTransaction(txid) {
  const details = unwrap(await fetchJson(`${API}/tx/${encodeURIComponent(txid)}`));
  const detailsTxid = getTxid(details);
  if (detailsTxid && detailsTxid !== txid) throw new Error('BananaBlocks returned details for a different transaction.');
  let rawTxHex = null;
  if (hasRelevantProtocolPayload(details)) {
    const response = await bananaBlocksFetch(`${API}/tx/${encodeURIComponent(txid)}/hex`, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`BananaBlocks pending transaction bytes returned HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
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

async function syncAdminWalletIndexOnce(walletAddress) {
  const prior = await getWalletAdminIndexSnapshot(walletAddress);
  if (prior.syncedAt && Date.now() - Date.parse(prior.syncedAt) < SYNC_CACHE_MS) {
    return normalizeCachedSnapshot(prior);
  }

  const latestPage = await fetchHistory();
  const latestRefs = latestPage.rows.map(row => ({
    txid: getTxid(row),
    height: Number(row?.height ?? row?.block_height ?? 0),
  })).filter(ref => ref.txid && Number.isSafeInteger(ref.height) && ref.height > 0);
  const latestTxid = latestRefs[0]?.txid || prior.lastScannedTxid;
  const known = new Set(prior.transactions.map(row => row.txid));
  const newConfirmedRefs = [];
  let foundMarker = !prior.lastScannedTxid;
  for (const ref of latestRefs) {
    if (prior.lastScannedTxid && ref.txid === prior.lastScannedTxid) {
      foundMarker = true;
      break;
    }
    if (!known.has(ref.txid)) newConfirmedRefs.push(ref);
  }

  const errors = [];
  const cursorToScan = !foundMarker
    ? prior.historyCursor || latestPage.nextCursor
    : !prior.historyComplete ? prior.historyCursor || latestPage.nextCursor : null;
  const continuationPage = cursorToScan ? await fetchHistory(cursorToScan) : null;
  const continuationRefs = [];
  let markerSeenInContinuation = false;
  if (continuationPage) {
    for (const row of continuationPage.rows) {
      const txid = getTxid(row);
      if (!txid) continue;
      if (prior.lastScannedTxid && txid === prior.lastScannedTxid) {
        foundMarker = true;
        markerSeenInContinuation = true;
        continue;
      }
      if (markerSeenInContinuation && prior.historyComplete) continue;
      const ref = { txid, height: Number(row?.height ?? row?.block_height ?? 0) };
      if (Number.isSafeInteger(ref.height) && ref.height > 0 && !known.has(ref.txid)) continuationRefs.push(ref);
    }
  }
  if (!foundMarker && prior.lastScannedTxid) {
    errors.push(continuationPage?.hasMore
      ? 'The saved admin-wallet marker is older than the scanned history pages; sync again to continue indexing toward it.'
      : 'The saved admin-wallet marker was not found in admin-wallet history; it was preserved to avoid skipping records.');
  }
  const allRefs = [...newConfirmedRefs, ...continuationRefs];
  const transactions = [];
  let lookupFailures = 0;
  for (let offset = 0; offset < allRefs.length; offset += MAX_CONCURRENT_LOOKUPS) {
    const batch = allRefs.slice(offset, offset + MAX_CONCURRENT_LOOKUPS);
    const loaded = await Promise.all(batch.map(async ref => {
      try { return await loadIndexedTransaction(ref, walletAddress); }
      catch (error) {
        lookupFailures++;
        errors.push(`Admin transaction ${ref.txid.slice(0, 10)} could not be indexed: ${error.message}`);
        return null;
      }
    }));
    transactions.push(...loaded.filter(Boolean));
  }

  let pendingHistoryFailed = false;
  let pendingIds = [];
  try {
    pendingIds = [...new Set(await fetchUnconfirmedHistory())]
      .filter(txid => !known.has(txid));
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
    for (let offset = 0; offset < pendingIds.length; offset += MAX_CONCURRENT_LOOKUPS) {
      const batch = pendingIds.slice(offset, offset + MAX_CONCURRENT_LOOKUPS);
      const loaded = await Promise.all(batch.map(async txid => {
        if (confirmedIds.has(txid)) return null;
        const cached = priorPendingByTxid.get(txid);
        if (cached) return cached;
        try { return await loadPendingTransaction(txid); }
        catch (error) {
          pendingLookupFailures++;
          errors.push(`Pending admin transaction ${txid.slice(0, 10)} could not be indexed: ${error.message}`);
          return null;
        }
      }));
      pendingTransactions.push(...loaded.filter(Boolean));
    }
  }

  const syncedAt = new Date().toISOString();
  const lastScannedTxid = lookupFailures === 0 && foundMarker
    ? latestTxid
    : prior.lastScannedTxid;
  let historyCursor = prior.historyCursor;
  let historyComplete = prior.historyComplete;
  if (lookupFailures === 0) {
    if (continuationPage) {
      historyCursor = continuationPage.hasMore ? continuationPage.nextCursor : null;
      historyComplete = !continuationPage.hasMore;
    } else if (!prior.historyComplete) {
      historyCursor = latestPage.hasMore ? latestPage.nextCursor : null;
      historyComplete = !latestPage.hasMore;
    }
  }
  const saved = await saveWalletAdminIndexSnapshot(walletAddress, {
    transactions,
    pendingTransactions,
    lastScannedTxid,
    syncedAt: lookupFailures === 0 && pendingLookupFailures === 0 && !pendingHistoryFailed ? syncedAt : prior.syncedAt,
    historyCursor,
    historyComplete,
  });
  if (!historyComplete) errors.push('Admin-wallet history indexing is continuing through its saved local cursor; sync again after the current update.');
  return {
    ...normalizeCachedSnapshot(saved),
    source: 'BananaBlocks history with locally verified confirmed proofs and cached pending records',
    scannedTransactions: allRefs.length + pendingIds.length,
    lookupFailures: lookupFailures + pendingLookupFailures,
    errors,
  };
}

async function syncAdminWalletIndex(walletAddress) {
  const existing = syncs.get(walletAddress);
  if (existing) return existing;
  const sync = syncAdminWalletIndexOnce(walletAddress);
  syncs.set(walletAddress, sync);
  try { return await sync; }
  finally { if (syncs.get(walletAddress) === sync) syncs.delete(walletAddress); }
}

module.exports = {
  getAdminWalletIndex,
  syncAdminWalletIndex,
  _test: { getTxid, normalizeCachedSnapshot },
};
