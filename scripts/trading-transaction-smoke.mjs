import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const spvTestMock = require('./spv-test-mock.cjs');
const sdk = require('@bsv/sdk');
const { Transaction, P2PKH } = sdk;
const ADMIN_DISCOVERY_ADDRESS = '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB';
const key = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 7));
const address = key.toAddress().toString();
const buyerKey = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 9));
const buyerAddress = buyerKey.toAddress().toString();
const tokenId = '9421c95ba7b6ffb518eae62b9c5b1650d28aacdc420a98f2abf25668c048c60d_0';
const txStore = new Map();
const spentOutpoints = new Set();
const adminTxIds = new Set();
const confirmedAdminTxIds = new Set();
const localWalletTransactions = [];
const feeRowsByAddress = new Map([[address, []], [buyerAddress, []]]);
const feeAddressByOutpoint = new Map();
const cachedUtxosByAddress = new Map();
const unspentRequestsByAddress = new Map();
let currentToken = null;
let activeListing = null;
let broadcastCount = 0;
let parentSequence = 0;

const makeSource = output => {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: String(++parentSequence).padStart(2, '0').repeat(32), sourceOutputIndex: 0, unlockingScript: new sdk.UnlockingScript() });
  tx.addOutput(output);
  txStore.set(tx.id('hex').toLowerCase(), tx);
  return tx;
};

const p2pkh = new P2PKH();
for (const owner of [address, buyerAddress]) {
  for (let i = 0; i < 8; i++) {
    const tx = makeSource({ lockingScript: p2pkh.lock(owner), satoshis: 50000 });
    const row = { tx_hash: tx.id('hex').toLowerCase(), tx_pos: 0, value: 50000, height: 900000 };
    feeRowsByAddress.get(owner).push(row);
    feeAddressByOutpoint.set(`${row.tx_hash}.${row.tx_pos}`, owner);
  }
}

const { BSV21, OrdLockV2 } = await import('@1sat/templates');
const seedToken = makeSource({ lockingScript: BSV21.transfer(tokenId, 500n).lock(p2pkh.lock(address)), satoshis: 1 });
currentToken = { txid: seedToken.id('hex').toLowerCase(), vout: 0, amount: 500n };

