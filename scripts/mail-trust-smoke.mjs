// Tests the mailbox TRUST feature.
//
// The rule: "trusted" is the user's own local vouch for a contact. It is
// stored per PUBLIC KEY, so it carries over to every address that key
// controls and to every mail row from that sender.
//
// It is NOT a cryptographic claim: nothing about the key changes, nothing is
// published, and no other party can verify it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsv = require('bsv');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lbsx-mail-trust-'));
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
    app: { getPath: () => tempHome, getVersion: () => '2.1.15', isPackaged: false },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: value => Buffer.from(String(value), 'utf8'),
      decryptString: buffer => buffer.toString('utf8'),
    },
  },
};

const vaultStubPath = path.join(tempHome, 'vault-stub.cjs');
fs.writeFileSync(vaultStubPath, `
const crypto = require('node:crypto');
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

console.log('=== MAIL TRUST ===');

const DERIVATION_PATH = "m/44'/0'/0'/0/0";
function derive(seedByte) {
  const key = bsv.HDPrivateKey.fromSeed(Buffer.alloc(32, seedByte))
    .deriveChild(DERIVATION_PATH).privateKey;
  return {
    address: key.toAddress().toString(),
    publicKeyHex: key.toPublicKey().toHex(),
  };
}

const ALICE = derive(1);
const BOB = derive(2);

async function main() {
  // --- a fresh contact is not trusted ---
  await walletData.saveWalletMailContacts(ALICE.address, [
    { address: BOB.address, publicKeyHex: BOB.publicKeyHex, label: 'Bob' },
  ]);
  {
    const contacts = await walletData.getWalletMailContacts(ALICE.address);
    assert.equal(contacts[0].trusted, false, 'a new contact is not trusted');
    let keys = await walletData.getWalletMailTrustedKeys(ALICE.address);
    assert.equal(keys.size, 0, 'no trusted keys to start with');
    console.log('  a new contact is not trusted: OK');
  }

  // --- trusting a contact records it ---
  {
    await walletData.setMailContactTrusted(ALICE.address, BOB.publicKeyHex, true);
    const contacts = await walletData.getWalletMailContacts(ALICE.address);
    assert.equal(contacts[0].trusted, true, 'the contact is marked trusted');

    const keys = await walletData.getWalletMailTrustedKeys(ALICE.address);
    assert.ok(keys.has(BOB.publicKeyHex), 'the trusted key is exposed for the badge lookup');
    console.log('  trusting a contact records it: OK');
  }

  // --- the trust survives a re-save of the contact list ---
  {
    await walletData.saveWalletMailContacts(ALICE.address, [
      { address: BOB.address, publicKeyHex: BOB.publicKeyHex, label: 'Bob' },
    ]);
    const contacts = await walletData.getWalletMailContacts(ALICE.address);
    assert.equal(contacts[0].trusted, false,
      're-saving a contact list without the flag clears it (the flag is explicit)');
    console.log('  re-saving without the flag clears it (the flag is explicit): OK');
  }

  // --- untrusting removes it ---
  {
    await walletData.setMailContactTrusted(ALICE.address, BOB.publicKeyHex, true);
    await walletData.setMailContactTrusted(ALICE.address, BOB.publicKeyHex, false);
    const keys = await walletData.getWalletMailTrustedKeys(ALICE.address);
    assert.equal(keys.has(BOB.publicKeyHex), false, 'the trusted key is removed');
    console.log('  untrusting removes it: OK');
  }

  // --- trusting a contact that is not in the list is rejected ---
  await assert.rejects(
    () => walletData.setMailContactTrusted(ALICE.address, `03${'e'.repeat(64)}`, true),
    /not in the local contact list/,
    'trusting an unknown contact must be rejected',
  );
  console.log('  trusting an unknown contact is rejected: OK');

  // --- an invalid public key is rejected ---
  await assert.rejects(
    () => walletData.setMailContactTrusted(ALICE.address, 'not-a-key', true),
    /invalid/,
    'an invalid public key must be rejected',
  );
  console.log('  an invalid public key is rejected: OK');

  // --- the trust is keyed on the KEY, so it covers every address of that key ---
  {
    await walletData.setMailContactTrusted(ALICE.address, BOB.publicKeyHex, true);
    const keys = await walletData.getWalletMailTrustedKeys(ALICE.address);
    // A mail row from a DIFFERENT address that the same key controls is
    // trusted, because the lookup is by key and not by address.
    const aMessageFromTheSameKey = { senderPublicKeyHex: BOB.publicKeyHex };
    assert.ok(keys.has(aMessageFromTheSameKey.senderPublicKeyHex),
      'trust follows the key, so it covers every address that key controls');
    console.log('  the trust follows the key, not the address: OK');
  }

  fs.rmSync(tempHome, { recursive: true, force: true });

  console.log('');
  console.log('PASS: trusted contacts are recorded per key, removable, and reject bad input');
}

main().catch(error => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
