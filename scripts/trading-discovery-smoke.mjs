import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const sdk = require('@bsv/sdk');
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const { Transaction, P2PKH, Script, LockingScript } = sdk;
const { BSV21, OrdLockV2 } = await import('@1sat/templates');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => process.cwd() }, safeStorage: { isEncryptionAvailable: () => false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { parseOrderAnnouncement, verifyLiveSellOrder, ADMIN_DISCOVERY_ADDRESS } = require('../electron/trading.cjs');
Module._load = originalLoad;
const key = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 17));
const maker = key.toAddress().toString();
const tokenId = '9421c95ba7b6ffb518eae62b9c5b1650d28aacdc420a98f2abf25668c048c60d_0';
const amountBase = '1000000';
const priceSats = 15000;
const source = new Transaction();
source.addInput({ sourceTXID: '42'.repeat(32), sourceOutputIndex: 0, unlockingScript: new sdk.UnlockingScript() });
const lockVout = source.outputs.length;
const lock = OrdLockV2.lock(maker, maker, priceSats);
source.addOutput({ lockingScript: BSV21.transfer(tokenId, BigInt(amountBase)).lock(new LockingScript(lock.chunks)), satoshis: 1 });
source.addOutput({ lockingScript: new P2PKH().lock(ADMIN_DISCOVERY_ADDRESS), satoshis: 1 });
const record = { p: 'lbsx', v: 1, op: 'sell', net: 'main', id: tokenId, amt: amountBase, price: priceSats, maker, src: `${'42'.repeat(32)}.0`, lock: lockVout, change: 1, anchor: ADMIN_DISCOVERY_ADDRESS };
const json = Buffer.from(JSON.stringify(record));
const push = json.length <= 75 ? Buffer.from([json.length]) : json.length <= 255 ? Buffer.from([0x4c, json.length]) : Buffer.from([0x4d, json.length & 0xff, json.length >> 8]);
source.addOutput({ lockingScript: Script.fromBinary(Buffer.concat([Buffer.from([0, 0x6a]), push, json])), satoshis: 0 });
const raw = source.toHex();
const txid = source.id('hex').toLowerCase();
const parsed = parseOrderAnnouncement(raw);
assert.deepEqual(parsed, record, 'sync parser should extract the versioned LBSX OP_RETURN');

globalThis.fetch = async url => {
  assert(String(url).includes(`/txo/${txid}/${lockVout}`), 'live order must be checked against BananaBlocks output spend status');
  return new Response(JSON.stringify({ spent: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const order = await verifyLiveSellOrder(txid, raw, parsed, true);
assert.equal(order?.outpoint, `${txid}.${lockVout}`);
assert.equal(order?.amountBase, amountBase);
assert.equal(order?.sellerAddress, maker);
assert.equal(await verifyLiveSellOrder(txid, raw, { ...parsed, amt: '201' }, true), null, 'announcement amount must match the on-chain BSV-21 inscription');
assert.equal(await verifyLiveSellOrder(txid, raw, parsed, false), null, 'unconfirmed admin anchors are not presented as confirmed peer orders');
console.log('PASS: peer discovery parses announcements and validates the live OrdLock/BSV-21 output');