function response(data, status = 200, contentType = 'application/json') {
  return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': contentType } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const path = url.pathname;
  if (path.includes('/token/') && path.endsWith('/history')) {
    return response({ transfers: [{ txid: currentToken.txid, vout: currentToken.vout, to_address: address.slice(0, 21), amount: String(currentToken.amount) }] });
  }
  if (path.includes('/txo/') && path.endsWith('/spend')) {
    const [txid, vout] = path.split('/').slice(-3, -1);
    return response({ spent: spentOutpoints.has(`${txid}.${vout}`) });
  }
  if (path.includes('/txo/')) {
    const [txid, vout] = path.split('/').slice(-2);
    return response({ script_type: 'p2pkh', address: feeAddressByOutpoint.get(`${txid}.${vout}`) || address.slice(0, 21), spent: spentOutpoints.has(`${txid}.${vout}`) });
  }
  if (path.includes(`/address/${ADMIN_DISCOVERY_ADDRESS}/`) && (path.endsWith('/history') || path.endsWith('/unconfirmed/history'))) {
    const unconfirmed = path.endsWith('/unconfirmed/history');
    const refs = [...adminTxIds].filter(txid => confirmedAdminTxIds.has(txid) !== unconfirmed)
      .map(tx_hash => ({ tx_hash, height: confirmedAdminTxIds.has(tx_hash) ? 900000 : 0 }));
    return response(unconfirmed ? { result: refs, error: '' } : refs);
  }
  if (path.endsWith('/unspent')) {
    const owner = path.split('/').at(-2);
    unspentRequestsByAddress.set(owner, (unspentRequestsByAddress.get(owner) || 0) + 1);
    const free = (feeRowsByAddress.get(owner) || []).filter(row => !spentOutpoints.has(`${row.tx_hash}.${row.tx_pos}`));
    if (process.env.LBSX_DEBUG_MARKET === '1') console.log('Mock unspent request', path, free.length);
    return response(free);
  }
  if (path.startsWith('/api/v1/bsv/main/tx/') && path.endsWith('/hex')) {
    const txid = path.split('/').at(-2);
    const tx = txStore.get(txid);
    return tx ? response(tx.toHex(), 200, 'text/plain') : response('not found', 404, 'text/plain');
  }
  if (path.endsWith('/tx/broadcast') || path.endsWith('/bsv/main/tx/raw')) {
    const body = JSON.parse(init.body);
    const tx = Transaction.fromHex(body.rawtx || body.txhex);
    const txid = tx.id('hex').toLowerCase();
    assert.equal(txid, body.txid || txid);
    txStore.set(txid, tx);
    if (tx.outputs.some(output => output.lockingScript.toHex() === p2pkh.lock(ADMIN_DISCOVERY_ADDRESS).toHex())) adminTxIds.add(txid);
    for (const input of tx.inputs) spentOutpoints.add(`${input.sourceTXID}.${input.sourceOutputIndex}`);
    if (process.env.LBSX_DEBUG_MARKET === '1') console.log('Spent after broadcast:', [...spentOutpoints]);
    broadcastCount++;
    const { OrdLockV2 } = await import('@1sat/templates');
    const listingOutput = tx.outputs.find(output => OrdLockV2.decode(output.lockingScript));
    if (listingOutput) {
      const vout = tx.outputs.indexOf(listingOutput);
      const lock = OrdLockV2.decode(listingOutput.lockingScript);
      const listedToken = BSV21.decode(listingOutput.lockingScript);
      activeListing = {
        outpoint: `${txid}.${vout}`,
        score: Date.now() / 1000,
        data: { bsv21: { id: tokenId, op: 'transfer', amt: String(listedToken.getAmount()), sym: 'TST', dec: '0' }, ordlock: { price: Number(lock.price), seller: lock.seller } },
      };
    } else if (tx.inputs.length && activeListing && tx.inputs.some(input => `${input.sourceTXID}.${input.sourceOutputIndex}` === activeListing.outpoint) && tx.inputs.some(input => OrdLockV2.isCancel(input.unlockingScript))) {
      activeListing = null;
      const transfer = BSV21.decode(tx.outputs[0].lockingScript);
      assert(transfer, 'cancel/buy should preserve a BSV-21 transfer output');
      currentToken = { txid, vout: 0, amount: transfer.getAmount() };
    } else if (tx.inputs.length && tx.outputs.some(output => BSV21.decode(output.lockingScript))) {
      const received = tx.outputs.find(output => BSV21.decode(output.lockingScript));
      const transfer = BSV21.decode(received.lockingScript);
      currentToken = { txid, vout: tx.outputs.indexOf(received), amount: transfer.getAmount() };
      activeListing = null;
    }
    return response({ txid });
  }
  throw new Error(`Unexpected mock URL ${url}`);
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => process.cwd() }, safeStorage: { isEncryptionAvailable: () => false } };
  }
  if (request === './wallet-data.cjs') return {
    cacheVerifiedBsvUtxos: async () => {},
    cacheVerifiedTokenUtxos: async () => {},
    cacheVerifiedTokenUtxo: async () => {},
    getSpendableBsvUtxos: async owner => cachedUtxosByAddress.get(owner) || [],
    getWalletData: async owner => ({ transactions: localWalletTransactions.filter(row => row.address === owner) }),
    getSpendableTokenUtxos: async () => [],
    getSpendableUtxoBlocklist: async () => new Set(),
    getTrackedTransactionHex: async () => null,
  };
  if (request === './transaction-tracker.cjs') return {
    broadcastTrackedTransaction: async ({ address: owner, txid, rawHex, type, details, broadcast }) => {
      await broadcast();
      localWalletTransactions.push({ address: owner, txid, rawTxHex: rawHex, type, details, status: 'pending', blockHeight: 0 });
      return txid;
    },
    reconcileDefinitivelyRejectedTransactions: async () => [],
  };
  if (request === './admin-wallet-index.cjs') return {
    syncAdminWalletIndex: async () => ({
      address: ADMIN_DISCOVERY_ADDRESS,
      source: 'E2E fixture',
      syncedAt: new Date().toISOString(),
      lastScannedTxid: [...confirmedAdminTxIds].at(-1) || null,
      historyComplete: true,
      scannedTransactions: 0,
      lookupFailures: 0,
      errors: [],
      transactions: [...adminTxIds].map(txid => {
        const tx = txStore.get(txid);
        const confirmed = confirmedAdminTxIds.has(txid);
        return {
          txid,
          blockHeight: confirmed ? 900000 : 0,
          blockTime: 0,
          confirmed,
          rawTxHex: tx?.toHex() || null,
          details: {},
        };
      }).filter(row => row.rawTxHex),
    }),
  };
  if (request === './spv.cjs') return spvTestMock;
  return originalLoad.call(this, request, parent, isMain);
};
const market = require('../electron/market.cjs');
Module._load = originalLoad;
const book = await market.getTokenOrderBook(tokenId, address);
assert.equal(book.asks.length, 0, 'book begins empty');
const inactiveBook = await market.getTokenOrderBook(`${'22'.repeat(32)}_1`, address);
assert.equal(inactiveBook.asks.length, 0, 'inactive overlay token should appear as a valid empty order book');

