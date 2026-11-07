import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const spvTestMock = require('./spv-test-mock.cjs');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => process.cwd() } };
  if (request === './wallet-data.cjs') return {
    cacheVerifiedBsvUtxos: async () => {},
    cacheVerifiedTokenUtxos: async () => {},
    cacheVerifiedTokenUtxo: async () => {},
    getSpendableBsvUtxos: async () => [],
    getSpendableTokenUtxos: async () => [],
    getSpendableUtxoBlocklist: async () => new Set(),
    getTrackedTransactionHex: async () => null,
  };
  if (request === './transaction-tracker.cjs') return {
    broadcastTrackedTransaction: async ({ txid, broadcast }) => { await broadcast(); return txid; },
    reconcileDefinitivelyRejectedTransactions: async () => [],
  };
  if (request === './spv.cjs') return spvTestMock;
  return originalLoad.call(this, request, parent, isMain);
};
const { sendBsv } = require('../electron/token-wallet.cjs');
const { ADMIN_DISCOVERY_ADDRESS } = require('../electron/constants.cjs');
const tokenWallet = require('../electron/token-wallet.cjs');
Module._load = originalLoad;

const key = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 4));
const address = key.toAddress().toString();
const recipient = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 5)).toAddress().toString();
const tokenId = `${'11'.repeat(32)}_1`;
const sourceTxs = new Map();
const broadcasted = [];

function makeParent(script, sats) {
  const tx = new bsv.Transaction();
  tx.from({ txid: '22'.repeat(32), vout: 0, satoshis: 50000, script: bsv.Script.buildPublicKeyHashOut(address).toHex() });
  tx.addOutput(new bsv.Transaction.Output({ script, satoshis: sats }));
  sourceTxs.set(tx.id, tx);
  return tx;
}

const cashParent = makeParent(bsv.Script.buildPublicKeyHashOut(address), 30000);
const cashTxid = cashParent.id;
const tokenParent = makeParent(tokenWallet._test.transferScript(address, tokenId, '100'), 20000);
const tokenTxid = tokenParent.id;

function response(data, status = 200, contentType = 'application/json') {
  return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': contentType } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const p = url.pathname;
  if (p.endsWith('/unspent')) return response([
    { tx_hash: tokenTxid, tx_pos: 0, value: 20000, height: 10 },
    { tx_hash: cashTxid, tx_pos: 0, value: 30000, height: 10 },
  ]);
  if (p.startsWith('/api/v1/txo/') && p.endsWith('/spend')) return response({ spent: false });
  if (p.startsWith('/api/v1/txo/')) return response({ script_type: 'p2pkh', address, spent: false });
  if (p.startsWith('/api/v1/bsv/main/tx/') && p.endsWith('/hex')) {
    const txid = p.split('/').at(-2);
    const tx = sourceTxs.get(txid);
    return tx ? response(tx.toString(), 200, 'text/plain') : response('not found', 404, 'text/plain');
  }
  if (p.endsWith('/tx/broadcast') || p.endsWith('/bsv/main/tx/raw')) {
    const body = JSON.parse(init.body);
    const raw = body.rawtx || body.txhex;
    const tx = new bsv.Transaction(raw);
    broadcasted.push(tx);
    return response({ txid: tx.id });
  }
  throw new Error(`Unexpected test URL ${url}`);
};

const sent = await sendBsv(key, { recipient, amount: '0.00010000', note: 'test payment' });
assert.match(sent.txid, /^[0-9a-f]{64}$/);
assert.equal(sent.amountSats, 10000);
assert(sent.feeSats > 0);
const tx = broadcasted.at(-1);
assert.equal(tx.inputs.length, 1, 'only the verified cash UTXO is selected; the token carrier is excluded');
assert.equal(tx.inputs[0].prevTxId.toString('hex'), cashTxid);
const recipientScript = bsv.Script.buildPublicKeyHashOut(recipient).toHex();
assert(tx.outputs.some(output => output.script.toHex() === recipientScript && output.satoshis === 10000), 'recipient receives exact satoshi amount');
assert(tx.outputs.some(output => output.script.toHex() === bsv.Script.buildPublicKeyHashOut(address).toHex() && output.satoshis > 1), 'remaining BSV returns as wallet change');
assert(tx.outputs.some(output => output.script.toHex() === bsv.Script.buildPublicKeyHashOut(ADMIN_DISCOVERY_ADDRESS).toHex() && output.satoshis === 10000), 'admin wallet receives the 10000 sat service fee');
const memoOutput = tx.outputs.find(output => output.script.toHex().startsWith('006a'));
assert(memoOutput, 'LBSX OP_RETURN is present');
const memoFields = memoOutput.script.chunks.slice(2).map(chunk => chunk.buf?.toString('utf8'));
assert.deepEqual(memoFields.slice(0, 3), ['LBSX', 'v2', 'bsv_send']);
assert.equal(memoFields[4], recipient);
assert.equal(memoFields[5], '10000');
assert.equal(memoFields[7], 'service_fee:10000sat:wallet_maintenance');
assert.equal(memoFields[8], 'msg:test payment');
assert.equal(memoOutput.satoshis, 0);
assert(tx.inputs[0].script.chunks.length >= 2, 'cash input is locally signed');
console.log('PASS: BSV send signs and broadcasts exact amount, excludes token carrier, returns change, and carries optional public note');

await assert.rejects(sendBsv(key, { recipient, amount: '0.000000001' }), /8 decimal places/);
await assert.rejects(sendBsv(key, { recipient: 'not-an-address', amount: '0.0001' }), /valid BSV mainnet recipient/);
console.log('PASS: BSV send rejects invalid precision and recipient before building a transaction');
