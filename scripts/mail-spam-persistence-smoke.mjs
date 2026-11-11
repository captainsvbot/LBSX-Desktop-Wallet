// Tests the mailbox PERSISTENCE rules for delete and spam.
//
// The rule that matters most: a deleted message must stay deleted. The mail
// sync re-discovers every mail payload on chain on every run, so without a
// tombstone the deleted message would come straight back.
//
// These tests drive the real wallet-data functions against a temporary
// wallet file, then re-run the save path the way a sync would.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsv = require('bsv');

// The wallet-data module resolves its storage path from Electron's `app`,
// which does not exist outside a running Electron process. The module is
// stubbed here so the REAL persistence logic can be exercised in plain Node.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lbsx-mail-store-'));
process.env.LBSX_WALLET_HOME = tempHome;
process.env.HERMES_HOME = tempHome;

// The stub is installed by intercepting the 'electron' module resolution.
import Module from 'node:module';
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub',
  filename: 'electron-stub',
  loaded: true,
  exports: {
    app: {
      getPath: () => tempHome,
      getVersion: () => '2.1.13',
      isPackaged: false,
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: value => Buffer.from(String(value), 'utf8'),
      decryptString: buffer => buffer.toString('utf8'),
    },
  },
};

// The vault holds the wallet key in memory and refuses to serve it while the
// wallet is locked. The persistence logic under test does not need the real
// key, so the vault is stubbed with a fixed one.
const vaultStubPath = path.join(tempHome, 'vault-stub.cjs');
fs.writeFileSync(vaultStubPath, `
const crypto = require('node:crypto');
// A FRESH key every call: the wallet-data module wipes the key buffer with
// fill(0) after use, so a shared buffer would be zeroed by the first read.
const deriveKey = () => crypto.createHash('sha256').update('lbsx-mail-store-test').digest();
module.exports = {
  getWalletDataEncryptionKey: () => deriveKey(),
  getWalletPrivateKey: () => { throw new Error('not used in this test'); },
  getWalletPublicKey: () => { throw new Error('not used in this test'); },
  getWalletSummary: () => ({ address: 'test' }),
};
`);

const originalResolveVault = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === './vault.cjs' && parent && parent.filename && parent.filename.includes('wallet-data.cjs')) {
    return vaultStubPath;
  }
  return originalResolveVault.call(this, request, parent, ...rest);
};

const walletData = require('../electron/wallet-data.cjs');

console.log('=== MAIL DELETE AND SPAM PERSISTENCE ===');

// Real addresses, derived the way the wallet derives them, so the message
// normaliser accepts them.
const DERIVATION_PATH = "m/44'/0'/0'/0/0";
function derive(seedByte) {
  const key = bsv.HDPrivateKey.fromSeed(Buffer.alloc(32, seedByte))
    .deriveChild(DERIVATION_PATH).privateKey;
  return {
    address: key.toAddress().toString(),
    publicKeyHex: key.toPublicKey().toHex(),
  };
}

const RECIPIENT = derive(1);
const SENDER = derive(2);

// A message row shaped exactly like the normaliser accepts.
function mailRow(messageId, overrides = {}) {
  return {
    txid: 'a'.repeat(64),
    messageId,
    direction: 'received',
    senderAddress: SENDER.address,
    recipientAddress: RECIPIENT.address,
    recipientPublicKeyHex: RECIPIENT.publicKeyHex,
    senderPublicKeyHex: SENDER.publicKeyHex,
    attachmentRefs: [],
    subject: 'Test message',
    body: 'Test body',
    timestamp: '2026-01-01T00:00:00.000Z',
    status: 'confirmed',
    blockHeight: 800000,
    readAt: null,
    error: null,
    ...overrides,
  };
}

