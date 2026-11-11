// Guards a bug that shipped once: the attachment's on-chain output index was
// recorded as a hardcoded "index + 1", which is wrong whenever the mail and
// the two payment outputs come first.
//
// The real transaction layout is:
//   0 = recipient (1 sat)
//   1 = discovery / service fee (1000 sats)
//   2 = the mail data output
//   3 = the first attachment
//
// So the first attachment is at vout 3, not 1.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const bip39 = require('bip39');

const { encryptMailMessage } = require('../electron/mail-crypto.cjs');
const { encryptAttachment, buildAttachmentScript } = require('../electron/mail-attachments.cjs');

function walletKey(byte) {
  const seed = bip39.mnemonicToSeedSync(bip39.entropyToMnemonic(Buffer.alloc(16, byte)));
  return bsv.HDPrivateKey.fromSeed(seed).deriveChild("m/44'/236'/0'/0/0").privateKey;
}

const alice = walletKey(0x11);
const bob = walletKey(0x22);
const aliceAddress = alice.toAddress().toString();
const bobAddress = bob.toAddress().toString();
const messageId = require('../electron/mail-crypto.cjs').randomMessageId();
const timestamp = new Date().toISOString();

const { startMailKeyExchange } = require('../electron/mail-crypto.cjs');
const exchange = startMailKeyExchange({ recipientPublicKey: bob.publicKey.point.toBuffer() });
const { envelope } = encryptMailMessage({
  recipientPublicKey: bob.publicKey.point.toBuffer(),
  subject: 'Layout',
  body: 'Checking the output indices.',
  sender: aliceAddress,
  recipient: bobAddress,
  messageId,
  exchange,
});

const payloadPushes = ['LBSX', 'v2', 'mail', aliceAddress, bobAddress, messageId, timestamp, JSON.stringify(envelope)];

// Build the transaction with the SAME shape sendMail uses.
const attachmentOutputs = [];
for (const [name, mime] of [['a.txt', 'text/plain'], ['b.txt', 'text/plain']]) {
  const encrypted = encryptAttachment({
    key: exchange.key,
    data: Buffer.from(`contents of ${name}`),
    fileName: name,
    mimeType: mime,
    sender: aliceAddress,
    recipient: bobAddress,
    messageId,
  });
  attachmentOutputs.push({ attachment: encrypted, script: buildAttachmentScript(encrypted, messageId) });
}

const tx = new bsv.Transaction()
  .from([{ txId: 'a'.repeat(64), outputIndex: 0, script: bsv.Script.fromAddress(aliceAddress), satoshis: 50000 }])
  .to(bobAddress, 1)
  .to('15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB', 1000)
  .addOutput(new bsv.Transaction.Output({ script: bsv.Script.buildSafeDataOut(payloadPushes), satoshis: 0 }));
for (const output of attachmentOutputs) {
  tx.addOutput(new bsv.Transaction.Output({ script: output.script, satoshis: 0 }));
}
const attachmentVouts = attachmentOutputs.map((_, index) => tx.outputs.length - attachmentOutputs.length + index);

console.log('=== ATTACHMENT OUTPUT INDEX ===');
console.log('total outputs:', tx.outputs.length);
console.log('recorded attachment vouts:', attachmentVouts.join(', '));

assert.equal(tx.outputs.length, 5, 'the transaction has 3 payment/mail outputs plus 2 attachments');
assert.deepEqual(attachmentVouts, [3, 4], 'the attachments must be at vout 3 and 4');

// Each recorded vout must actually point at that attachment.
for (let index = 0; index < attachmentVouts.length; index += 1) {
  const output = tx.outputs[attachmentVouts[index]];
  assert.ok(output, `the output at vout ${attachmentVouts[index]} must exist`);
  const chunks = output.script.chunks;
  const marker = chunks.findIndex(chunk => chunk.opcodenum === 0x6a);
  const pushes = chunks.slice(marker + 1).map(chunk => Buffer.from(chunk.buf));
  assert.equal(pushes[2].toString('utf8'), 'mail_attachment', `vout ${attachmentVouts[index]} must be an attachment`);
  assert.equal(pushes[4].toString('utf8'), attachmentOutputs[index].attachment.fileName, 'the file name must match');
}

// The discovery path must find the same indices from a hex script.
const { findAttachmentOutputs } = require('../electron/mail-attachments.cjs');
const discovered = findAttachmentOutputs(
  { outputs: tx.outputs.map((output, index) => ({ index, script_pubkey: output.script.toHex() })) },
  messageId,
);
console.log('discovered vouts from hex scripts:', discovered.map(a => a.vout).join(', '));
assert.deepEqual(discovered.map(a => a.vout), [3, 4], 'the discovery path must agree with the recorded indices');

console.log('');
console.log('PASS: the attachment output indices are the real on-chain positions, not a hardcoded offset');
