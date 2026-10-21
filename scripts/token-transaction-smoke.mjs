import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const { decryptPeerChatContent } = require('../electron/peer-chat-crypto.cjs');
const spvTestMock = require('./spv-test-mock.cjs');
const profile = await mkdtemp(path.join(os.tmpdir(), 'lbsx-token-tx-'));
const originalLoad = Module._load;
let lockerRows = [];
let peerChatMessages = [];
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => profile } };
  if (request === './wallet-data.cjs') return {
    cacheVerifiedBsvUtxos: async () => {},
    cacheVerifiedTokenUtxos: async () => {},
    cacheVerifiedTokenUtxo: async () => {},
    getWalletTokenLocks: async () => lockerRows,
    saveWalletTokenLocks: async (_address, rows) => { lockerRows = rows; },
    getSpendableBsvUtxos: async () => [],
    getSpendableTokenUtxos: async () => [],
    getSpendableUtxoBlocklist: async () => new Set(),
    getTrackedTransactionHex: async () => null,
    saveWalletPeerChatSnapshot: async (_address, snapshot) => {
      peerChatMessages = [...peerChatMessages, ...(snapshot.messages || [])];
      return { messages: peerChatMessages, lastScannedTxid: null, syncedAt: snapshot.syncedAt || null };
    },
  };
  if (request === './transaction-tracker.cjs') return {
    broadcastTrackedTransaction: async ({ txid, broadcast }) => { await broadcast(); return txid; },
    reconcileDefinitivelyRejectedTransactions: async () => [],
  };
  if (request === './spv.cjs') return spvTestMock;
  return originalLoad.call(this, request, parent, isMain);
};
const tokenWallet = require('../electron/token-wallet.cjs');
Module._load = originalLoad;

const key = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 1));
const address = key.toAddress().toString();
const recipient = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 2)).toAddress().toString();
const tokenId = `${'11'.repeat(32)}_1`;
const feeParent = new bsv.Transaction();
feeParent.from({ txid: '44'.repeat(32), vout: 0, satoshis: 60000, script: bsv.Script.buildPublicKeyHashOut(address).toHex() });
feeParent.addOutput(new bsv.Transaction.Output({ script: bsv.Script.buildPublicKeyHashOut(address), satoshis: 50000 }));
const feeTxid = feeParent.id.toLowerCase();
const originalNow = Date.now;
const broadcastTransactions = new Map();
let currentParent;
let currentVout = 0;
let currentAmount = 1000n;

function response(data, status = 200, contentType = 'application/json') {
  return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': contentType } });
}

function newParent(amount, id = tokenId) {
  const tx = new bsv.Transaction();
  tx.from({ txid: '22'.repeat(32), vout: 0, satoshis: 10000, script: bsv.Script.buildPublicKeyHashOut(key.toAddress()).toHex() });
  tx.addOutput(new bsv.Transaction.Output({ script: tokenWallet._test.transferScript(address, id, amount), satoshis: 1 }));
  return tx;
}

function verifyFirstInputSignature(tx, previousTx, vout) {
  const chunks = tx.inputs[0].script.chunks;
  assert(chunks.length >= 2 && chunks[0].buf && chunks[1].buf, 'token input must carry signature and public key');
  const signature = bsv.crypto.Signature.fromTxFormat(chunks[0].buf);
  const publicKey = bsv.PublicKey.fromBuffer(chunks[1].buf);
  const previousOutput = previousTx.outputs[vout];
  const digest = bsv.Transaction.Sighash.sighash(
    tx,
    bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID,
    0,
    previousOutput.script,
    new bsv.crypto.BN(previousOutput.satoshis),
  );
  assert.equal(bsv.crypto.ECDSA.verify(digest, signature, publicKey, 'little'), true, 'token input signature must verify against the real previous locking script');
}

currentParent = newParent(currentAmount);
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const p = url.pathname;
  if (p.includes('/token/') && p.endsWith('/history')) {
    return response({ transfers: [{ txid: currentParent.id, vout: currentVout, to_address: address, amount: String(currentAmount) }] });
  }
  if (p.includes('/txo/') && p.endsWith('/spend')) return response({ spent: false });
  if (p.includes('/txo/')) return response({ script_type: 'p2pkh', address, spent: false });
  if (p.endsWith('/unspent')) return response([{ tx_hash: feeTxid, tx_pos: 0, value: 50000, height: 1 }]);
  if (p.startsWith('/api/v1/bsv/main/tx/') && p.endsWith('/hex')) {
    const txid = p.split('/').at(-2);
    if (txid === currentParent.id) return response(currentParent.toString(), 200, 'text/plain');
    if (txid === feeTxid) return response(feeParent.toString(), 200, 'text/plain');
    const stored = broadcastTransactions.get(txid);
    if (stored) return response(stored.toString(), 200, 'text/plain');
    return response('not found', 404, 'text/plain');
  }
  if (p.endsWith('/tx/broadcast') || p.endsWith('/bsv/main/tx/raw')) {
    const body = JSON.parse(init.body);
    const raw = body.rawtx || body.txhex;
    const tx = new bsv.Transaction(raw);
    broadcastTransactions.set(tx.id.toLowerCase(), tx);
    if (tx.outputs.length >= 2 && tokenWallet._test.readInscription(tx.outputs[1].script.toHex())) {
      const change = tokenWallet._test.readInscription(tx.outputs[1].script.toHex());
      currentParent = tx;
      currentVout = 1;
      currentAmount = BigInt(change.amt);
    } else if (tx.outputs.length >= 1 && tokenWallet._test.readInscription(tx.outputs[0].script.toHex())) {
      const inscription = tokenWallet._test.readInscription(tx.outputs[0].script.toHex());
      if (inscription.op === 'transfer') {
        currentParent = tx;
        currentVout = 0;
        currentAmount = BigInt(inscription.amt);
      }
    }
    return response({ txid: tx.id });
  }
  throw new Error(`Unexpected test URL ${url}`);
};