const listed = await market.buildAndBroadcastList(key, { tokenId, amountBase: '500', priceSats: 5000 });
assert.match(listed.txid, /^[0-9a-f]{64}$/);
assert.equal(listed.amountBase, '500');
const listedTx = txStore.get(listed.txid);
const adminAnchor = listedTx.outputs.find(output => output.lockingScript.toHex() === p2pkh.lock(ADMIN_DISCOVERY_ADDRESS).toHex());
assert.equal(adminAnchor?.satoshis, 1, 'listing should include a 1-sat admin-wallet discovery anchor');
const announcementOutput = listedTx.outputs.find(output => output.lockingScript.toHex().startsWith('006a'));
assert(announcementOutput, 'listing should carry an OP_RETURN discovery record');
assert.equal(announcementOutput.satoshis, 0, 'OP_RETURN must remain a zero-satoshi output after fee calculation');
const sellerChange = listedTx.outputs.find(output => output.lockingScript.toHex() === p2pkh.lock(address).toHex() && output.satoshis > 1);
assert(sellerChange, 'listing fee change should go to a separate seller P2PKH output');
const opReturnBytes = Buffer.from(announcementOutput.lockingScript.toHex(), 'hex');
let pushLength;
let payloadOffset;
if (opReturnBytes[2] === 0x4d) { pushLength = opReturnBytes.readUInt16LE(3); payloadOffset = 5; }
else if (opReturnBytes[2] === 0x4c) { pushLength = opReturnBytes[3]; payloadOffset = 4; }
else { pushLength = opReturnBytes[2]; payloadOffset = 3; }
const announcement = JSON.parse(opReturnBytes.subarray(payloadOffset, payloadOffset + pushLength).toString('utf8'));
assert.deepEqual(announcement, {
  p: 'lbsx', v: 1, op: 'sell', net: 'main', id: tokenId, amt: '500', price: 5000,
  maker: address, src: `${currentToken.txid}.${currentToken.vout}`, lock: 0, change: null, anchor: ADMIN_DISCOVERY_ADDRESS,
});
const listedBook = await market.getTokenOrderBook(tokenId, address);
assert.equal(listedBook.asks.length, 1);
assert.equal(listedBook.myOrders.length, 1);
assert.equal(listedBook.asks[0].priceSats, 5000);
assert.equal(listedBook.asks[0].amountBase, '500', 'listing amount is read from the actual BSV-21 script');
console.log('PASS: sell creates an OrdLock v2 listing with amount/price OP_RETURN and admin-wallet discovery anchor');

