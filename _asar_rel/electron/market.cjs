const bsvSdk = require('@bsv/sdk');
const { fetchSpendableTokenOutput, broadcastRawHex } = require('./token-wallet.cjs')._market;
const { bananaBlocksFetch } = require('./bananablocks.cjs');
const {
  cacheVerifiedBsvUtxos,
  getWalletData,
  getSpendableBsvUtxos,
  getSpendableUtxoBlocklist,
} = require('./wallet-data.cjs');
const { broadcastTrackedTransaction, reconcileDefinitivelyRejectedTransactions } = require('./transaction-tracker.cjs');
const { ADMIN_DISCOVERY_ADDRESS } = require('./constants.cjs');
const { ensureHeaderChain, verifyTransactionProof } = require('./spv.cjs');
const { syncAdminWalletIndex } = require('./admin-wallet-index.cjs');

const { Transaction, PrivateKey, P2PKH, Script, LockingScript } = bsvSdk;
const BB_API = 'https://bananablocks.com/api/v1';
const TXID_RE = /^[0-9a-f]{64}$/i;
// Indexing fee paid to the admin wallet when a sell order is listed.
const ADMIN_LISTING_FEE_SATS = 10000;
// Indexing fee paid to the admin wallet when a sell order is cancelled.
const ADMIN_CANCEL_FEE_SATS = 10000;
const ADMIN_BUY_SERVICE_FEE_SATS = 10000;
const transactionCache = new Map();
const listingSpendCache = new Map();

async function json(url) {
  const response = await bananaBlocksFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Indexer returned HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { throw new Error('Indexer returned an unreadable response.'); }
}

function parseOutpoint(value) {
  const match = String(value || '').match(/^([0-9a-f]{64})[._:]([0-9]+)$/i);
  if (!match) throw new Error('The listing has an invalid outpoint.');
  return { txid: match[1].toLowerCase(), vout: Number(match[2]), canonical: `${match[1].toLowerCase()}.${Number(match[2])}` };
}

function normalizeTokenId(value) {
  const match = String(value || '').trim().match(/^([0-9a-f]{64})(?:_([0-9]+))?$/i);
  if (!match) throw new Error('This token does not have a valid BSV-21 origin.');
  return `${match[1].toLowerCase()}_${match[2] ?? '1'}`;
}

