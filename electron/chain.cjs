const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const { bananaBlocksFetch, waitForRateLimitBudget } = require('./bananablocks.cjs');
const {
  cacheObservedBsvUtxos,
  getWalletData,
  getSpendableBsvUtxos,
  saveWalletChainSnapshot,
  mergeChainActivity,
  setWalletTransactionStatus,
  setWalletTransactionStatusCheckedAt,
} = require('./wallet-data.cjs');
const { _market: { fetchSpendableTokenOutput, syncSpendableBsvUtxos } } = require('./token-wallet.cjs');
const { reconcileDefinitivelyRejectedTransactions } = require('./transaction-tracker.cjs');
const { fetchAllUnspentUtxos } = require('./bsv-unspent.cjs');
const { reportProgress } = require('./spv.cjs');

const BB_API = 'https://bananablocks.com/api/v1';
const HISTORY_PAGE_SIZE = 100;
const HISTORY_PAGE_LIMIT = 500;
const DETAIL_LOOKUP_LIMIT = 500;
const API_MIN_INTERVAL_MS = 250;
const API_MAX_RETRIES = 3;
let nextApiRequestAt = 0;
let apiRequestQueue = Promise.resolve();
let apiMinIntervalMs = API_MIN_INTERVAL_MS;
const activeBalanceSyncs = new Map();

function rateLimitDelay(response, attempt) {
  const retryAfter = response.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60000, seconds * 1000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.min(60000, Math.max(0, timestamp - Date.now()));
  }
  return Math.min(30000, 1000 * (2 ** attempt));
}

function requestBananaBlocks(url, attempt, init = {}) {
  const request = apiRequestQueue.catch(() => {}).then(async () => {
    const waitMs = Math.max(0, nextApiRequestAt - Date.now());
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    await waitForRateLimitBudget();
    let response;
    try {
      response = await bananaBlocksFetch(url, {
        method: init.method || 'GET',
        headers: { Accept: 'application/json', ...(init.headers || {}) },
        body: init.body,
        signal: AbortSignal.timeout(init.timeout || 15000),
      });
    } catch (error) {
      nextApiRequestAt = Date.now() + apiMinIntervalMs;
      throw error;
    }
    const completedAt = Date.now();
    nextApiRequestAt = completedAt + apiMinIntervalMs;
    if (response.status === 429) {
      nextApiRequestAt = Math.max(nextApiRequestAt, completedAt + rateLimitDelay(response, attempt));
    }
    return response;
  });
  apiRequestQueue = request.then(() => {}, () => {});
  return request;
}