async function main() {
  const FIRST = '1'.repeat(64);
  const SECOND = '2'.repeat(64);

  // --- store two messages ---
  await walletData.saveWalletMailSnapshot(RECIPIENT.address, {
    messages: [mailRow(FIRST), mailRow(SECOND)],
    syncedAt: new Date().toISOString(),
  });

  let snapshot = await walletData.getWalletMailSnapshot(RECIPIENT.address);
  assert.equal(snapshot.messages.length, 2, 'both messages are stored');
  console.log('  two messages stored: OK');

  // --- delete one ---
  await walletData.deleteMailMessage(RECIPIENT.address, FIRST);
  snapshot = await walletData.getWalletMailSnapshot(RECIPIENT.address);
  assert.equal(snapshot.messages.length, 1, 'the deleted message is gone from the mailbox');
  assert.equal(snapshot.messages[0].messageId, SECOND, 'the other message is untouched');
  assert.deepEqual(snapshot.deletedMessageIds, [FIRST], 'the deletion is recorded as a tombstone');
  console.log('  delete removes the message and records a tombstone: OK');

  // --- a sync re-saves the deleted message; it must NOT come back ---
  // This is exactly what syncMail does: it re-discovers every mail payload
  // on chain and saves the full set again.
  await walletData.saveWalletMailSnapshot(RECIPIENT.address, {
    messages: [mailRow(FIRST), mailRow(SECOND)],
    syncedAt: new Date().toISOString(),
  });
  snapshot = await walletData.getWalletMailSnapshot(RECIPIENT.address);
  assert.equal(snapshot.messages.length, 1, 'the deleted message did NOT come back after a re-sync');
  assert.equal(snapshot.messages[0].messageId, SECOND, 'the surviving message is still there');
  console.log('  a deleted message stays deleted across a re-sync: OK');

  // --- deleting a message that is not there is an error, not a silent no-op ---
  await assert.rejects(
    () => walletData.deleteMailMessage(RECIPIENT.address, 'f'.repeat(64)),
    /not in the local mailbox/,
    'deleting an unknown message must be rejected',
  );
  console.log('  deleting an unknown message is rejected: OK');

  // --- an invalid message id is rejected ---
  await assert.rejects(
    () => walletData.deleteMailMessage(RECIPIENT.address, 'not-a-hash'),
    /invalid/,
    'an invalid message id must be rejected',
  );
  console.log('  an invalid message id is rejected: OK');

  // --- spam flags are stored and removed ---
  const KEY = `03${'d'.repeat(64)}`;
  await walletData.markMailSenderSpam(RECIPIENT.address, {
    publicKeyHex: KEY,
    senderAddress: '1SpamSender',
    label: 'Spammer',
  });
  let keys = await walletData.getWalletMailSpamKeys(RECIPIENT.address);
  assert.ok(keys.has(KEY), 'the spam key is stored');

  snapshot = await walletData.getWalletMailSnapshot(RECIPIENT.address);
  assert.equal(snapshot.spamSenders.length, 1, 'the spam sender is exposed on the snapshot');
  assert.equal(snapshot.spamSenders[0].publicKeyHex, KEY, 'the stored key is the one that was flagged');
  console.log('  a spam flag is stored and exposed on the snapshot: OK');

  // Marking the same key twice must not duplicate it.
  await walletData.markMailSenderSpam(RECIPIENT.address, { publicKeyHex: KEY, senderAddress: '1SpamSender' });
  snapshot = await walletData.getWalletMailSnapshot(RECIPIENT.address);
  assert.equal(snapshot.spamSenders.length, 1, 'marking the same key twice does not duplicate it');
  console.log('  marking the same key twice does not duplicate it: OK');

  // --- unmarking removes it ---
  await walletData.unmarkMailSenderSpam(RECIPIENT.address, KEY);
  keys = await walletData.getWalletMailSpamKeys(RECIPIENT.address);
  assert.equal(keys.has(KEY), false, 'the spam key is removed');
  console.log('  unmarking removes the spam key: OK');

  // --- unmarking a key that is not flagged is rejected ---
  await assert.rejects(
    () => walletData.unmarkMailSenderSpam(RECIPIENT.address, KEY),
    /not marked as spam/,
    'unmarking an unflagged sender must be rejected',
  );
  console.log('  unmarking an unflagged sender is rejected: OK');

  // --- an invalid public key is rejected ---
  await assert.rejects(
    () => walletData.markMailSenderSpam(RECIPIENT.address, { publicKeyHex: 'nope' }),
    /invalid/,
    'an invalid public key must be rejected',
  );
  console.log('  an invalid spam public key is rejected: OK');

  // --- the spam list survives a re-sync ---
  await walletData.markMailSenderSpam(RECIPIENT.address, { publicKeyHex: KEY, senderAddress: '1SpamSender' });
  await walletData.saveWalletMailSnapshot(RECIPIENT.address, {
    messages: [mailRow(SECOND)],
    syncedAt: new Date().toISOString(),
  });
  keys = await walletData.getWalletMailSpamKeys(RECIPIENT.address);
  assert.ok(keys.has(KEY), 'the spam flag survives a re-sync');
  console.log('  the spam flag survives a re-sync: OK');

  // --- cleanup ---
  fs.rmSync(tempHome, { recursive: true, force: true });

  console.log('');
  console.log('PASS: deletions survive a re-sync, spam flags persist, and invalid input is rejected');
}

main().catch(error => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
