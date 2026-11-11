// Tests the mailbox PIN feature.
//
// The rule: a pinned message stays at the TOP of its list, so it cannot be
// scrolled away from. The pin is LOCAL - it reorders the mailbox on this
// device and changes nothing on chain.
//
// These tests drive the real wallet-data persistence, then apply the same
// reorder the page does, so the two are checked against each other.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsv = require('bsv');

// The wallet-data module resolves its storage path from Electron's `app` and
// its encryption key from the vault, neither of which exist outside a running
// Electron process. Both are stubbed so the REAL persistence logic can be
// exercised in plain Node.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lbsx-mail-pin-'));
process.env.LBSX_WALLET_HOME = tempHome;
process.env.HERMES_HOME = tempHome;

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
    app: { getPath: () => tempHome, getVersion: () => '2.1.14', isPackaged: false },
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

console.log('=== MAIL PIN ===');

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

// The reorder the page applies: pinned messages first, in their own order,
// then everything else sorted as usual.
function applyPinOrder(sorted, pinnedIds) {
  const pinned = [];
  const rest = [];
  for (const message of sorted) {
    (pinnedIds.includes(message.messageId) ? pinned : rest).push(message);
  }
  return pinned.length ? [...pinned, ...rest] : rest;
}

async function main() {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const C = 'c'.repeat(64);

  await walletData.saveWalletMailSnapshot(RECIPIENT.address, {
    messages: [mailRow(A), mailRow(B), mailRow(C)],
    syncedAt: new Date().toISOString(),
  });

  // --- nothing is pinned to start with ---
  {
    let snapshot = await walletData.getWalletMailSnapshot(RECIPIENT.address);
    assert.deepEqual(snapshot.pinnedMessageIds, [], 'nothing is pinned initially');
    console.log('  nothing is pinned initially: OK');
  }

  // --- pinning a message records it ---
  {
    await walletData.setMailPinned(RECIPIENT.address, B, true);
    const snapshot = await walletData.getWalletMailSnapshot(RECIPIENT.address);
    assert.deepEqual(snapshot.pinnedMessageIds, [B], 'the pinned id is recorded');
    console.log('  pinning a message records it: OK');
  }

  // --- a pinned message sorts to the top ---
  {
    const snapshot = await walletData.getWalletMailSnapshot(RECIPIENT.address);
    // Newest first, so C would lead without the pin.
    const sorted = [...snapshot.messages].sort((x, y) => y.timestamp.localeCompare(x.timestamp));
    const ordered = applyPinOrder(sorted, snapshot.pinnedMessageIds);
    assert.equal(ordered[0].messageId, B, 'the pinned message is first');
    console.log('  a pinned message sorts to the top: OK');
  }

  // --- the pin survives a re-sync (the sync re-saves every message) ---
  {
    await walletData.saveWalletMailSnapshot(RECIPIENT.address, {
      messages: [mailRow(A), mailRow(B), mailRow(C)],
      syncedAt: new Date().toISOString(),
    });
    const snapshot = await walletData.getWalletMailSnapshot(RECIPIENT.address);
    assert.deepEqual(snapshot.pinnedMessageIds, [B], 'the pin survives a re-sync');
    assert.equal(snapshot.messages.length, 3, 'all three messages are still there');
    console.log('  the pin survives a re-sync: OK');
  }

  // --- unpinning removes it ---
  {
    await walletData.setMailPinned(RECIPIENT.address, B, false);
    const snapshot = await walletData.getWalletMailSnapshot(RECIPIENT.address);
    assert.deepEqual(snapshot.pinnedMessageIds, [], 'the pin is removed');
    console.log('  unpinning removes it: OK');
  }

  // --- pinning twice does not duplicate ---
  {
    await walletData.setMailPinned(RECIPIENT.address, A, true);
    await walletData.setMailPinned(RECIPIENT.address, A, true);
    const snapshot = await walletData.getWalletMailSnapshot(RECIPIENT.address);
    assert.deepEqual(snapshot.pinnedMessageIds, [A], 'pinning the same message twice does not duplicate it');
    console.log('  pinning the same message twice does not duplicate it: OK');
  }

  // --- the newest pin leads among pinned messages ---
  {
    await walletData.setMailPinned(RECIPIENT.address, C, true);
    const snapshot = await walletData.getWalletMailSnapshot(RECIPIENT.address);
    assert.equal(snapshot.pinnedMessageIds[0], C, 'the most recently pinned message leads');
    console.log('  the most recently pinned message leads: OK');
  }

  // --- an invalid message id is rejected ---
  await assert.rejects(
    () => walletData.setMailPinned(RECIPIENT.address, 'not-a-hash', true),
    /invalid/,
    'an invalid message id must be rejected',
  );
  console.log('  an invalid message id is rejected: OK');

  // --- cleanup ---
  fs.rmSync(tempHome, { recursive: true, force: true });

  console.log('');
  console.log('PASS: pinned messages stay at the top of the list and the pin survives a sync');
}

main().catch(error => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