async function fetchJsonResponse(url) {
  let response;
  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
    response = await requestBananaBlocks(url, attempt);
    if (response.status !== 429 || attempt === API_MAX_RETRIES) break;
  }
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`BananaBlocks returned HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
    error.status = response.status;
    if (response.status === 429) error.code = 'BANANABLOCKS_RATE_LIMIT';
    throw error;
  }
  try { return { body: JSON.parse(text), headers: response.headers }; }
  catch { throw new Error('BananaBlocks returned an unreadable response.'); }
}

async function fetchJson(url) {
  return (await fetchJsonResponse(url)).body;
}

function intString(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
  return null;
}

async function syncWalletBalances(address) {
  if (!bsv.Address.isValid(address, 'livenet')) throw new Error('The active wallet address is invalid.');
  const existing = activeBalanceSyncs.get(address);
  if (existing) return existing;
  const sync = syncWalletBalancesOnce(address);
  activeBalanceSyncs.set(address, sync);
  try {
    return await sync;
  } finally {
    if (activeBalanceSyncs.get(address) === sync) activeBalanceSyncs.delete(address);
  }
}

async function syncWalletBalancesOnce(address) {
  reportProgress({ phase: 'fetching-wallet-data', completed: 0, total: 1 });
  await reconcileDefinitivelyRejectedTransactions(address);
  const prior = (await getWalletData(address)).chainSnapshot;
  const encodedAddress = encodeURIComponent(address);
  const balanceUrl = `${BB_API}/bsv/main/address/${encodedAddress}/balance`;
  const tokensUrl = `${BB_API}/address/${encodedAddress}/tokens`;

  const [balanceResult, tokenResult, utxoResult] = await Promise.allSettled([
    fetchJson(balanceUrl),
    fetchJson(tokensUrl),
    fetchAllUnspentUtxos(address, {
      onProgress: progress => reportProgress({ phase: 'scanning-wallet-utxos', ...progress }),
    }),
  ]);
  reportProgress({ phase: 'fetching-wallet-data', completed: 1, total: 1 });

  const syncedAt = new Date().toISOString();
  let balance = null;
  let balanceError = null;
  let activityError = null;
  let balanceSyncedAt = prior?.balanceSyncedAt || prior?.syncedAt || null;
  if (balanceResult.status === 'fulfilled') {
    const value = balanceResult.value?.result || balanceResult.value;
    const confirmed = intString(value?.confirmed ?? value?.balance?.confirmed ?? value?.balance);
    const unconfirmed = intString(value?.unconfirmed ?? value?.balance?.unconfirmed ?? '0');
    if (confirmed === null || unconfirmed === null) balanceError = 'The BSV balance response was missing satoshi totals.';
    else {
      balance = { confirmed, unconfirmed };
      balanceSyncedAt = syncedAt;
    }
  } else balanceError = balanceResult.reason?.message || 'Could not sync BSV balance.';

  if (balance && BigInt(balance.unconfirmed) > 0n) {
    try { activityError = await syncRecentUnconfirmedActivity(address); }
    catch (error) { activityError = `Unconfirmed wallet activity could not be refreshed: ${error.message}`; }
  }

  let tokens = [];
  let tokenError = null;
  let tokensSyncedAt = prior?.tokensSyncedAt || prior?.syncedAt || null;
  if (tokenResult.status === 'fulfilled') {
    const body = tokenResult.value;
    tokens = Array.isArray(body) ? body : (body?.tokens || body?.result || body?.items || []);
    if (!Array.isArray(tokens)) {
      tokenError = 'The BSV-21 token response had an unexpected format.';
      tokens = [];
    } else {
      tokens = await Promise.all(tokens.map(async (item) => {
        const tokenId = String(item.token_id ?? item.id ?? '');
        if (!tokenId) return null;
        let detail = {};
        if (item.decimals == null || !item.symbol) {
          const candidates = [tokenId, tokenId.split('_')[0]].filter((value, index, all) => value && all.indexOf(value) === index);
          for (const candidate of candidates) {
            try { detail = await fetchJson(`${BB_API}/token/${encodeURIComponent(candidate)}`); break; }
            catch (_) { /* Try the alternate canonical token-id form. */ }
          }
        }
        const metadata = detail?.result || detail?.token || detail;
        const decimals = item.decimals ?? metadata?.decimals ?? 0;
        const rawIcon = String(item.icon ?? metadata?.icon ?? '').trim();
        const icon = /^_[0-9]+$/.test(rawIcon)
          ? `${tokenId.split('_')[0].toLowerCase()}${rawIcon}`
          : /^[0-9a-f]{64}_[0-9]+$/i.test(rawIcon) ? rawIcon.toLowerCase() : null;
        return {
          tokenId,
          symbol: String(item.symbol ?? item.ticker ?? metadata?.symbol ?? tokenId),
          name: String(item.name ?? metadata?.name ?? item.symbol ?? metadata?.symbol ?? tokenId),
          decimals: Number.isInteger(Number(decimals)) ? Math.min(18, Math.max(0, Number(decimals))) : 0,
          balance: intString(item.balance ?? item.amount ?? item.token_balance) || '0',
          ...(icon ? { icon } : {}),
        };
      })).then(rows => rows.filter(Boolean));
      tokensSyncedAt = syncedAt;
    }
  } else tokenError = tokenResult.reason?.message || 'Could not sync BSV-21 tokens.';

  let utxoError = null;
  let utxoCount = null;
  if (utxoResult.status === 'fulfilled') {
    const rows = utxoResult.value;
    if (!Array.isArray(rows)) utxoError = 'The BSV UTXO response had an unexpected format.';
    else {
      try {
        await cacheObservedBsvUtxos(address, rows, { complete: true });
        const verification = await syncSpendableBsvUtxos(address, rows, progress => {
          reportProgress({ phase: 'verifying-cash-utxos', ...progress });
        });
        utxoCount = rows.length;
        const warnings = [];
        if (verification.failures > 0) {
          warnings.push(`${verification.failures} confirmed BSV UTXO(s) could not be verified.`);
        }
        if (warnings.length) utxoError = warnings.join(' ');
      } catch (error) {
        utxoError = error.message || 'Could not verify and store the local BSV UTXO snapshot.';
      }
    }
  } else utxoError = utxoResult.reason?.message || 'Could not sync BSV UTXOs.';

  if (tokenResult.status === 'fulfilled' && !tokenError) {
    const fundedTokens = tokens.filter(item => BigInt(item.balance || '0') > 0n);
    for (let index = 0; index < fundedTokens.length; index++) {
      const token = fundedTokens[index];
      reportProgress({ phase: 'verifying-token-utxos', completed: index, total: fundedTokens.length });
      try {
        await fetchSpendableTokenOutput(address, token.tokenId);
      } catch (error) {
        if (!/time-locked/i.test(error.message || '')) {
          const message = `Could not cache a verified spendable output for ${token.symbol}: ${error.message || 'token input verification failed.'}`;
          utxoError = utxoError ? `${utxoError} ${message}` : message;
        }
      } finally {
        reportProgress({ phase: 'verifying-token-utxos', completed: index + 1, total: fundedTokens.length });
      }
    }
  }

  const spendableUtxos = await getSpendableBsvUtxos(address);
  const spendableBsvSats = spendableUtxos.reduce((sum, row) => sum + BigInt(row.satoshis), 0n);
  const pendingLocalBsvSats = spendableUtxos.filter(row => row.state === 'pending')
    .reduce((sum, row) => sum + BigInt(row.satoshis), 0n);
  const balanceWithLocalSpendable = balance
    ? { ...balance, spendableBsvSats: String(spendableBsvSats), pendingLocalBsvSats: String(pendingLocalBsvSats) }
    : prior?.balance
    ? { ...prior.balance, spendableBsvSats: String(spendableBsvSats), pendingLocalBsvSats: String(pendingLocalBsvSats) }
    : spendableBsvSats > 0n
      ? { confirmed: '0', unconfirmed: '0', spendableBsvSats: String(spendableBsvSats), pendingLocalBsvSats: String(pendingLocalBsvSats) }
      : null;
  const snapshot = {
    address,
    balance: balanceWithLocalSpendable,
    tokens: tokenResult.status === 'fulfilled' && !tokenError ? tokens : prior?.tokens || [],
    errors: { bsv: balanceError, tokens: tokenError, utxos: utxoError, activity: activityError },
    utxoCount: utxoCount ?? prior?.utxoCount ?? null,
    syncedAt: balanceSyncedAt || tokensSyncedAt || prior?.syncedAt || syncedAt,
    balanceSyncedAt,
    tokensSyncedAt,
    utxoSyncedAt: utxoCount === null ? prior?.utxoSyncedAt || null : syncedAt,
    source: 'BananaBlocks API',
  };
  reportProgress({ phase: 'saving-wallet-snapshot', completed: 0, total: 1 });
  const saved = await saveWalletChainSnapshot(address, snapshot);
  reportProgress({ phase: 'sync-complete', completed: 1, total: 1 });
  return saved;
}

function responseRows(body) {
  if (Array.isArray(body)) return body;
  return body?.result || body?.items || body?.transactions || [];
}

function historyTxid(row) {
  const value = String(typeof row === 'string' ? row : row?.tx_hash || row?.txid || row?.hash || '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function historyHeight(row) {
  const height = Number(row?.height ?? row?.block_height ?? 0);
  return Number.isSafeInteger(height) && height > 0 ? height : 0;
}

async function fetchAddressHistory(address, knownTxids, alreadyBackfilled, startCursor = null, startPage = 0, { onProgress = null } = {}) {
  const refs = new Map();
  const errors = [];
  let complete = false;
  let rateLimited = false;
  let cursor = typeof startCursor === 'string' && startCursor ? startCursor : null;
  let nextCursor = cursor;
  let pageCount = cursor ? Math.max(0, Number(startPage) || 0) : 0;
  let nextPage = pageCount;
  let pagesRead = 0;
  let restartedFromBeginning = false;
  while (pagesRead < HISTORY_PAGE_LIMIT) {
    const pageCursor = cursor;
    const baseUrl = `${BB_API}/bsv/main/address/${encodeURIComponent(address)}/history?limit=${HISTORY_PAGE_SIZE}`;
    const url = pageCursor ? `${baseUrl}&cursor=${encodeURIComponent(pageCursor)}` : baseUrl;
    let response;
    try {
      response = await fetchJsonResponse(url);
    } catch (error) {
      if (error.status === 409 && pageCursor && !restartedFromBeginning) {
        refs.clear();
        cursor = null;
        nextCursor = null;
        pageCount = 0;
        nextPage = 0;
        restartedFromBeginning = true;
        continue;
      }
      errors.push(`Wallet history page ${pageCount + 1} could not be read: ${error.message}`);
      rateLimited = error.code === 'BANANABLOCKS_RATE_LIMIT';
      nextCursor = pageCursor;
      nextPage = pageCount;
      break;
    }
    const rows = responseRows(response.body);
    if (!Array.isArray(rows)) {
      errors.push(`Wallet history page ${pageCount + 1} returned an unexpected response.`);
      nextCursor = pageCursor;
      nextPage = pageCount;
      break;
    }
    let newIds = 0;
    for (const row of rows) {
      const txid = historyTxid(row);
      if (!txid) continue;
      const previous = refs.get(txid);
      refs.set(txid, { txid, height: Math.max(historyHeight(row), previous?.height || 0) });
      if (!knownTxids.has(txid)) newIds++;
    }
    pagesRead++;
    pageCount++;
    nextPage = pageCount;
    if (typeof onProgress === 'function') {
      onProgress({ phase: 'activity-history-page', completed: pageCount, count: refs.size });
    }

    const hasMoreHeader = response.headers?.get('x-has-more');
    const continuation = response.headers?.get('x-next-cursor') || null;
    if (hasMoreHeader != null && !['true', 'false'].includes(hasMoreHeader.toLowerCase())) {
      errors.push(`Wallet history page ${pageCount} returned an invalid continuation status.`);
      nextCursor = pageCursor;
      nextPage = pageCount - 1;
      break;
    }
    if (alreadyBackfilled && newIds === 0) {
      complete = true;
      nextPage = 0;
      nextCursor = null;
      break;
    }
    const hasMore = hasMoreHeader != null
      ? hasMoreHeader.toLowerCase() === 'true'
      : Boolean(continuation) || rows.length >= HISTORY_PAGE_SIZE;
    if (!hasMore) {
      complete = true;
      nextPage = 0;
      nextCursor = null;
      break;
    }
    if (!continuation) {
      errors.push(`Wallet history page ${pageCount} reports more entries but has no continuation cursor.`);
      nextCursor = pageCursor;
      nextPage = pageCount - 1;
      break;
    }
    cursor = continuation;
    nextCursor = continuation;
  }

  if (!rateLimited) {
    try {
      if (typeof onProgress === 'function') onProgress({ phase: 'activity-unconfirmed-history', completed: 0, count: refs.size });
      const body = await fetchJson(`${BB_API}/bsv/main/address/${encodeURIComponent(address)}/unconfirmed/history?limit=100`);
      for (const row of responseRows(body)) {
        const txid = historyTxid(row);
        if (!txid) continue;
        const previous = refs.get(txid);
        refs.set(txid, { txid, height: previous?.height || 0 });
      }
    } catch (error) {
      if (!/HTTP 404/.test(error.message)) errors.push(`Unconfirmed history is unavailable: ${error.message}`);
      if (error.code === 'BANANABLOCKS_RATE_LIMIT') rateLimited = true;
    }
  }
  return { refs: [...refs.values()], errors, complete, nextCursor, nextPage, pagesRead, rateLimited };
}

function addressList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '')).filter(Boolean);
  if (typeof value === 'string' && value) return [value];
  return [];
}

function satsValue(value) {
  if (typeof value === 'string' && /^\d+\.\d{1,8}$/.test(value)) return Math.round(Number(value) * 100000000);
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : 0;
}

function knownSatsValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && /^\d+\.\d{1,8}$/.test(value)) return satsValue(value);
  if ((typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0) return Number(value);
  return null;
}

function tokenOutput(output) {
  const token = output?.parsed?.bsv21 ?? output?.bsv21 ?? null;
  const tokenId = String(token?.id ?? token?.token_id ?? token?.tokenId ?? '');
  const amount = String(token?.amt ?? token?.amount ?? '');
  if (token?.valid !== true || !/^[0-9a-f]{64}(?:_[0-9]+)?$/i.test(tokenId) || !/^\d+$/.test(amount)) return null;
  return {
    tokenId: tokenId.includes('_') ? tokenId.toLowerCase() : `${tokenId.toLowerCase()}_1`,
    amount,
    symbol: String(token.sym ?? token.symbol ?? ''),
    vout: Number(output.index ?? output.vout ?? 0),
  };
}

function summarizeWalletTransaction(tx, address, ref, existing) {
  const body = tx?.result || tx?.transaction || tx;
  const inputs = Array.isArray(body?.inputs) ? body.inputs : [];
  const outputs = Array.isArray(body?.outputs) ? body.outputs : [];
  const spentSats = inputs.reduce((sum, input) => (
    addressList(input?.address ?? input?.addresses).includes(address) ? sum + satsValue(input.value ?? input.satoshis) : sum
  ), 0);
  const receivedSats = outputs.reduce((sum, output) => (
    addressList(output?.address ?? output?.addresses).includes(address) ? sum + satsValue(output.value ?? output.satoshis) : sum
  ), 0);
  const netSats = receivedSats - spentSats;
  const inputValues = inputs.map(input => knownSatsValue(input.value ?? input.satoshis));
  const outputValues = outputs.map(output => knownSatsValue(output.value ?? output.satoshis));
  const totalInputSats = inputValues.every(value => value !== null)
    ? inputValues.reduce((sum, value) => sum + BigInt(value), 0n)
    : null;
  const totalOutputSats = outputValues.every(value => value !== null)
    ? outputValues.reduce((sum, value) => sum + BigInt(value), 0n)
    : null;
  const feeSats = totalInputSats !== null && totalOutputSats !== null && totalInputSats >= totalOutputSats
    ? (totalInputSats - totalOutputSats).toString()
    : null;
  const receivedTokens = outputs.flatMap(output => {
    const token = tokenOutput(output);
    return token && addressList(output.address ?? output.addresses).includes(address) ? [token] : [];
  });
  const txid = historyTxid({ txid: body?.txid || body?.hash || ref.txid }) || ref.txid;
  const blockHeight = Math.max(historyHeight(body), ref.height);
  const timestampSeconds = Number(body?.block_time ?? body?.time ?? 0);
  const timestamp = timestampSeconds > 0
    ? new Date(timestampSeconds * 1000).toISOString()
    : existing?.timestamp || new Date().toISOString();
  const tokenAmount = receivedTokens.reduce((sum, token) => sum + BigInt(token.amount), 0n);
  const firstToken = receivedTokens[0];
  const type = existing?.type || (netSats < 0 ? 'bsv-send'
      : netSats > 0 ? 'bsv-receive'
        : receivedTokens.length ? 'token-receive' : 'wallet-transaction');
  const details = { ...(existing?.details || {}) };
  delete details.lookupError;
  return {
    txid,
    type,
    title: existing?.title || (type === 'bsv-send' ? 'BSV sent' : type === 'bsv-receive' ? 'BSV received' : type === 'token-receive' ? `${firstToken?.symbol || 'BSV-21'} received` : 'Wallet transaction'),
    status: blockHeight > 0 ? 'confirmed' : 'unconfirmed',
    timestamp,
    amountSats: existing?.amountSats ?? (netSats === 0 ? null : Math.abs(netSats)),
    recipient: existing?.recipient || null,
    tokenId: existing?.tokenId || firstToken?.tokenId || null,
    tokenAmount: existing?.tokenAmount || (tokenAmount > 0n ? String(tokenAmount) : null),
    symbol: existing?.symbol || firstToken?.symbol || null,
    blockHeight,
    confirmations: blockHeight > 0 ? 1 : 0,
    details: {
      ...details,
      lookupError: null,
      netSats,
      ...(spentSats > 0 ? {
        walletInputSats: String(spentSats),
        changeSats: String(receivedSats),
        walletNetSpentSats: String(Math.max(0, spentSats - receivedSats)),
      } : {}),
      ...(existing?.details?.feeSats != null || feeSats === null
        ? {}
        : { feeSats }),
      receivedTokens,
    },
    source: 'chain',
  };
}

async function syncRecentUnconfirmedActivity(address) {
  const body = await fetchJson(`${BB_API}/bsv/main/address/${encodeURIComponent(address)}/unconfirmed/history?limit=100`);
  const rows = responseRows(body);
  if (!Array.isArray(rows)) throw new Error('BananaBlocks returned an unexpected unconfirmed-history response.');

  const prior = await getWalletData(address);
  const existingByTxid = new Map(prior.activities.filter(row => row.txid).map(row => [row.txid, row]));
  const localTransactions = new Map(prior.transactions.map(row => [row.txid, row]));
  const activities = [];
  const detailFailures = [];
  const seenTxids = new Set();
  for (const row of rows) {
    const txid = historyTxid(row);
    if (!txid || seenTxids.has(txid)) continue;
    seenTxids.add(txid);
    const existing = existingByTxid.get(txid);
    const transaction = localTransactions.get(txid);
    if (existing?.status === 'confirmed' || existing?.status === 'rejected'
      || ['confirmed', 'rejected'].includes(transaction?.status)) continue;
    if (existing && !existing.details?.lookupError) {
      if (existing.status !== 'unconfirmed') {
        activities.push({ ...existing, status: 'unconfirmed', blockHeight: 0, confirmations: 0, source: 'chain' });
      }
      continue;
    }
    if (transaction) {
      const localDetails = { ...(existing?.details || {}), ...(transaction.details || {}) };
      delete localDetails.lookupError;
      activities.push({
        ...(existing || {}),
        txid,
        type: transaction.type,
        title: existing?.title || transaction.details?.title || transaction.type,
        status: 'unconfirmed',
        timestamp: existing?.timestamp || transaction.timestamp,
        amountSats: existing?.amountSats ?? transaction.details?.amountSats,
        recipient: existing?.recipient || transaction.details?.recipient,
        tokenId: existing?.tokenId || transaction.details?.tokenId,
        tokenAmount: existing?.tokenAmount || transaction.details?.tokenAmount,
        symbol: existing?.symbol || transaction.details?.symbol,
        blockHeight: 0,
        confirmations: 0,
        details: localDetails,
        source: 'local',
      });
      continue;
    }
    try {
      activities.push(summarizeWalletTransaction(
        await fetchJson(`${BB_API}/tx/${encodeURIComponent(txid)}`),
        address,
        { txid, height: 0 },
        existing || null,
      ));
    } catch (error) {
      const delta = intString(row?.delta_satoshis ?? row?.deltaSats ?? row?.netSats);
      const netSats = delta !== null && Number.isSafeInteger(Number(delta)) ? Number(delta) : null;
      const type = netSats == null || netSats === 0 ? 'wallet-transaction' : netSats < 0 ? 'bsv-send' : 'bsv-receive';
      activities.push({
        ...(existing || {}),
        txid,
        type,
        title: existing?.title || (type === 'bsv-send' ? 'BSV sent'
          : type === 'bsv-receive' ? 'BSV received' : 'Unconfirmed wallet transaction'),
        status: 'unconfirmed',
        timestamp: existing?.timestamp || new Date().toISOString(),
        amountSats: existing?.amountSats ?? (netSats === null ? null : Math.abs(netSats)),
        blockHeight: 0,
        confirmations: 0,
        details: {
          ...(existing?.details || {}),
          ...(netSats === null ? {} : { netSats }),
          lookupError: error.message,
        },
        source: 'chain',
      });
      detailFailures.push(`${txid.slice(0, 10)}…`);
      if (error.code === 'BANANABLOCKS_RATE_LIMIT') break;
    }
  }

  if (activities.length) {
    await mergeChainActivity(address, activities, new Date().toISOString(), {
      remaining: prior.historyBackfillQueue?.length || 0,
      errors: detailFailures,
      historyBackfillComplete: prior.historyBackfillComplete === true,
      historyCursor: prior.historyCursor || null,
      historyPageCursor: prior.historyPageCursor || 0,
      historyBackfillQueue: prior.historyBackfillQueue || [],
      updateHistorySyncState: false,
    });
  }
  return detailFailures.length
    ? `Details for ${detailFailures.length} unconfirmed transaction(s) could not be loaded; the transaction IDs were saved locally.`
    : null;
}

async function syncObservedUtxos(address) {
  const rows = await fetchAllUnspentUtxos(address);
  if (!Array.isArray(rows)) throw new Error('BananaBlocks returned an unexpected wallet UTXO response.');
  await cacheObservedBsvUtxos(address, rows, { complete: true });
  return rows.length;
}

async function checkTrackedPendingTransactionStatuses(address, { historyRefs = new Map() } = {}) {
  const prior = await getWalletData(address);
  const existingByTxid = new Map(prior.activities.filter(row => row.txid).map(row => [row.txid, row]));
  const transactions = prior.transactions.filter(transaction =>
    ['pending', 'broadcasting', 'broadcast-uncertain'].includes(transaction.status));
  const activities = [];
  const errors = [];

  for (const transaction of transactions) {
    const txid = transaction.txid;
    try {
      const historyRef = historyRefs.get(txid);
      let body = null;
      let status = '';
      if (Number(historyRef?.height) > 0) {
        status = 'CONFIRMED';
      } else {
        body = await fetchJson(`${BB_API}/tx/${encodeURIComponent(txid)}/status`);
        status = String(body?.txStatus || body?.status || '').toUpperCase();
      }
      let activity = null;
      if (['REJECTED', 'DOUBLE_SPEND_ATTEMPTED', 'SEEN_IN_ORPHAN_MEMPOOL'].includes(status)) {
        await setWalletTransactionStatus(address, txid, 'rejected', status);
        const priorActivity = existingByTxid.get(txid) || {};
        activity = {
          ...priorActivity,
          txid,
          type: transaction.type,
          title: priorActivity.title || transaction.details?.title || transaction.type,
          status: 'rejected',
          timestamp: transaction.timestamp,
          details: { ...(transaction.details || {}), ...(priorActivity.details || {}) },
          source: 'local',
        };
      } else if (['MINED', 'CONFIRMED'].includes(status)) {
        const parsedHeight = Number(body?.blockHeight ?? body?.block_height ?? historyRef?.height ?? 1);
        const height = Number.isSafeInteger(parsedHeight) && parsedHeight > 0 ? parsedHeight : 1;
        await setWalletTransactionStatus(address, txid, 'confirmed');
        const priorActivity = existingByTxid.get(txid) || {};
        activity = {
          ...priorActivity,
          txid,
          type: transaction.type,
          title: priorActivity.title || transaction.details?.title || transaction.type,
          status: 'confirmed',
          timestamp: transaction.timestamp,
          blockHeight: height,
          confirmations: Number.isSafeInteger(Number(body?.confirmations)) ? Number(body.confirmations) : 1,
          details: { ...(transaction.details || {}), ...(priorActivity.details || {}) },
          source: 'local',
        };
      }
      if (activity) activities.push(activity);
    } catch (error) {
      if (!/HTTP 404/.test(error.message)) errors.push(`Could not verify transaction ${txid.slice(0, 10)}…: ${error.message}`);
    }
  }

  const checkedAt = await setWalletTransactionStatusCheckedAt(address);
  return { activities, errors, checkedTransactions: transactions.length, checkedAt };
}

async function syncWalletActivity(address, { onProgress = null } = {}) {
  const report = typeof onProgress === 'function'
    ? (payload) => { try { onProgress(payload); } catch { /* progress reporting must never break a sync */ } }
    : () => {};
  if (!bsv.Address.isValid(address, 'livenet')) throw new Error('The active wallet address is invalid.');
  report({ phase: 'activity-reconciling', completed: 0, total: 0 });
  await reconcileDefinitivelyRejectedTransactions(address);
  const prior = await getWalletData(address);
  const knownTxids = new Set([
    ...prior.activities.map(row => String(row.txid || '').toLowerCase()),
    ...prior.transactions.map(row => row.txid),
  ]);
  const { refs, errors, complete: historyBackfillComplete, nextCursor: historyCursor, nextPage: historyPageCursor, pagesRead: historyPagesRead, rateLimited: historyRateLimited } = await fetchAddressHistory(
    address,
    knownTxids,
    prior.historyBackfillComplete === true,
    prior.historyCursor || null,
    prior.historyCursor ? Number(prior.historyPageCursor || 0) : 0,
    { onProgress: report },
  );
  const refByTxid = new Map(refs.map(ref => [ref.txid, ref]));
  const existingByTxid = new Map(prior.activities.filter(row => row.txid).map(row => [row.txid, row]));
  const localTransactions = new Map(prior.transactions.map(row => [row.txid, row]));
  const queuedRefs = new Map((prior.historyBackfillQueue || []).map(ref => [ref.txid, ref]));
  for (const ref of refs) {
    const existing = existingByTxid.get(ref.txid);
    if (!existing || ref.height > (existing.blockHeight || 0) || existing.details?.lookupError) queuedRefs.set(ref.txid, ref);
  }
  for (const txid of localTransactions.keys()) queuedRefs.delete(txid);
  const selectedRefs = [...queuedRefs.values()].slice(0, DETAIL_LOOKUP_LIMIT);
  const activities = [];
  const detailFailures = [];
  const processedTxids = new Set();
  let rateLimited = historyRateLimited;
  const detailTargets = rateLimited ? [] : selectedRefs;
  let detailIndex = 0;
  for (const ref of detailTargets) {
    detailIndex += 1;
    report({ phase: 'activity-loading-transactions', completed: detailIndex, total: detailTargets.length, count: activities.length });
    const existing = existingByTxid.get(ref.txid);
    if (localTransactions.has(ref.txid)) {
      activities.push(summarizeWalletTransaction({}, address, ref, existing || {
        ...localTransactions.get(ref.txid)?.details,
        type: localTransactions.get(ref.txid)?.type,
        title: localTransactions.get(ref.txid)?.details?.title,
        timestamp: localTransactions.get(ref.txid)?.timestamp,
        source: 'local',
      }));
      processedTxids.add(ref.txid);
      continue;
    }
    if (existing && !existing.details?.lookupError) {
      activities.push(summarizeWalletTransaction({}, address, ref, existing));
      processedTxids.add(ref.txid);
      continue;
    }
    try {
      activities.push(summarizeWalletTransaction(
        await fetchJson(`${BB_API}/tx/${encodeURIComponent(ref.txid)}`),
        address,
        ref,
        null,
      ));
      processedTxids.add(ref.txid);
    } catch (error) {
      detailFailures.push(`${ref.txid.slice(0, 10)}…: ${error.message}`);
      activities.push({
        ...(existing || {}),
        txid: ref.txid,
        type: existing?.type || 'wallet-transaction',
        title: existing?.title || 'Wallet transaction',
        status: ref.height > 0 ? 'confirmed' : 'unconfirmed',
        timestamp: existing?.timestamp || new Date().toISOString(),
        amountSats: existing?.amountSats ?? null,
        blockHeight: ref.height,
        confirmations: ref.height > 0 ? 1 : 0,
        details: { ...(existing?.details || {}), lookupError: error.message },
        source: 'chain',
      });
      if (error.code === 'BANANABLOCKS_RATE_LIMIT') {
        rateLimited = true;
        break;
      }
    }
  }

  if (!rateLimited) {
    report({ phase: 'activity-checking-pending', completed: 0, total: 0 });
    const statusCheck = await checkTrackedPendingTransactionStatuses(address, {
      historyRefs: refByTxid,
    });
    errors.push(...statusCheck.errors);
    for (const activity of statusCheck.activities) {
      const index = activities.findIndex(row => row.txid === activity.txid);
      if (index < 0) activities.push(activity);
      else activities[index] = activity;
    }
  }

  if (detailFailures.length) errors.push(`${detailFailures.length} transaction detail lookup(s) failed.`);
  const historyBackfillQueue = [...queuedRefs.values()].filter(ref => !processedTxids.has(ref.txid));
  const remaining = historyBackfillQueue.length;
  let utxoCount = null;
  if (rateLimited) errors.push('BananaBlocks is rate limiting requests. Remaining history and transaction lookups have been saved for a later refresh.');
  else {
    report({ phase: 'activity-refreshing-utxos', completed: 0, total: 0 });
    try { utxoCount = await syncObservedUtxos(address); }
    catch (error) {
      errors.push(`UTXO snapshot could not be refreshed: ${error.message}`);
      if (error.code === 'BANANABLOCKS_RATE_LIMIT') rateLimited = true;
    }
  }

  const syncedAt = new Date().toISOString();
  report({ phase: 'activity-saving', completed: activities.length, total: activities.length });
  const snapshot = await mergeChainActivity(address, activities, syncedAt, {
    remaining,
    errors,
    historyBackfillComplete,
    historyCursor,
    historyPageCursor,
    historyBackfillQueue,
  });
  const result = {
    ...snapshot,
    scannedTransactions: refs.length,
    processedTransactions: activities.length,
    historyPagesRead,
    historyPageCursor,
    utxoCount,
  };
  report({
    phase: 'activity-complete',
    completed: activities.length,
    total: activities.length,
    count: refs.length,
    rateLimited,
    remaining,
  });
  return result;
}

async function checkPendingTransactionStatuses(address) {
  if (!bsv.Address.isValid(address, 'livenet')) throw new Error('The active wallet address is invalid.');
  const result = await checkTrackedPendingTransactionStatuses(address);
  const snapshot = await mergeChainActivity(address, result.activities, result.checkedAt, {
    errors: result.errors,
    updateHistorySyncState: false,
  });
  return { ...snapshot, checkedTransactions: result.checkedTransactions };
}

module.exports = {
  syncWalletBalances,
  syncWalletActivity,
  checkPendingTransactionStatuses,
  syncObservedUtxos,
  requestBananaBlocks,
  _test: {
    summarizeWalletTransaction,
    syncRecentUnconfirmedActivity,
    setApiMinIntervalMs(value) {
      if (!Number.isFinite(value) || value < 0) throw new Error('Test request interval must be a non-negative number.');
      apiMinIntervalMs = value;
      nextApiRequestAt = 0;
      apiRequestQueue = Promise.resolve();
    },
  },
};