const pendingBook = await market.getTokenOrderBook(tokenId, address);
assert.equal(pendingBook.asks.length, 1, 'a valid unconfirmed LBSX listing remains visible in the BananaBlocks-backed orderbook');
assert.equal(pendingBook.asks[0].status, 'pending', 'a mempool listing is marked pending until confirmed');
await assert.rejects(market.buildAndBroadcastBuy(buyerKey, { tokenId, outpoint: listed.outpoint }), /still unconfirmed/);
await assert.rejects(market.buildAndBroadcastCancel(key, { tokenId, outpoint: listed.outpoint }), /still unconfirmed/);
for (const txid of adminTxIds) confirmedAdminTxIds.add(txid);
console.log('PASS: mempool listings appear as pending and cannot be bought or cancelled before confirmation');

console.log('PASS: BananaBlocks OP_RETURN and transaction outputs drive the LBSX orderbook without 1Sat overlay metadata');

const cancelled = await market.buildAndBroadcastCancel(key, { tokenId, outpoint: listed.outpoint });
assert.match(cancelled.txid, /^[0-9a-f]{64}$/);
assert.equal((await market.getTokenOrderBook(tokenId, address)).asks.length, 0);
const afterCancel = await market.getTokenSellQuote(key, tokenId);
assert.equal(afterCancel.amountBase, '500', 'cancellation returns the token amount to the seller wallet');
console.log('PASS: owner cancellation spends the lock and returns a BSV-21 transfer output');

const beforePartial = await market.getTokenSellQuote(key, tokenId);
const partialListing = await market.buildAndBroadcastList(key, { tokenId, amountBase: '200', priceSats: 4500 });
confirmedAdminTxIds.add(partialListing.txid);
assert.equal(partialListing.amountBase, '200');
assert.equal(partialListing.changeAmountBase, '300');
const partialTx = txStore.get(partialListing.txid);
const partialLocked = partialTx.outputs.find(output => OrdLockV2.decode(output.lockingScript));
const partialChange = partialTx.outputs.map(output => BSV21.decode(output.lockingScript)).find(token => token?.getAmount() === 300n);
assert.equal(BSV21.decode(partialLocked.lockingScript)?.getAmount(), 200n, 'OrdLock output should carry exactly the seller-selected amount');
assert(partialChange, 'the unlisted token remainder should be returned to a seller BSV-21 output');
assert.equal(BSV21.decode(partialLocked.lockingScript).getAmount() + partialChange.getAmount(), BigInt(beforePartial.amountBase), 'listing and change outputs must conserve all source token units');
assert.equal(partialListing.changeOutpoint, `${partialListing.txid}.1`);
await market.buildAndBroadcastCancel(key, { tokenId, outpoint: partialListing.outpoint });
console.log('PASS: partial listing locks the requested amount and returns exact BSV-21 change');

const listedAgain = await market.buildAndBroadcastList(key, { tokenId, amountBase: currentToken.amount.toString(), priceSats: 6000 });
confirmedAdminTxIds.add(listedAgain.txid);
const pendingBuyerCash = makeSource({ lockingScript: p2pkh.lock(buyerAddress), satoshis: 50000 });
cachedUtxosByAddress.set(buyerAddress, [{
  txid: pendingBuyerCash.id('hex').toLowerCase(),
  vout: 0,
  satoshis: 50000,
  scriptHex: p2pkh.lock(buyerAddress).toHex(),
  rawTxHex: pendingBuyerCash.toHex(),
  state: 'pending',
}]);
const buyerUnspentRequestsBeforeBuy = unspentRequestsByAddress.get(buyerAddress) || 0;
const bought = await market.buildAndBroadcastBuy(buyerKey, { tokenId, outpoint: listedAgain.outpoint });
assert.match(bought.txid, /^[0-9a-f]{64}$/);
assert.equal(bought.amountBase, currentToken.amount.toString());
assert.equal(unspentRequestsByAddress.get(buyerAddress) || 0, buyerUnspentRequestsBeforeBuy, 'an accepted local pending BSV output should fund the purchase without a BananaBlocks UTXO request');
assert.equal((await market.getTokenOrderBook(tokenId, address)).asks.length, 0);
assert.equal(broadcastCount, 6);
console.log('PASS: buy validates the active listing, creates the buyer BSV-21 delivery, and spends accepted local pending BSV without an unspent query');