async function transactionFor(txid) {
  if (!TXID_RE.test(txid)) throw new Error('The transaction id is invalid.');
  const cached = transactionCache.get(txid.toLowerCase());
  if (cached) return cached;
  const response = await bananaBlocksFetch(`${BB_API}/bsv/main/tx/${txid}/hex`, { headers: { Accept: 'text/plain' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Could not retrieve transaction ${txid.slice(0, 10)}… (${response.status}).`);
  const hex = (await response.text()).trim();
  try {
    const tx = Transaction.fromHex(hex);
    transactionCache.set(txid.toLowerCase(), tx);
    if (transactionCache.size > 500) transactionCache.delete(transactionCache.keys().next().value);
    return tx;
  } catch { throw new Error('The indexer returned an invalid parent transaction.'); }
}

async function verifiedTransactionFor(address, txid, blockHeight = 0) {
  const state = await ensureHeaderChain(address);
  const proof = await verifyTransactionProof(address, txid, blockHeight, state);
  try { return Transaction.fromHex(proof.rawTxHex); }
  catch { throw new Error('The verified BEEF proof contained an invalid transaction.'); }
}

function addP2pkhInput(tx, key, sourceTx, vout) {
  const sourceOutput = sourceTx.outputs[vout];
  if (!sourceOutput || !Number.isSafeInteger(sourceOutput.satoshis)) throw new Error('A funding output is missing or has an invalid value.');
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: vout,
    unlockingScriptTemplate: new P2PKH().unlock(key, 'all', false, sourceOutput.satoshis, sourceOutput.lockingScript),
  });
}

async function fetchFeeCandidates(address, minimum = 4000) {
  const expected = new P2PKH().lock(address).toHex();
  const blocked = await getSpendableUtxoBlocklist(address);
  const cached = await getSpendableBsvUtxos(address);
  const walletData = await getWalletData(address);
  const local = [];
  let localTotal = 0;
  for (const row of cached) {
    if (blocked.has(`${row.txid}.${row.vout}`) || row.scriptHex !== expected) continue;
    try {
      const sourceTx = Transaction.fromHex(row.rawTxHex);
      const output = sourceTx.outputs[row.vout];
      if (!output || Number(output.satoshis) !== row.satoshis || output.lockingScript.toHex() !== expected) continue;
      local.push({ txid: row.txid, vout: row.vout, satoshis: row.satoshis, sourceTx, cached: true });
      localTotal += row.satoshis;
    } catch {}
  }
  local.sort((a, b) => b.satoshis - a.satoshis);
  if (localTotal >= minimum) return local;

  const tracked = (walletData.observedBsvUtxos || [])
    .map(row => ({
      txid: String(row.txid || '').toLowerCase(),
      vout: Number(row.vout),
      satoshis: Number(row.satoshis),
      blockHeight: Number(row.height ?? row.blockHeight ?? 0),
    }))
    .filter(row => TXID_RE.test(row.txid)
      && Number.isInteger(row.vout) && row.vout >= 0
      && Number.isSafeInteger(row.satoshis) && row.satoshis > 1
      && Number.isSafeInteger(row.blockHeight) && row.blockHeight > 0
      && !blocked.has(`${row.txid}.${row.vout}`)
      && !local.some(item => item.txid === row.txid && item.vout === row.vout));

  const rows = await json(`${BB_API}/bsv/main/address/${encodeURIComponent(address)}/unspent?limit=500`);
  const items = Array.isArray(rows) ? rows : (rows?.items || []);
  const candidates = items
    .filter(row => row?.tx_hash && TXID_RE.test(String(row.tx_hash)) && Number.isInteger(Number(row.tx_pos)) && Number(row.value) > 1 && !row.spent && !row.spent_txid)
    .filter(row => Number(row.height ?? row.block_height ?? 0) > 0
      && !blocked.has(`${String(row.tx_hash).toLowerCase()}.${Number(row.tx_pos)}`)
      && !local.some(item => item.txid === String(row.tx_hash).toLowerCase() && item.vout === Number(row.tx_pos))
      && !tracked.some(item => item.txid === String(row.tx_hash).toLowerCase() && item.vout === Number(row.tx_pos)))
    .map(row => ({
      txid: String(row.tx_hash).toLowerCase(),
      vout: Number(row.tx_pos),
      satoshis: Number(row.value),
      blockHeight: Number(row.height ?? row.block_height ?? 0),
    }))
    .filter(row => Number.isSafeInteger(row.satoshis))
    .sort((a, b) => a.satoshis - b.satoshis);
  if (process.env.LBSX_DEBUG_MARKET === '1') console.log('Fee candidate rows:', items.length, 'usable:', candidates.length);
  return [...local, ...tracked, ...candidates];
}

async function checkedFeeInputs(address, candidates, target, excluded = new Set()) {
  const selected = [];
  const newlyVerified = [];
  let total = 0;
  let checks = 0;
  const needsRemoteProof = candidates.some(item => !item.cached && !excluded.has(`${item.txid}.${item.vout}`));
  const headerState = needsRemoteProof ? await ensureHeaderChain(address) : null;
  for (const item of candidates) {
    const outpoint = `${item.txid}.${item.vout}`;
    if (excluded.has(outpoint)) continue;
    if (++checks > 100) break;
    try {
      let txo = null;
      let spend = null;
      let proof = null;
      let sourceTx = item.sourceTx || null;
      if (!item.cached) {
        [txo, spend, proof] = await Promise.all([
          json(`${BB_API}/txo/${item.txid}/${item.vout}`),
          json(`${BB_API}/txo/${item.txid}/${item.vout}/spend`),
          verifyTransactionProof(address, item.txid, item.blockHeight || 0, headerState),
        ]);
        sourceTx = Transaction.fromHex(proof.rawTxHex);
      }
      const output = sourceTx.outputs[item.vout];
      if ((!item.cached && (txo?.spent || txo?.spend_unknown === true || txo?.unknown === true
        || spend?.spent || spend?.spend_unknown === true || spend?.unknown === true
        || txo?.script_type !== 'p2pkh' || txo?.address !== address))
        || !output || output.satoshis !== item.satoshis) continue;
      const expected = new P2PKH().lock(address).toHex();
      if (output.lockingScript.toHex() !== expected) continue;
      selected.push({ ...item, sourceTx });
      total += item.satoshis;
      if (!item.cached) newlyVerified.push({
        txid: item.txid,
        vout: item.vout,
        satoshis: item.satoshis,
        scriptHex: expected,
        rawTxHex: sourceTx.toHex(),
        spvVerified: true,
        blockHeight: proof.blockHeight,
        blockHash: proof.blockHash,
      });
      if (total >= target) break;
    } catch (error) { if (process.env.LBSX_DEBUG_MARKET === '1') console.warn('Skipping fee candidate', outpoint, error.message); }
  }
  await cacheVerifiedBsvUtxos(address, newlyVerified);
  if (total < target) throw new Error(`Not enough confirmed ordinary BSV UTXOs. Need at least ${target} sats plus the transaction fee.`);
  return selected;
}

function orderAnnouncementFromTransaction(tx) {
  for (const output of tx.outputs) {
    const hex = output.lockingScript.toHex();
    if (!hex.startsWith('006a')) continue;
    const bytes = Buffer.from(hex, 'hex');
    let offset = 2;
    let length = bytes[offset++];
    if (length === 0x4c) length = bytes[offset++];
    else if (length === 0x4d) { length = bytes.readUInt16LE(offset); offset += 2; }
    else if (length > 75) continue;
    if (offset + length > bytes.length) continue;
    try {
      const record = JSON.parse(bytes.subarray(offset, offset + length).toString('utf8'));
      if (record?.p === 'lbsx') return record;
    } catch { /* Ignore unrelated or malformed OP_RETURN data. */ }
  }
  return null;
}

async function listingIsUnspent(txid, vout) {
  const outpoint = `${txid}.${vout}`;
  const cached = listingSpendCache.get(outpoint);
  if (cached && Date.now() - cached.checkedAt < 15000) return cached.unspent;
  const txo = await json(`${BB_API}/txo/${txid}/${vout}`);
  const unspent = txo?.spent === false;
  listingSpendCache.set(outpoint, { unspent, checkedAt: Date.now() });
  if (listingSpendCache.size > 1000) listingSpendCache.delete(listingSpendCache.keys().next().value);
  return unspent;
}

async function lbsxListingRows(tokenId, walletAddress) {
  const index = await syncAdminWalletIndex(walletAddress);
  const walletData = await getWalletData(walletAddress);
  const rowsByTxid = new Map();
  for (const transaction of walletData.transactions || []) {
    if (!transaction.rawTxHex || !['pending', 'broadcasting', 'broadcast-uncertain', 'confirmed'].includes(transaction.status)) continue;
    rowsByTxid.set(transaction.txid, {
      txid: transaction.txid,
      blockHeight: Number(transaction.blockHeight || 0),
      confirmed: Number(transaction.blockHeight || 0) > 0 || transaction.status === 'confirmed',
      rawTxHex: transaction.rawTxHex,
      details: {},
    });
  }
  for (const transaction of index.transactions) rowsByTxid.set(transaction.txid, transaction);
  const candidates = [];
  const consumedOutpoints = new Set();
  for (const row of rowsByTxid.values()) {
    if (!row.rawTxHex) continue;
    try {
      const spendTx = Transaction.fromHex(row.rawTxHex);
      const spendRecord = orderAnnouncementFromTransaction(spendTx);
      if (spendRecord?.p === 'lbsx' && (spendRecord.op === 'buy' || spendRecord.op === 'cancel')
        && spendRecord.anchor === ADMIN_DISCOVERY_ADDRESS) {
        const spent = parseOutpoint(spendRecord.src);
        if (spendTx.inputs.some(input => String(input.sourceTXID).toLowerCase() === spent.txid
          && Number(input.sourceOutputIndex) === spent.vout)) consumedOutpoints.add(spent.canonical);
      }
    } catch { /* Ignore malformed announcements. */ }
  }
  for (const row of rowsByTxid.values()) {
    if (!row.rawTxHex) continue;
    const tx = Transaction.fromHex(row.rawTxHex);
    const record = orderAnnouncementFromTransaction(tx);
    if (!record || record.v !== 1 || record.op !== 'sell' || record.net !== 'main'
      || record.anchor !== ADMIN_DISCOVERY_ADDRESS || record.id !== tokenId
      || !/^\d+$/.test(String(record.amt)) || BigInt(record.amt) <= 0n
      || !Number.isSafeInteger(Number(record.price)) || Number(record.price) < 100
      || !/^[0-9a-zA-Z]{26,62}$/.test(String(record.maker))
      || !Number.isInteger(Number(record.lock))) continue;
    const source = parseOutpoint(record.src);
    if (!tx.inputs.some(input => String(input.sourceTXID).toLowerCase() === source.txid
      && Number(input.sourceOutputIndex) === source.vout)) continue;
    const discoveryScript = new P2PKH().lock(ADMIN_DISCOVERY_ADDRESS).toHex();
    if (!tx.outputs.some(output => output.satoshis >= 1 && output.lockingScript.toHex() === discoveryScript)) continue;
    const vout = Number(record.lock);
    if (consumedOutpoints.has(`${row.txid}.${vout}`)) continue;
    const output = tx.outputs[vout];
    if (!output) continue;
    const { BSV21, OrdLockV2 } = await import('@1sat/templates');
    const token = BSV21.decode(output.lockingScript);
    const lock = OrdLockV2.decode(output.lockingScript);
    if (!token || token.getOperation() !== 'transfer' || token.getTokenId() !== tokenId
      || token.getAmount() !== BigInt(record.amt) || !lock
      || lock.seller !== record.maker || Number(lock.price) !== Number(record.price)) continue;
    candidates.push({ row, tx, record, vout, output });
  }

  const discovered = [];
  for (let offset = 0; offset < candidates.length; offset += 8) {
    const batch = candidates.slice(offset, offset + 8);
    const results = await Promise.all(batch.map(async ({ row, record, vout, output }) => {
      if (!await listingIsUnspent(row.txid, vout)) return null;
      return {
        outpoint: `${row.txid}.${vout}`,
        txid: row.txid,
        vout,
        tokenId,
        amountBase: String(record.amt),
        priceSats: Number(record.price),
        sellerAddress: record.maker,
        scriptHex: output.lockingScript.toHex(),
        satoshis: output.satoshis,
        score: 0,
        status: row.confirmed ? 'confirmed' : 'pending',
        blockHeight: row.blockHeight,
      };
    }));
    discovered.push(...results.filter(Boolean));
  }
  return discovered;
}

async function getTokenSellQuote(privateKey, rawTokenId) {
  const tokenId = normalizeTokenId(rawTokenId);
  const address = privateKey.toAddress().toString();
  const token = await fetchSpendableTokenOutput(address, tokenId);
  return { tokenId, outpoint: `${token.txid}.${token.vout}`, amountBase: String(token.amount), carrierSats: token.satoshis };
}

async function getTokenMarketInfo(rawTokenId) {
  const tokenId = normalizeTokenId(rawTokenId);
  const response = await json(`${BB_API}/token/${encodeURIComponent(tokenId)}`);
  const detail = response?.result || response?.token || response;
  const returnedId = String(detail?.id ?? detail?.token_id ?? tokenId);
  if (returnedId !== tokenId) throw new Error('BananaBlocks returned metadata for a different token ID.');
  const decimals = Number(detail?.decimals ?? 0);
  const rawIcon = String(detail?.icon || '').trim();
  const icon = /^_[0-9]+$/.test(rawIcon)
    ? `${tokenId.split('_')[0]}${rawIcon}`
    : /^[0-9a-f]{64}_[0-9]+$/i.test(rawIcon) ? rawIcon.toLowerCase() : null;
  return {
    tokenId,
    symbol: String(detail?.symbol || detail?.ticker || tokenId),
    name: String(detail?.name || detail?.symbol || tokenId),
    decimals: Number.isInteger(decimals) ? Math.min(18, Math.max(0, decimals)) : 0,
    balance: '0',
    ...(icon ? { icon } : {}),
  };
}

async function getTokenOrderBook(rawTokenId, walletAddress) {
  const tokenId = normalizeTokenId(rawTokenId);
  const listings = await lbsxListingRows(tokenId, walletAddress);
  listings.sort((a, b) => a.priceSats - b.priceSats || b.score - a.score);
  return {
    tokenId,
    syncedAt: new Date().toISOString(),
    asks: listings,
    myOrders: listings.filter(row => row.sellerAddress === walletAddress),
  };
}

async function buildAndBroadcastList(privateKey, payload = {}) {
  const tokenId = normalizeTokenId(payload.tokenId);
  const priceSats = Number(payload.priceSats);
  if (!Number.isSafeInteger(priceSats) || priceSats < 100) throw new Error('Enter a listing price of at least 100 satoshis.');
  const address = privateKey.toAddress().toString();
  const tokenUtxo = await fetchSpendableTokenOutput(address, tokenId);
  if (!/^\d+$/.test(String(payload.amountBase ?? ''))) throw new Error('Enter a valid token amount to list.');
  const amountBase = BigInt(payload.amountBase);
  if (amountBase <= 0n || amountBase > tokenUtxo.amount) throw new Error('The listing amount must be greater than zero and no larger than the spendable token output.');
  const tokenChange = tokenUtxo.amount - amountBase;
  const sourceTx = tokenUtxo.rawTxHex ? Transaction.fromHex(tokenUtxo.rawTxHex) : await transactionFor(tokenUtxo.txid);
  const { OrdLockV2, BSV21 } = await import('@1sat/templates');
  const sdkKey = PrivateKey.fromHex(privateKey.toBuffer().toString('hex'));
  const p2pkh = new P2PKH();
  const tx = new Transaction();
  addP2pkhInput(tx, sdkKey, sourceTx, tokenUtxo.vout);
  const lock = OrdLockV2.lock(address, address, priceSats);
  const ordLockScript = new LockingScript(lock.chunks);
  const listedTokenScript = BSV21.transfer(tokenId, amountBase).lock(ordLockScript);
  tx.addOutput({ lockingScript: listedTokenScript, satoshis: 1 });
  let changeVout = null;
  if (tokenChange > 0n) {
    changeVout = tx.outputs.length;
    const changeScript = BSV21.transfer(tokenId, tokenChange).lock(new P2PKH().lock(address));
    tx.addOutput({ lockingScript: changeScript, satoshis: 1 });
  }
  // OP_RETURN is transaction metadata, not an output payable to an address.
  // Pay the indexing fee in the same transaction so address-history indexers can
  // discover and then parse this order announcement.
  tx.addP2PKHOutput(ADMIN_DISCOVERY_ADDRESS, ADMIN_LISTING_FEE_SATS);
  const announcement = {
    p: 'lbsx',
    v: 1,
    op: 'sell',
    net: 'main',
    id: tokenId,
    amt: String(amountBase),
    price: priceSats,
    maker: address,
    src: `${tokenUtxo.txid}.${tokenUtxo.vout}`,
    lock: 0,
    change: changeVout,
    anchor: ADMIN_DISCOVERY_ADDRESS,
  };
  const metadata = Buffer.from(JSON.stringify(announcement), 'utf8');
  if (metadata.length > 500) throw new Error('The on-chain order announcement exceeds the safe metadata size.');
  const pushPrefix = metadata.length <= 75
    ? Buffer.from([metadata.length])
    : metadata.length <= 255
      ? Buffer.from([0x4c, metadata.length])
      : Buffer.from([0x4d, metadata.length & 0xff, metadata.length >> 8]);
  const opReturn = Buffer.concat([Buffer.from([0x00, 0x6a]), pushPrefix, metadata]);
  tx.addOutput({ lockingScript: Script.fromBinary(opReturn), satoshis: 0 });
  // Give fee() a real change destination. Without this marked change output,
  // the SDK adds leftover sats to the final output (the zero-sat OP_RETURN),
  // which a relay may reject as an invalid output.
  tx.addP2PKHOutput(address);
  const feeInputs = await checkedFeeInputs(address, await fetchFeeCandidates(address, ADMIN_LISTING_FEE_SATS + 4000), ADMIN_LISTING_FEE_SATS + 4000);
  for (const input of feeInputs) addP2pkhInput(tx, sdkKey, input.sourceTx, input.vout);
  await tx.fee(1000);
  await tx.sign();
  const txid = tx.id('hex').toLowerCase();
  await broadcastTrackedTransaction({
    address,
    txid,
    rawHex: tx.toHex(),
    type: 'token-list',
    inputOutpoints: [`${tokenUtxo.txid}.${tokenUtxo.vout}`, ...feeInputs.map(input => `${input.txid}.${input.vout}`)],
    details: { title: 'BSV-21 sell listing created', tokenId, tokenAmount: String(amountBase), decimals: Number(payload.decimals || 0), symbol: String(payload.symbol || '') },
    broadcast: () => broadcastRawHex(tx.toHex(), txid),
  });
  return { txid, outpoint: `${txid}.0`, tokenId, amountBase: String(amountBase), changeAmountBase: String(tokenChange), changeOutpoint: changeVout === null ? null : `${txid}.${changeVout}`, priceSats, discoveryAddress: ADMIN_DISCOVERY_ADDRESS };
}

async function buildAndBroadcastBuy(privateKey, payload = {}) {
  const tokenId = normalizeTokenId(payload.tokenId);
  const target = parseOutpoint(payload.outpoint);
  const address = privateKey.toAddress().toString();
  const listing = (await lbsxListingRows(tokenId, address)).find(row => row.outpoint === target.canonical);
  if (!listing) throw new Error('This listing is no longer unspent in the BananaBlocks admin-wallet history. Refresh and try again.');
  if (listing.status !== 'confirmed') throw new Error('This listing is still unconfirmed. Wait for confirmation before buying.');
  if (listing.sellerAddress === address) throw new Error('You cannot buy your own listing. Cancel it or use another wallet.');

  const { OrdLockV2, BSV21 } = await import('@1sat/templates');
  const sdkKey = PrivateKey.fromHex(privateKey.toBuffer().toString('hex'));
  const p2pkh = new P2PKH();
  const paymentScript = p2pkh.lock(address);
  const tokenScript = BSV21.transfer(tokenId, BigInt(listing.amountBase)).lock(paymentScript);
  const listingTx = await verifiedTransactionFor(address, listing.txid, listing.blockHeight);
  const listingOutput = listingTx.outputs[listing.vout];
  const lock = OrdLockV2.decode(listingOutput.lockingScript);
  if (!lock) throw new Error('This listing is not a supported OrdLock v2 BSV-21 listing.');
  const price = Number(lock.price);
  const platformFeeSats = Math.max(1, Math.ceil(price / 100));
  const adminFeeSats = platformFeeSats + ADMIN_BUY_SERVICE_FEE_SATS;
  const feeReserveSats = adminFeeSats + 3000;
  await reconcileDefinitivelyRejectedTransactions(address);
  const candidates = await fetchFeeCandidates(address, price + feeReserveSats);
  const frontCandidates = candidates.filter(item => item.satoshis >= price);
  if (!frontCandidates.length) throw new Error('No single spendable BSV UTXO can cover this listing price.');
  const front = await checkedFeeInputs(address, frontCandidates, price, new Set());
  if (front.length !== 1) throw new Error('This listing price exceeds a single spendable BSV UTXO; consolidate BSV and retry.');
  const excluded = new Set(front.map(item => `${item.txid}.${item.vout}`));
  const trailingFees = await checkedFeeInputs(address, candidates, feeReserveSats, excluded);

  const receiveOutput = { lockingScript: tokenScript, satoshis: 1 };
  const plan = OrdLockV2.planPurchase({
    frontSatoshis: [front[0].satoshis],
    listings: [listingOutput.lockingScript],
    receives: [receiveOutput],
    cushionScript: paymentScript,
  });
  const tx = new Transaction();
  addP2pkhInput(tx, sdkKey, front[0].sourceTx, front[0].vout);
  tx.addInput({
    sourceTransaction: listingTx,
    sourceOutputIndex: listing.vout,
    unlockingScriptTemplate: OrdLockV2.purchaseListing(listingOutput.satoshis, listingOutput.lockingScript, {
      deliveries: [{ vout: plan.receiveVouts[0], lockingScript: tokenScript }],
    }),
  });
  for (const output of plan.outputs) tx.addOutput(output);
  tx.addP2PKHOutput(ADMIN_DISCOVERY_ADDRESS, adminFeeSats);
  const announcement = {
    p: 'lbsx',
    v: 1,
    op: 'buy',
    net: 'main',
    id: tokenId,
    amt: String(listing.amountBase),
    price,
    buyer: address,
    src: target.canonical,
    receive: plan.receiveVouts[0],
    anchor: ADMIN_DISCOVERY_ADDRESS,
  };
  const metadata = Buffer.from(JSON.stringify(announcement), 'utf8');
  if (metadata.length > 500) throw new Error('The on-chain purchase announcement exceeds the safe metadata size.');
  const pushPrefix = metadata.length <= 75
    ? Buffer.from([metadata.length])
    : metadata.length <= 255
      ? Buffer.from([0x4c, metadata.length])
      : Buffer.from([0x4d, metadata.length & 0xff, metadata.length >> 8]);
  const opReturn = Buffer.concat([Buffer.from([0x00, 0x6a]), pushPrefix, metadata]);
  tx.addOutput({ lockingScript: Script.fromBinary(opReturn), satoshis: 0 });
  tx.addP2PKHOutput(address);
  for (const input of trailingFees) addP2pkhInput(tx, sdkKey, input.sourceTx, input.vout);
  await tx.fee(1000);
  await tx.sign();
  const txid = tx.id('hex').toLowerCase();
  await broadcastTrackedTransaction({
    address,
    txid,
    rawHex: tx.toHex(),
    type: 'token-buy',
    inputOutpoints: [...front, ...trailingFees].map(input => `${input.txid}.${input.vout}`),
    details: { title: 'BSV-21 token purchased', tokenId, tokenAmount: listing.amountBase, decimals: Number(payload.decimals || 0), amountSats: price, adminFeeSats },
    broadcast: async () => {
      try {
        return await broadcastRawHex(tx.toHex(), txid);
      } catch (error) {
        try {
          const dir = require('path').join(require('os').tmpdir(), 'lbsx-failed-buys');
          require('fs').mkdirSync(dir, { recursive: true });
          require('fs').writeFileSync(require('path').join(dir, `${txid}.json`), JSON.stringify({
            rawHex: tx.toHex(),
            ef: tx.toHexEF(),
            error: String(error?.message || error),
          }));
        } catch { /* diagnostics only */ }
        throw error;
      }
    },
  });
  listingSpendCache.delete(target.canonical);
  return { txid, tokenId, amountBase: listing.amountBase, priceSats: price, outpoint: target.canonical };
}

async function buildAndBroadcastCancel(privateKey, payload = {}) {
  const tokenId = normalizeTokenId(payload.tokenId);
  const target = parseOutpoint(payload.outpoint);
  const address = privateKey.toAddress().toString();
  const listing = (await lbsxListingRows(tokenId, address)).find(row => row.outpoint === target.canonical);
  if (!listing) throw new Error('This order is already spent or is no longer visible in the BananaBlocks admin-wallet history.');
  if (listing.status !== 'confirmed') throw new Error('This listing is still unconfirmed. Wait for confirmation before cancelling.');
  if (listing.sellerAddress !== address) throw new Error('Only the owner of this listing can cancel it.');
  if (!/^\d+$/.test(listing.amountBase)) throw new Error('The indexer did not return the token amount for this listing.');
  const { OrdLockV2, BSV21 } = await import('@1sat/templates');
  const sdkKey = PrivateKey.fromHex(privateKey.toBuffer().toString('hex'));
  const listingTx = await verifiedTransactionFor(address, listing.txid, listing.blockHeight);
  const output = listingTx.outputs[listing.vout];
  const lock = OrdLockV2.decode(output.lockingScript);
  if (!lock || lock.seller !== address) throw new Error('The on-chain lock does not belong to this wallet.');
  const transfer = BSV21.transfer(tokenId, BigInt(listing.amountBase)).lock(new P2PKH().lock(address));
  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: listingTx,
    sourceOutputIndex: listing.vout,
    unlockingScriptTemplate: OrdLockV2.cancelListing(sdkKey, 'all', false, output.satoshis, output.lockingScript),
  });
  tx.addOutput({ lockingScript: transfer, satoshis: 1 });
  // Pay the indexing fee in the same transaction so address-history indexers can
  // discover and then parse this cancellation announcement.
  tx.addP2PKHOutput(ADMIN_DISCOVERY_ADDRESS, ADMIN_CANCEL_FEE_SATS);
  const announcement = {
    p: 'lbsx',
    v: 1,
    op: 'cancel',
    net: 'main',
    id: tokenId,
    amt: String(listing.amountBase),
    price: Number(lock.price),
    maker: address,
    src: `${target.txid}.${target.vout}`,
    lock: 0,
    anchor: ADMIN_DISCOVERY_ADDRESS,
  };
  const metadata = Buffer.from(JSON.stringify(announcement), 'utf8');
  if (metadata.length > 500) throw new Error('The on-chain order announcement exceeds the safe metadata size.');
  const pushPrefix = metadata.length <= 75
    ? Buffer.from([metadata.length])
    : metadata.length <= 255
      ? Buffer.from([0x4c, metadata.length])
      : Buffer.from([0x4d, metadata.length & 0xff, metadata.length >> 8]);
  const opReturn = Buffer.concat([Buffer.from([0x00, 0x6a]), pushPrefix, metadata]);
  tx.addOutput({ lockingScript: Script.fromBinary(opReturn), satoshis: 0 });
  // Give fee() a real change destination, and keep it last so leftover sats
  // never land on the zero-sat OP_RETURN.
  tx.addP2PKHOutput(address);
  const feeInputs = await checkedFeeInputs(address, await fetchFeeCandidates(address, ADMIN_CANCEL_FEE_SATS + 4000), ADMIN_CANCEL_FEE_SATS + 4000);
  for (const input of feeInputs) addP2pkhInput(tx, sdkKey, input.sourceTx, input.vout);
  await tx.fee(1000);
  await tx.sign();
  const txid = tx.id('hex').toLowerCase();
  await broadcastTrackedTransaction({
    address,
    txid,
    rawHex: tx.toHex(),
    type: 'token-cancel',
    inputOutpoints: [`${target.txid}.${target.vout}`, ...feeInputs.map(input => `${input.txid}.${input.vout}`)],
    details: { title: 'BSV-21 sell listing cancelled', tokenId, tokenAmount: listing.amountBase, decimals: Number(payload.decimals || 0) },
    broadcast: () => broadcastRawHex(tx.toHex(), txid),
  });
  listingSpendCache.delete(target.canonical);
  return { txid, tokenId, amountBase: listing.amountBase, outpoint: target.canonical };
}

module.exports = { ADMIN_DISCOVERY_ADDRESS, getTokenOrderBook, getTokenMarketInfo, getTokenSellQuote, buildAndBroadcastList, buildAndBroadcastBuy, buildAndBroadcastCancel };