try {
  assert.equal(String(tokenWallet._test.toBaseUnits('1.25', 2)), '125');
  assert.equal(tokenWallet._test.fromBaseUnits(125n, 2), '1.25');
  assert.throws(() => tokenWallet._test.toBaseUnits('1.001', 2), /decimal places/);
  assert.equal(tokenWallet._test.normalizeTokenOutpoint(tokenId), tokenId);

  const tokenParentBeforeSend = currentParent;
  const sent = await tokenWallet.sendToken(key, { tokenId, decimals: 0, amount: '400', recipient, symbol: 'TST' });
  assert.match(sent.txid, /^[0-9a-f]{64}$/);
  const sendTx = broadcastTransactions.get(sent.txid);
  verifyFirstInputSignature(sendTx, tokenParentBeforeSend, 0);
  const sentInscription = tokenWallet._test.readInscription(sendTx.outputs[0].script.toHex());
  const changeInscription = tokenWallet._test.readInscription(sendTx.outputs[1].script.toHex());
  assert.equal(sentInscription.amt, '400');
  assert.equal(changeInscription.amt, '600');
  assert.equal(sentInscription.id, tokenId);
  assert.equal(changeInscription.id, tokenId);
  assert.equal(BigInt(sentInscription.amt) + BigInt(changeInscription.amt), 1000n);
  console.log('PASS: locally signed BSV-21 send preserves token id and conserves token base units');

  Date.now = () => 1_800_000_000_000;
  const tokenParentBeforeLock = currentParent;
  const locked = await tokenWallet.createTokenLock(key, { tokenId, decimals: 0, amount: '600', schedule: 'daily', tranches: 2, symbol: 'TST' });
  assert.equal(locked.tranches, 2);
  const lockTx = broadcastTransactions.get(locked.txid);
  verifyFirstInputSignature(lockTx, tokenParentBeforeLock, currentVout);
  const lockA = tokenWallet._test.readInscription(lockTx.outputs[0].script.toHex());
  const lockB = tokenWallet._test.readInscription(lockTx.outputs[1].script.toHex());
  assert.equal(lockA.amt, '300');
  assert.equal(lockB.amt, '300');
  assert(lockTx.outputs[0].script.chunks.some(chunk => chunk.opcodenum === 0xb1), 'first tranche must include OP_CHECKLOCKTIMEVERIFY');
  assert(lockTx.outputs[1].script.chunks.some(chunk => chunk.opcodenum === 0xb1), 'second tranche must include OP_CHECKLOCKTIMEVERIFY');
  console.log('PASS: CLTV lock creates two conserved, time-locked token tranches');

  const storedLocks = await tokenWallet.getTokenLocks(address, tokenId);
  assert.equal(storedLocks.length, 2);
  assert(storedLocks.every(lock => lock.status === 'locked'));
  Date.now = () => (Math.max(...storedLocks.map(lock => lock.unlockTimestamp)) + 1) * 1000;
  const claim = await tokenWallet.claimTokenLock(key, storedLocks[0].id);
  assert.match(claim.txid, /^[0-9a-f]{64}$/);
  const claimTx = broadcastTransactions.get(claim.txid);
  verifyFirstInputSignature(claimTx, lockTx, 0);
  assert.equal(claimTx.nLockTime, storedLocks[0].unlockTimestamp);
  assert.equal(tokenWallet._test.readInscription(claimTx.outputs[0].script.toHex()).amt, '300');
  const afterClaim = await tokenWallet.getTokenLocks(address, tokenId);
  assert.equal(afterClaim.find(lock => lock.id === storedLocks[0].id).status, 'released');
  console.log('PASS: matured CLTV tranche claims and local lock record updates');

  const publicMessage = 'Hello from the encrypted local Peer Chat test.';
  const sentMessage = await tokenWallet.sendPeerChatMessage(key, { message: publicMessage });
  assert.match(sentMessage.txid, /^[0-9a-f]{64}$/);
  const chatTx = broadcastTransactions.get(sentMessage.txid);
  const adminPayment = chatTx.outputs.find(output => output.script.toAddress()?.toString() === '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB');
  assert.equal(adminPayment?.satoshis, 1000, 'a Peer Chat post sends the disclosed 1,000-sat admin output');
  const chatPayload = chatTx.outputs.find(output =>
    output.script.chunks.some(chunk => chunk.buf?.toString('utf8') === 'peer_chat'),
  );
  assert(chatPayload, 'Peer Chat should encode its message in an OP_RETURN output');
  const fields = chatPayload.script.chunks.filter(chunk => chunk.buf).map(chunk => chunk.buf.toString('utf8'));
  assert.deepEqual(fields.slice(0, 5), ['LBSX', 'v2', 'peer_chat', address, sentMessage.timestamp]);
  assert.notEqual(fields[5], publicMessage, 'the OP_RETURN payload should not expose the message as plaintext');
  assert.equal(decryptPeerChatContent(fields[5]), publicMessage, 'the app can decode the shared-feed message');
  assert.equal(sentMessage.isEncrypted, true);
  assert(peerChatMessages.some(message => message.txid === sentMessage.txid && message.status === 'pending'),
    'the signed local message is stored as pending wallet activity');
  await assert.rejects(tokenWallet.sendPeerChatMessage(key, { message: ' '.repeat(501) }), /peer chat message/);
  console.log('PASS: Peer Chat encrypts the on-chain payload, pays the admin output, and stores a pending local record');
} finally {
  Date.now = originalNow;
  await rm(profile, { recursive: true, force: true });
}
