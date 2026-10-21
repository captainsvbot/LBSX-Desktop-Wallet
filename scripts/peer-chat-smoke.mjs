import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const adminAddress = '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB';
const { decryptPeerChatContent, encryptPeerChatContent } = require('../electron/peer-chat-crypto.cjs');
const senderKey = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 0x32));
const senderAddress = senderKey.toAddress().toString();
const timestamp = '2026-10-21T12:00:00.000Z';
const content = 'A locally indexed public LBSX message.';
const legacyContent = 'An older plaintext Peer Chat message.';

function createMessageTransaction(sourceTxid, messageText = content, version = 'v2') {
  const payload = version === 'v2' ? encryptPeerChatContent(messageText) : messageText;
  const transaction = new bsv.Transaction()
    .from({
      txid: sourceTxid,
      vout: 0,
      satoshis: 10000,
      script: bsv.Script.buildPublicKeyHashOut(senderAddress).toHex(),
    })
    .to(adminAddress, 1000);
  transaction.addOutput(new bsv.Transaction.Output({
    script: bsv.Script.buildSafeDataOut(['LBSX', version, 'peer_chat', senderAddress, timestamp, payload]),
    satoshis: 0,
  }));
  transaction.to(senderAddress, 8000);
  return transaction;
}

const confirmedTx = createMessageTransaction('61'.repeat(32));
const confirmedTxid = confirmedTx.id.toLowerCase();
const legacyTx = createMessageTransaction('63'.repeat(32), legacyContent, 'v1');
const legacyTxid = legacyTx.id.toLowerCase();
const pendingTx = createMessageTransaction('62'.repeat(32), 'A pending message.');
const pendingTxid = pendingTx.id.toLowerCase();
const index = {
  address: adminAddress,
  source: 'Encrypted local SPV index',
  syncedAt: timestamp,
  lastScannedTxid: confirmedTxid,
  historyComplete: true,
  scannedTransactions: 3,
  lookupFailures: 0,
  errors: [],
  transactions: [
    {
      txid: confirmedTxid,
      blockHeight: 900123,
      blockTime: 1792584000,
      confirmed: true,
      rawTxHex: confirmedTx.toString(),
      details: { inputs: [{ address: senderAddress }], outputs: [{ address: adminAddress, value: 1000 }] },
    },
    {
      txid: legacyTxid,
      blockHeight: 900122,
      blockTime: 1792584000,
      confirmed: true,
      rawTxHex: legacyTx.toString(),
      details: { inputs: [{ address: senderAddress }], outputs: [{ address: adminAddress, value: 1000 }] },
    },
    {
      txid: pendingTxid,
      blockHeight: 0,
      blockTime: 0,
      confirmed: false,
      rawTxHex: pendingTx.toString(),
      details: { inputs: [{ address: senderAddress }], outputs: [{ address: adminAddress, value: 1000 }] },
    },
  ],
};
let stored = { messages: [], lastScannedTxid: null, syncedAt: null };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './admin-wallet-index.cjs') return {
    getAdminWalletIndex: async () => index,
    syncAdminWalletIndex: async () => index,
  };
  if (request === './wallet-data.cjs') return {
    getWalletPeerChatSnapshot: async () => structuredClone(stored),
    saveWalletPeerChatSnapshot: async (_address, snapshot) => {
      const byTxid = new Map(stored.messages.map(message => [message.txid, message]));
      for (const message of snapshot.messages || []) byTxid.set(message.txid, message);
      stored = {
        messages: [...byTxid.values()],
        lastScannedTxid: snapshot.lastScannedTxid ?? stored.lastScannedTxid,
        syncedAt: snapshot.syncedAt ?? stored.syncedAt,
      };
      return structuredClone(stored);
    },
  };
  return originalLoad.call(this, request, parent, isMain);
};

const { getPeerChatSnapshot, syncPeerChat, _test } = require('../electron/peer-chat.cjs');
Module._load = originalLoad;

const parsed = _test.parsePeerChatTransaction(confirmedTxid, confirmedTx.toString(), index.transactions[0].details, 900123);
assert.equal(parsed?.senderAddress, senderAddress);
assert.equal(parsed?.content, content);
assert.equal(parsed?.isEncrypted, true);
assert.equal(parsed?.status, 'confirmed');
const encodedFields = _test.extractOpReturnFields(new bsv.Transaction(confirmedTx.toString()).outputs[1].script);
assert.equal(encodedFields[1], 'v2');
assert.notEqual(encodedFields[5], content, 'new on-chain payloads do not contain readable plaintext');
assert.equal(decryptPeerChatContent(encodedFields[5]), content);
const tamperedPayload = Buffer.from(encodedFields[5], 'base64');
tamperedPayload[28] ^= 1;
assert.throws(() => decryptPeerChatContent(tamperedPayload.toString('base64')), /authenticated or decoded/);
const parsedLegacy = _test.parsePeerChatTransaction(legacyTxid, legacyTx.toString(), index.transactions[1].details, 900122);
assert.equal(parsedLegacy?.content, legacyContent, 'legacy v1 messages remain readable');
assert.equal(parsedLegacy?.isEncrypted, false, 'legacy plaintext messages are identified');
assert.equal(_test.parsePeerChatTransaction(pendingTxid, pendingTx.toString(), index.transactions[2].details, 0), null,
  'an unconfirmed public post is not presented as a confirmed peer message');

const synced = await syncPeerChat(senderAddress);
assert.equal(synced.messages.length, 2);
assert.equal(synced.messages[0].txid, confirmedTxid);
assert.equal(synced.messages[0].content, content);
assert.equal(synced.messages[0].isEncrypted, true);
assert.equal(synced.messages[1].txid, legacyTxid);
assert.equal(synced.messages[1].isEncrypted, false);
assert.equal(synced.messages[0].blockHeight, 900123);
assert.equal(synced.lastScannedTxid, confirmedTxid);
const cached = await getPeerChatSnapshot(senderAddress);
assert.equal(cached.messages[0].txid, confirmedTxid, 'the feed is served from the wallet-local message cache');
assert.equal(cached.source, 'Encrypted local cache');
console.log('PASS: Peer Chat parses confirmed on-chain posts and persists a local feed while excluding unconfirmed posts');
