// Tests the mail RECIPIENT check.
//
// A mail transaction touches three addresses: the sender (who funds it), the
// recipient (who it is encrypted to, and who gets the anchor payment), and
// the admin wallet (which is paid the service fee). Every one of those sees
// the transaction in its own address history.
//
// So the transaction being in a wallet's history proves NOTHING. Without a
// check on the payload's recipient, the admin wallet collects the service fee
// on every mail anyone sends and then finds every one of those mails in its
// own inbox as "cannot decrypt" - which is exactly what happened.
//
// This test uses the REAL transaction structure from the chain:
//   input[0]  = the sender
//   output[0] = the anchor payment to the RECIPIENT
//   output[1] = the service fee to the ADMIN wallet
//   output[2] = the mail OP_RETURN
//   output[3] = change back to the sender
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsv = require('bsv');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lbsx-mail-recipient-'));
process.env.LBSX_WALLET_HOME = tempHome;

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
    app: { getPath: () => tempHome, getVersion: () => '2.1.17', isPackaged: false },
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
module.exports = {
  getWalletDataEncryptionKey: () => crypto.createHash('sha256').update('lbsx-recipient-test').digest(),
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

const mail = require('../electron/mail.cjs');

console.log('=== MAIL RECIPIENT CHECK ===');

// The addresses from the real transaction b412ae8b.
const SENDER = '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE';
const RECIPIENT = '1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut';
const ADMIN = '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB';

async function main() {
  // -------------------------------------------------------------------
  // 1. The mail IS for the recipient.
  // -------------------------------------------------------------------
  {
    assert.equal(mail.isMailForWallet({ recipient: RECIPIENT }, RECIPIENT), true,
      'the recipient must recognise its own mail');
    console.log('  the recipient recognises its own mail: OK');
  }

  // -------------------------------------------------------------------
  // 2. The mail is NOT for the admin wallet, even though the admin wallet
  //    is IN the transaction and was paid the service fee.
  // -------------------------------------------------------------------
  {
    assert.equal(mail.isMailForWallet({ recipient: RECIPIENT }, ADMIN), false,
      'the admin wallet must NOT claim a mail it was only paid a fee for');
    assert.equal(mail.isMailForWallet({ recipient: RECIPIENT }, SENDER), false,
      'the sender must NOT claim the received mail as an incoming one');
    console.log('  the admin wallet does not claim the mail it was paid for: OK');
  }

  // -------------------------------------------------------------------
  // 3. A missing or malformed recipient is never a match.
  // -------------------------------------------------------------------
  {
    assert.equal(mail.isMailForWallet({ recipient: '' }, ADMIN), false);
    assert.equal(mail.isMailForWallet({}, RECIPIENT), false);
    assert.equal(mail.isMailForWallet(null, RECIPIENT), false);
    assert.equal(mail.isMailForWallet({ recipient: RECIPIENT }, ''), false);
    console.log('  a missing or malformed recipient is never a match: OK');
  }

  // -------------------------------------------------------------------
  // 4. The check is EXACT, not a prefix match. An address that merely
  //    starts with the wallet's address is a different wallet.
  // -------------------------------------------------------------------
  {
    assert.equal(mail.isMailForWallet({ recipient: `${ADMIN}extra` }, ADMIN), false,
      'the check must be exact, not a prefix match');
    assert.equal(mail.isMailForWallet({ recipient: ADMIN.toLowerCase() }, ADMIN), true,
      'the check must ignore case');
    console.log('  the check is exact and case-insensitive: OK');
  }

  // -------------------------------------------------------------------
  // 5. The REAL transaction's outputs prove the structure the check
  //    relies on: output 0 pays the RECIPIENT, output 1 pays the ADMIN.
  // -------------------------------------------------------------------
  {
    const txid = 'b412ae8b29c8dc26bd1117cba437235dc9603311fbeb33e1a395fd7f673e4f0b';
    const response = await fetch(`https://bananablocks.com/api/v1/tx/${txid}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!response.ok) throw new Error(`tx lookup HTTP ${response.status}`);
    const body = await response.json();
    const tx = body.result || body;
    const outputs = tx.outputs || [];
    const byAddress = outputs.map(output => ({ value: output.value, address: output.address }));

    // The anchor goes to the recipient and the service fee to the admin.
    const anchor = byAddress.find(output => output.address === RECIPIENT);
    const fee = byAddress.find(output => output.address === ADMIN);
    assert.ok(anchor, 'the transaction pays the recipient');
    assert.ok(fee, 'the transaction pays the admin wallet');
    assert.equal(anchor.value, 3, 'the recipient anchor is 3 sats');
    assert.equal(fee.value, 1000, 'the service fee is 1000 sats');

    // The admin wallet is in the transaction, and the mail is still not
    // for it - which is the whole point of the check.
    assert.equal(mail.isMailForWallet({ recipient: RECIPIENT }, ADMIN), false);
    console.log('  the real transaction confirms the structure: OK');
  }

  console.log('');
  console.log('PASS: a mail is only for the wallet it was encrypted to, not for one that was merely paid a fee');
}

main().catch(error => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
