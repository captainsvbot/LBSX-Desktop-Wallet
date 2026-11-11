// Tests three things the mail feature gained together:
//
//   1. DRAFTS - unsent mail saved locally, never broadcast.
//   2. THREADS - a conversation is grouped by its root message id, and the
//      messages inside it are ordered OLDEST FIRST.
//   3. ATTACHMENTS - the whole mail must stay under 50 MB, with no cap on the
//      number of files.
//
// The thread test is the important one: the thread id travels INSIDE the
// encrypted envelope, so it must survive a real encrypt/decrypt round trip
// and must NOT change the wire format (an old wallet has to be able to read
// a new mail).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsv = require('bsv');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lbsx-mail-thread-'));
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
    app: { getPath: () => tempHome, getVersion: () => '2.1.16', isPackaged: false },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: value => Buffer.from(String(value), 'utf8'),
      decryptString: buffer => buffer.toString('utf8'),
    },
  },
};

// The vault stub must return a FRESH key each call: wallet-data.cjs wipes the
// key buffer with fill(0) after use.
const vaultStubPath = path.join(tempHome, 'vault-stub.cjs');
fs.writeFileSync(vaultStubPath, `
const crypto = require('node:crypto');
module.exports = {
  getWalletDataEncryptionKey: () => crypto.createHash('sha256').update('lbsx-thread-test').digest(),
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
const mail = require('../electron/mail.cjs');
const mailCrypto = require('../electron/mail-crypto.cjs');

console.log('=== MAIL THREADS + DRAFTS ===');

const DERIVATION_PATH = "m/44'/0'/0'/0/0";
function derive(seedByte) {
  const key = bsv.HDPrivateKey.fromSeed(Buffer.alloc(32, seedByte))
    .deriveChild(DERIVATION_PATH).privateKey;
  return {
    privateKey: key,
    address: key.toAddress().toString(),
    publicKeyHex: key.toPublicKey().toHex(),
  };
}

const ALICE = derive(11);
const BOB = derive(22);

async function main() {
  // ---------------------------------------------------------------------
  // 1. The thread id survives a real encrypt/decrypt round trip.
  // ---------------------------------------------------------------------
  {
    const messageId = 'a'.repeat(64);
    const threadRootId = 'b'.repeat(64);
    const aad = mailCrypto.buildMailAad({
      sender: ALICE.address, recipient: BOB.address, messageId,
    });
    const { envelope } = mailCrypto.encryptMailMessage({
      recipientPublicKey: mailCrypto.parsePublicKeyHex(BOB.publicKeyHex),
      subject: 'Original subject',
      body: 'The first message of the conversation.',
      sender: ALICE.address,
      recipient: BOB.address,
      messageId,
      threadRootId,
    });
    const opened = mailCrypto.decryptMailMessage({
      recipientPrivateKey: BOB.privateKey.toBuffer(),
      envelope,
      aad,
    });
    assert.equal(opened.subject, 'Original subject');
    assert.equal(opened.threadRootId, threadRootId, 'the thread id must survive the round trip');
    console.log('  the thread id survives encrypt/decrypt: OK');
  }

  // ---------------------------------------------------------------------
  // 2. A mail with NO thread id decrypts with an empty thread root, and the
  //    envelope keeps its original 4-field shape (wire format unchanged).
  // ---------------------------------------------------------------------
  {
    const messageId = 'c'.repeat(64);
    const aad = mailCrypto.buildMailAad({
      sender: ALICE.address, recipient: BOB.address, messageId,
    });
    const { envelope } = mailCrypto.encryptMailMessage({
      recipientPublicKey: mailCrypto.parsePublicKeyHex(BOB.publicKeyHex),
      subject: 'Plain subject',
      body: 'No thread here.',
      sender: ALICE.address,
      recipient: BOB.address,
      messageId,
    });
    assert.deepEqual(Object.keys(envelope).sort(), ['c', 'e', 'i', 't'],
      'the envelope must keep its original four fields');
    const opened = mailCrypto.decryptMailMessage({
      recipientPrivateKey: BOB.privateKey.toBuffer(),
      envelope,
      aad,
    });
    assert.equal(opened.threadRootId, '', 'no thread id means an empty thread root');
    console.log('  a plain mail keeps the original envelope shape: OK');
  }

  // ---------------------------------------------------------------------
  // 3. An invalid thread id is rejected.
  // ---------------------------------------------------------------------
  {
    assert.throws(() => mailCrypto.normalizeThreadRootId('not-a-thread'), /invalid/);
    assert.throws(() => mailCrypto.normalizeThreadRootId('x'.repeat(64)), /invalid/);
    assert.equal(mailCrypto.normalizeThreadRootId(''), '');
    assert.equal(mailCrypto.normalizeThreadRootId('D'.repeat(64)), 'd'.repeat(64));
    console.log('  an invalid thread id is rejected: OK');
  }

  // ---------------------------------------------------------------------
  // 4. Threads group by root and order OLDEST FIRST.
  // ---------------------------------------------------------------------
  {
    const root = 'e'.repeat(64);
    const other = 'f'.repeat(64);
    const rows = [
      { messageId: '1', threadRootId: root, timestamp: '2026-11-10T03:00:00.000Z', subject: 'Third', direction: 'received' },
      { messageId: '2', threadRootId: root, timestamp: '2026-11-10T01:00:00.000Z', subject: 'First', direction: 'sent' },
      { messageId: '3', threadRootId: root, timestamp: '2026-11-10T02:00:00.000Z', subject: 'Second', direction: 'received' },
      { messageId: '4', threadRootId: other, timestamp: '2026-11-10T04:00:00.000Z', subject: 'Other thread', direction: 'sent' },
    ];
    const threads = mail.groupThreads(rows);
    assert.equal(threads.length, 2, 'two distinct threads');
    const conversation = threads.find(thread => thread.threadRootId === root);
    assert.ok(conversation, 'the conversation thread exists');
    assert.equal(conversation.messageCount, 3);
    // Oldest first: the first message of the conversation is at the top.
    assert.deepEqual(conversation.messages.map(row => row.subject),
      ['First', 'Second', 'Third'],
      'the messages in a thread must be ordered oldest first');
    // The thread is listed by its NEWEST message, so a fresh reply moves up.
    assert.equal(threads[0].threadRootId, other, 'threads are listed newest first');
    // The thread shows the FIRST message's subject, so the list reads as a
    // conversation rather than a pile of replies.
    assert.equal(conversation.subject, 'First');
    console.log('  threads group by root and order oldest first: OK');
  }

  // ---------------------------------------------------------------------
  // 5. A message with no thread root is its own thread.
  // ---------------------------------------------------------------------
  {
    const threads = mail.groupThreads([
      { messageId: '9', timestamp: '2026-11-10T01:00:00.000Z', subject: 'Standalone', direction: 'sent' },
    ]);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].threadRootId, '9', 'a message with no thread root roots itself');
    console.log('  a message with no thread root roots itself: OK');
  }

  // ---------------------------------------------------------------------
  // 6. DRAFTS persist, survive a reload, and can be deleted.
  // ---------------------------------------------------------------------
  {
    const draftId = '1'.repeat(64);
    const saved = await walletData.saveWalletMailDraft(ALICE.address, {
      draftId,
      recipient: BOB.address,
      recipientPublicKeyHex: BOB.publicKeyHex,
      subject: 'Half-written thought',
      body: 'Not ready to send yet.',
      attachments: [
        { fileName: 'notes.txt', mimeType: 'text/plain', byteLength: 12, dataBase64: Buffer.from('hello world!').toString('base64') },
      ],
      threadRootId: '2'.repeat(64),
      updatedAt: new Date('2026-11-10T05:00:00.000Z').toISOString(),
    });
    assert.ok(saved.draft, 'the save returns the stored draft');

    const drafts = await walletData.getWalletMailDrafts(ALICE.address);
    assert.equal(drafts.length, 1, 'the draft is listed');
    assert.equal(drafts[0].subject, 'Half-written thought');
    assert.equal(drafts[0].threadRootId, '2'.repeat(64), 'a draft keeps its thread');
    assert.equal(drafts[0].attachments.length, 1);
    assert.equal(drafts[0].attachments[0].fileName, 'notes.txt');
    // The attachment bytes are kept, so the file is still there to send later.
    assert.equal(
      Buffer.from(drafts[0].attachments[0].dataBase64, 'base64').toString('utf8'),
      'hello world!',
      'the attachment bytes must be preserved in the draft',
    );
    console.log('  a draft persists with its attachment bytes: OK');
  }

  // Saving the same draft id replaces it rather than duplicating it.
  {
    await walletData.saveWalletMailDraft(ALICE.address, {
      draftId: '1'.repeat(64),
      recipient: BOB.address,
      recipientPublicKeyHex: BOB.publicKeyHex,
      subject: 'Revised thought',
      body: 'Better now.',
      attachments: [],
      updatedAt: new Date('2026-11-10T06:00:00.000Z').toISOString(),
    });
    const drafts = await walletData.getWalletMailDrafts(ALICE.address);
    assert.equal(drafts.length, 1, 'saving the same draft id replaces it');
    assert.equal(drafts[0].subject, 'Revised thought');
    console.log('  saving the same draft id replaces it: OK');
  }

  // An invalid draft is rejected.
  {
    await assert.rejects(
      () => walletData.saveWalletMailDraft(ALICE.address, { draftId: 'nope' }),
      /invalid/,
      'an invalid draft id must be rejected',
    );
    await assert.rejects(
      () => walletData.saveWalletMailDraft(ALICE.address, {
        draftId: '3'.repeat(64), recipient: 'not-an-address', updatedAt: new Date().toISOString(),
      }),
      /invalid/,
      'an invalid recipient must be rejected',
    );
    console.log('  an invalid draft is rejected: OK');
  }

  // A draft can be deleted.
  {
    await walletData.deleteWalletMailDraft(ALICE.address, '1'.repeat(64));
    const drafts = await walletData.getWalletMailDrafts(ALICE.address);
    assert.equal(drafts.length, 0, 'the draft is gone');
    await assert.rejects(
      () => walletData.deleteWalletMailDraft(ALICE.address, '1'.repeat(64)),
      /not in the local mailbox/,
      'deleting a draft twice must be rejected',
    );
    console.log('  a draft can be deleted: OK');
  }

  // ---------------------------------------------------------------------
  // 7. The attachment budget is on the WHOLE mail, with no file-count cap.
  // ---------------------------------------------------------------------
  {
    const { MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES } = require('../electron/mail-attachments.cjs');
    assert.ok(MAX_ATTACHMENTS >= 20, 'many attachments must be allowed');
    assert.equal(MAX_TOTAL_ATTACHMENT_BYTES, 50 * 1024 * 1024, 'the whole mail is capped at 50 MB');

    // Twenty small files are fine.
    const many = Array.from({ length: 20 }, (_, index) => ({
      fileName: `file-${index}.txt`,
      mimeType: 'text/plain',
      dataBase64: Buffer.from(`content ${index}`).toString('base64'),
    }));
    const normalized = mail.normalizeAttachments(many);
    assert.equal(normalized.length, 20, 'all twenty attachments are accepted');
    console.log('  twenty attachments are accepted: OK');
  }

  // ---------------------------------------------------------------------
  // 8. The stored mail message keeps the thread root.
  // ---------------------------------------------------------------------
  {
    const txid = '9'.repeat(64);
    const messageId = '4'.repeat(64);
    const threadRootId = '5'.repeat(64);
    await walletData.saveWalletMailSnapshot(ALICE.address, {
      messages: [{
        txid,
        messageId,
        direction: 'sent',
        senderAddress: ALICE.address,
        recipientAddress: BOB.address,
        recipientPublicKeyHex: BOB.publicKeyHex,
        subject: 'A reply',
        body: 'Part two.',
        timestamp: new Date('2026-11-10T07:00:00.000Z').toISOString(),
        status: 'confirmed',
        blockHeight: 100,
        threadRootId,
      }],
    });
    const snapshot = await walletData.getWalletMailSnapshot(ALICE.address);
    const stored = snapshot.messages.find(row => row.messageId === messageId);
    assert.ok(stored, 'the message is stored');
    assert.equal(stored.threadRootId, threadRootId, 'the thread root is persisted');
    console.log('  the thread root is persisted with the message: OK');
  }

  fs.rmSync(tempHome, { recursive: true, force: true });

  console.log('');
  console.log('PASS: threads group and order correctly, drafts persist, and the attachment budget is on the whole mail');
}

main().catch(error => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
