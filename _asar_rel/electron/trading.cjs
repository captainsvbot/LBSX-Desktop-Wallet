const { bananaBlocksFetch } = require('./bananablocks.cjs');
const { getAdminWalletIndex, syncAdminWalletIndex } = require('./admin-wallet-index.cjs');

const BB_API = 'https://bananablocks.com/api/v1';
const ADMIN_DISCOVERY_ADDRESS = '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB';
const spendStatusCache = new Map();

async function fetchJson(url) {
  const response = await bananaBlocksFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`BananaBlocks returned HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
  try { return JSON.parse(text); } catch { throw new Error('BananaBlocks returned an unreadable response.'); }
}

function extractBsv21(output) {
  const parsed = output?.parsed?.bsv21 ?? output?.bsv21 ?? null;
  if (!parsed || parsed.valid !== true) return null;
  const op = String(parsed.op ?? '').toLowerCase();
  const tokenId = String(parsed.id ?? parsed.token_id ?? parsed.tokenId ?? '');
  const amount = String(parsed.amt ?? parsed.amount ?? '');
  if (op !== 'transfer' || !tokenId || !/^\d+$/.test(amount)) return null;
  return {
    tokenId,
    amount,
    symbol: String(parsed.sym ?? parsed.symbol ?? ''),
    decimals: Number.isInteger(Number(parsed.dec)) ? Math.max(0, Math.min(18, Number(parsed.dec))) : 0,
    op,
    valid: parsed.valid === true,
  };
}

function summarizeTransaction(tx) {
  const outputs = Array.isArray(tx.outputs) ? tx.outputs : [];
  const tokenOutputs = outputs.flatMap(output => {
    const token = extractBsv21(output);
    return token ? [{ vout: Number(output.index), address: output.address || '', ...token }] : [];
  });
  const feeOutputs = outputs.filter(output => output.address === ADMIN_DISCOVERY_ADDRESS && Number(output.value) > 0);
  const adminFeeSats = feeOutputs.reduce((sum, output) => sum + Number(output.value || 0), 0);
  const peers = [...new Set((tx.inputs || []).map(input => input.address).filter(address => address && address !== ADMIN_DISCOVERY_ADDRESS))];
  const confirmed = tx.confirmed === true && Number(tx.block_height) > 0;
  const tokenIds = [...new Set(tokenOutputs.map(token => token.tokenId))];
  const isSettlementCandidate = confirmed && adminFeeSats > 0 && tokenOutputs.length > 0;
  return {
    txid: String(tx.txid || tx.hash || ''),
    blockHeight: Number(tx.block_height || 0),
    blockTime: Number(tx.block_time || 0),
    confirmed,
    anchorOutputSats: adminFeeSats,
    tokenIds,
    tokenOutputs,
    peerAddresses: peers,
    classification: isSettlementCandidate ? 'fee-linked-settlement-candidate' : tokenOutputs.length ? 'token-transfer' : 'admin-wallet-activity',
    evidence: isSettlementCandidate ? 'Confirmed tx pays the discovery address and has an indexed BSV-21 transfer; this is a candidate, not proof of trade intent.' : 'Confirmed transaction observed in discovery-address history; not classified as a settlement candidate.',
  };
}

function parseOrderAnnouncement(transaction) {
  const { Transaction } = require('@bsv/sdk');
  const tx = Transaction.fromHex(transaction);
  for (let vout = 0; vout < tx.outputs.length; vout++) {
    const scriptHex = tx.outputs[vout].lockingScript.toHex();
    if (!scriptHex.startsWith('006a')) continue;
    const bytes = Buffer.from(scriptHex, 'hex');
    let offset = 2;
    let length = bytes[offset++];
    if (length === 0x4c) length = bytes[offset++];
    else if (length === 0x4d) { length = bytes.readUInt16LE(offset); offset += 2; }
    else if (length > 75) continue;
    if (offset + length > bytes.length) continue;
    try {
      const record = JSON.parse(bytes.subarray(offset, offset + length).toString('utf8'));
      if (record?.p === 'lbsx') return record;
    } catch (_) { /* Other applications use OP_RETURN on the same chain. */ }
  }
  return null;
}

async function verifyLiveSellOrder(txid, transaction, record, confirmed, { refresh = true, outputSpent = null, blockHeight = null } = {}) {
  if (!confirmed || record.v !== 1 || record.op !== 'sell' || record.net !== 'main' || record.anchor !== ADMIN_DISCOVERY_ADDRESS) return null;
  if (!/^[0-9a-f]{64}_[0-9]+$/i.test(String(record.id)) || !/^\d+$/.test(String(record.amt)) || BigInt(record.amt) <= 0n) return null;
  if (!Number.isSafeInteger(Number(record.price)) || Number(record.price) < 100 || !/^[0-9a-zA-Z]{26,62}$/.test(String(record.maker))) return null;
  if (!/^[0-9a-f]{64}[._:][0-9]+$/i.test(String(record.src)) || !Number.isInteger(Number(record.lock))) return null;
  const { Transaction, P2PKH } = require('@bsv/sdk');
  const { BSV21, OrdLockV2 } = await import('@1sat/templates');
  const parsed = Transaction.fromHex(transaction);
  const [sourceTxid, sourceVoutText] = String(record.src).split(/[._:]/);
  const sourceVout = Number(sourceVoutText);
  if (!parsed.inputs.some(input => String(input.sourceTXID).toLowerCase() === sourceTxid.toLowerCase() && Number(input.sourceOutputIndex) === sourceVout)) return null;
  const discoveryScript = new P2PKH().lock(ADMIN_DISCOVERY_ADDRESS).toHex();
  if (!parsed.outputs.some(output => Number(output.satoshis) >= 1 && output.lockingScript.toHex() === discoveryScript)) return null;
  const output = parsed.outputs[Number(record.lock)];
  if (!output) return null;
  const token = BSV21.decode(output.lockingScript);
  const lock = OrdLockV2.decode(output.lockingScript);
  if (!token || !lock || token.getTokenId() !== record.id || token.getAmount() !== BigInt(record.amt)) return null;
  if (lock.seller !== record.maker || Number(lock.price) !== Number(record.price)) return null;
  const outpoint = `${txid}.${Number(record.lock)}`;
  if (outputSpent === true) return null;
  let unspent = false;
  if (!refresh) {
    if (outputSpent !== false) return null;
    unspent = true;
  } else {
    const cached = spendStatusCache.get(outpoint);
    if (cached && Date.now() - cached.checkedAt < 15000) unspent = cached.unspent;
    else {
      const txo = await fetchJson(`${BB_API}/txo/${txid}/${Number(record.lock)}`);
      unspent = txo?.spent === false;
      spendStatusCache.set(outpoint, { unspent, checkedAt: Date.now() });
      if (spendStatusCache.size > 1000) spendStatusCache.delete(spendStatusCache.keys().next().value);
    }
  }
  if (!unspent) return null;
  return { outpoint, txid, tokenId: record.id, amountBase: String(record.amt), priceSats: Number(record.price), sellerAddress: record.maker, sourceOutpoint: record.src, blockHeight };
}

async function verifyLiveCancelOrder(txid, transaction, record, confirmed) {
  if (!confirmed || record.v !== 1 || record.op !== 'cancel' || record.net !== 'main' || record.anchor !== ADMIN_DISCOVERY_ADDRESS) return null;
  if (!/^[0-9a-f]{64}_[0-9]+$/i.test(String(record.id)) || !/^\d+$/.test(String(record.amt)) || BigInt(record.amt) <= 0n) return null;
  if (!/^[0-9a-zA-Z]{26,62}$/.test(String(record.maker))) return null;
  if (!/^[0-9a-f]{64}[._:][0-9]+$/i.test(String(record.src)) || !Number.isInteger(Number(record.lock))) return null;
  const { Transaction, P2PKH } = require('@bsv/sdk');
  const { BSV21 } = await import('@1sat/templates');
  const parsed = Transaction.fromHex(transaction);
  const [sourceTxid, sourceVoutText] = String(record.src).split(/[._:]/);
  const sourceVout = Number(sourceVoutText);
  if (!parsed.inputs.some(input => String(input.sourceTXID).toLowerCase() === sourceTxid.toLowerCase() && Number(input.sourceOutputIndex) === sourceVout)) return null;
  const discoveryScript = new P2PKH().lock(ADMIN_DISCOVERY_ADDRESS).toHex();
  if (!parsed.outputs.some(output => Number(output.satoshis) >= 1 && output.lockingScript.toHex() === discoveryScript)) return null;
  const output = parsed.outputs[Number(record.lock)];
  if (!output) return null;
  const token = BSV21.decode(output.lockingScript);
  if (!token || token.getOperation() !== 'transfer' || token.getTokenId() !== record.id || token.getAmount() !== BigInt(record.amt)) return null;
  const expectedScript = BSV21.transfer(record.id, BigInt(record.amt)).lock(new P2PKH().lock(record.maker)).toHex();
  if (output.lockingScript.toHex() !== expectedScript) return null;
  return { cancelledOutpoint: `${sourceTxid}.${sourceVout}`, txid, tokenId: record.id, amountBase: String(record.amt), maker: record.maker };
}

async function verifyLiveBuyOrder(txid, transaction, record, confirmed) {
  if (!confirmed || record.v !== 1 || record.op !== 'buy' || record.net !== 'main' || record.anchor !== ADMIN_DISCOVERY_ADDRESS) return null;
  if (!/^[0-9a-f]{64}_[0-9]+$/i.test(String(record.id)) || !/^\d+$/.test(String(record.amt)) || BigInt(record.amt) <= 0n) return null;
  if (!Number.isSafeInteger(Number(record.price)) || Number(record.price) < 100 || !/^[0-9a-zA-Z]{26,62}$/.test(String(record.buyer))) return null;
  if (!/^[0-9a-f]{64}[._:][0-9]+$/i.test(String(record.src)) || !Number.isInteger(Number(record.receive))) return null;
  const { Transaction, P2PKH } = require('@bsv/sdk');
  const { BSV21 } = await import('@1sat/templates');
  const parsed = Transaction.fromHex(transaction);
  const [sourceTxid, sourceVoutText] = String(record.src).split(/[._:]/);
  const sourceVout = Number(sourceVoutText);
  if (!parsed.inputs.some(input => String(input.sourceTXID).toLowerCase() === sourceTxid.toLowerCase() && Number(input.sourceOutputIndex) === sourceVout)) return null;
  const discoveryScript = new P2PKH().lock(ADMIN_DISCOVERY_ADDRESS).toHex();
  const requiredAdminSats = Math.max(1, Math.ceil(Number(record.price) / 100)) + 10000;
  const paidAdminSats = parsed.outputs
    .filter(output => output.lockingScript.toHex() === discoveryScript)
    .reduce((sum, output) => sum + Number(output.satoshis || 0), 0);
  if (paidAdminSats < requiredAdminSats) return null;
  const output = parsed.outputs[Number(record.receive)];
  if (!output || Number(output.satoshis) !== 1) return null;
  const expectedScript = BSV21.transfer(record.id, BigInt(record.amt)).lock(new P2PKH().lock(record.buyer)).toHex();
  if (output.lockingScript.toHex() !== expectedScript) return null;
  return { txid, tokenId: record.id, amountBase: String(record.amt), priceSats: Number(record.price), buyer: record.buyer, sourceOutpoint: `${sourceTxid}.${sourceVout}` };
}

async function buildTradingDiscoverySnapshot(index, refreshLiveListings) {
  const rows = index.transactions.map(transaction => summarizeTransaction({
    ...transaction.details,
    txid: transaction.txid,
    block_height: transaction.blockHeight,
    block_time: transaction.blockTime,
    confirmed: transaction.confirmed,
  })).filter(row => row.txid);
  const discoveredOrders = [];
  const discoveredPurchases = [];
  const cancelledOutpoints = new Set();
  const errors = [...(index.errors || [])];
  for (const transaction of index.transactions) {
    if (!transaction.rawTxHex) continue;
    const announcement = parseOrderAnnouncement(transaction.rawTxHex);
    if (!announcement) continue;
    try {
      if (announcement.op === 'cancel') {
        const cancellation = await verifyLiveCancelOrder(
          transaction.txid,
          transaction.rawTxHex,
          announcement,
          transaction.confirmed,
        );
        if (cancellation) cancelledOutpoints.add(cancellation.cancelledOutpoint);
        continue;
      }
      if (announcement.op === 'buy') {
        const purchase = await verifyLiveBuyOrder(
          transaction.txid,
          transaction.rawTxHex,
          announcement,
          transaction.confirmed,
        );
        if (purchase) discoveredPurchases.push(purchase);
        continue;
      }
      const order = await verifyLiveSellOrder(
        transaction.txid,
        transaction.rawTxHex,
        announcement,
        transaction.confirmed,
        {
          refresh: refreshLiveListings,
          outputSpent: transaction.details?.outputs?.[Number(announcement.lock)]?.spent,
          blockHeight: transaction.blockHeight,
        },
      );
      if (order) discoveredOrders.push(order);
    } catch (error) {
      errors.push(`Listing ${transaction.txid.slice(0, 10)} could not be checked for spends: ${error.message}`);
    }
  }
  const liveOrders = discoveredOrders.filter(order => !cancelledOutpoints.has(order.outpoint)
    && !discoveredPurchases.some(purchase => purchase.sourceOutpoint === order.outpoint));
  const tradeRows = rows.filter(row => row.classification === 'fee-linked-settlement-candidate');
  const markets = new Map();
  for (const row of tradeRows) {
    for (const tokenId of row.tokenIds) {
      const tokenMeta = row.tokenOutputs.find(token => token.tokenId === tokenId);
      const prior = markets.get(tokenId) || {
        tokenId,
        symbol: tokenMeta?.symbol || '',
        name: tokenMeta?.symbol || tokenId,
        decimals: tokenMeta?.decimals || 0,
        confirmedSettlements: 0,
        latestBlockHeight: 0,
        peerAddresses: new Set(),
      };
      if (!prior.symbol && tokenMeta?.symbol) prior.symbol = tokenMeta.symbol;
      if (!prior.decimals && tokenMeta?.decimals) prior.decimals = tokenMeta.decimals;
      prior.confirmedSettlements += 1;
      prior.latestBlockHeight = Math.max(prior.latestBlockHeight, row.blockHeight);
      row.peerAddresses.forEach(address => prior.peerAddresses.add(address));
      markets.set(tokenId, prior);
    }
  }
  const marketRows = [...markets.values()].map(market => ({ ...market, peerAddresses: [...market.peerAddresses] }));
  return {
    address: ADMIN_DISCOVERY_ADDRESS,
    source: index.source,
    syncedAt: index.syncedAt,
    lastScannedTxid: index.lastScannedTxid,
    historyComplete: index.historyComplete,
    scannedTransactions: index.scannedTransactions,
    lookupFailures: index.lookupFailures,
    status: index.status || null,
    errors,
    transactions: rows.sort((a, b) => b.blockHeight - a.blockHeight || b.blockTime - a.blockTime),
    discoveredOrders: [...new Map(liveOrders.map(order => [order.outpoint, order])).values()],
    cancelledOrders: [...cancelledOutpoints],
    discoveredPurchases,
    markets: marketRows.sort((a, b) => b.latestBlockHeight - a.latestBlockHeight),
    note: 'Admin-wallet history and BEEF proofs are stored in this wallet’s encrypted local index. Listings are rechecked for current spend status before display.',
  };
}

async function syncTradingDiscovery(walletAddress) {
  const index = await syncAdminWalletIndex(walletAddress);
  return buildTradingDiscoverySnapshot(index, true);
}

async function getTradingDiscoveryCache(walletAddress) {
  const index = await getAdminWalletIndex(walletAddress);
  return buildTradingDiscoverySnapshot(index, false);
}

module.exports = {
  ADMIN_DISCOVERY_ADDRESS,
  syncTradingDiscovery,
  getTradingDiscoveryCache,
  parseOrderAnnouncement,
  verifyLiveSellOrder,
  verifyLiveCancelOrder,
  verifyLiveBuyOrder,
  _test: { summarizeTransaction, extractBsv21 },
};
