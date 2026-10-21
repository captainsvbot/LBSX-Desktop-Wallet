import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const sdk = require('@bsv/sdk');
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const adminAddress = '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB';
const walletAddress = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 0x21)).toAddress().toString();
const message = Buffer.from(JSON.stringify({ p: 'lbsx', op: 'sell' }));
const script = sdk.Script.fromBinary(Buffer.concat([Buffer.from([0x00, 0x6a, message.length]), message]));
const makeTransaction = sourceTxid => {
  const transaction = new sdk.Transaction();
  transaction.addInput({
    sourceTXID: sourceTxid,
    sourceOutputIndex: 0,
    unlockingScript: new sdk.UnlockingScript(),
  });
  transaction.addOutput({ lockingScript: script, satoshis: 0 });
  return transaction;
};
const confirmedTx = makeTransaction('76'.repeat(32));
const confirmedTxid = confirmedTx.id('hex').toLowerCase();
const confirmedRawHex = confirmedTx.toHex();
const pendingTx = makeTransaction('77'.repeat(32));
const pendingTxid = pendingTx.id('hex').toLowerCase();
const pendingRawHex = pendingTx.toHex();
const detailsByTxid = new Map([
  [confirmedTxid, {
    txid: confirmedTxid,
    block_height: 900001,
    inputs: [],
    outputs: [{ index: 0, value: '0', script_pubkey: script.toHex() }],
  }],
  [pendingTxid, {
    txid: pendingTxid,
    inputs: [],
    outputs: [{ index: 0, value: '0', script_pubkey: script.toHex() }],
  }],
]);
const requests = { history: 0, pendingHistory: 0, details: 0, rawHex: 0, beef: 0 };
let stored = {
  transactions: [],
  pendingTransactions: [],
  lastScannedTxid: null,
  syncedAt: null,
  historyCursor: null,
  historyComplete: false,
};

function response(body, headers = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './bananablocks.cjs') {
    return {
      bananaBlocksFetch: async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/unconfirmed/history')) {
          requests.pendingHistory++;
          return response({ result: [{ tx_hash: pendingTxid }] });
        }
        if (url.pathname.endsWith('/history')) {
          requests.history++;
          return response([{ tx_hash: confirmedTxid, height: 900001 }], { 'X-Has-More': 'false' });
        }
        if (url.pathname.startsWith('/api/v1/tx/') && !url.pathname.endsWith('/hex')) {
          requests.details++;
          const txid = url.pathname.split('/').at(-1);
          return response(detailsByTxid.get(txid));
        }
        if (url.pathname === `/api/v1/tx/${pendingTxid}/hex`) {
          requests.rawHex++;
          return new Response(pendingRawHex, { status: 200, headers: { 'Content-Type': 'text/plain' } });
        }
        throw new Error(`Unexpected admin-wallet index URL ${url}`);
      },
    };
  }
  if (request === './constants.cjs') return { ADMIN_DISCOVERY_ADDRESS: adminAddress };
  if (request === './spv.cjs') return {
    ensureHeaderChain: async () => ({}),
    verifyTransactionProof: async (_address, txid, height) => {
      requests.beef++;
      assert.equal(txid, confirmedTxid);
      assert.equal(height, 900001);
      return { rawTxHex: confirmedRawHex, blockHeight: height, blockHash: '88'.repeat(32) };
    },
  };
  if (request === './wallet-data.cjs') return {
    getWalletAdminIndexSnapshot: async () => structuredClone(stored),
    saveWalletAdminIndexSnapshot: async (_address, snapshot) => {
      stored = {
        ...stored,
        ...snapshot,
        transactions: [...stored.transactions, ...(snapshot.transactions || [])],
        pendingTransactions: snapshot.pendingTransactions || stored.pendingTransactions,
      };
      return structuredClone(stored);
    },
  };
  return originalLoad.call(this, request, parent, isMain);
};

const { getAdminWalletIndex, syncAdminWalletIndex } = require('../electron/admin-wallet-index.cjs');
Module._load = originalLoad;

const first = await syncAdminWalletIndex(walletAddress);
const confirmed = first.transactions.find(row => row.txid === confirmedTxid);
assert(confirmed, 'the shared index includes confirmed sell announcements');
assert.equal(confirmed.blockHeight, 900001);
assert.equal(confirmed.confirmed, true);
assert.equal(confirmed.rawTxHex, confirmedRawHex, 'confirmed protocol bytes come from the BEEF proof');
const pending = first.transactions.find(row => row.txid === pendingTxid);
assert(pending, 'the shared index includes an unconfirmed sell announcement');
assert.equal(pending.blockHeight, 0);
assert.equal(pending.confirmed, false);
assert.equal(pending.rawTxHex, pendingRawHex, 'pending protocol transaction bytes are cached for local discovery');
assert.deepEqual(requests, { history: 1, pendingHistory: 1, details: 2, rawHex: 1, beef: 1 });

const cached = await getAdminWalletIndex(walletAddress);
assert.equal(cached.transactions.find(row => row.txid === pendingTxid)?.rawTxHex, pendingRawHex);
await syncAdminWalletIndex(walletAddress);
assert.deepEqual(requests, { history: 1, pendingHistory: 1, details: 2, rawHex: 1, beef: 1 },
  're-reading the shared index does not repeat history or transaction lookups');
console.log('PASS: shared admin index caches confirmed BEEF and pending sell records without repeated lookups or false SPV claims');
