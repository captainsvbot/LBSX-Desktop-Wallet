// End-to-end attachment test against a REAL transaction:
//   build a mail transaction carrying an encrypted attachment
//   -> serialise it
//   -> parse it back the way the sync path does
//   -> discover the attachment output
//   -> decrypt the body and the attachment
//   -> confirm a third party with no key cannot read either
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const bip39 = require('bip39');
const {
  encryptMailMessage,
  decryptMailMessage,
  buildMailAad,
  randomMessageId,
  addressFromPublicKeyBytes,
  parsePublicKeyHex,
} = require('../electron/mail-crypto.cjs');
const {
  encryptAttachment,
  decryptAttachment,
  deriveRecipientKey,
  buildAttachmentScript,
  parseAttachmentOutput,
  findAttachmentOutputs,
  buildAttachmentAad,
} = require('../electron/mail-attachments.cjs');

function walletKey(byte) {
  const seed = bip39.mnemonicToSeedSync(bip39.entropyToMnemonic(Buffer.alloc(16, byte)));
  return bsv.HDPrivateKey.fromSeed(seed).deriveChild("m/44'/236'/0'/0/0").privateKey;
}

const alice = walletKey(0x11);
const bob = walletKey(0x22);
const eve = walletKey(0x33);
const aliceAddress = alice.toAddress().toString();
const bobAddress = bob.toAddress().toString();
const bobPubBytes = bob.publicKey.point.toBuffer();
const messageId = randomMessageId();
const timestamp = new Date().toISOString();

// A real-looking PNG: the 8-byte signature plus some pixels.
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-payload-'.repeat(2400)),
]);
assert.ok(png.length > 20 * 1024, 'the test attachment should be a realistic size');

console.log('=== END-TO-END ATTACHMENT TRANSACTION ===');
console.log('attachment size:', png.length.toLocaleString(), 'bytes');

// --- build the transaction exactly as sendMail does ---
const { startMailKeyExchange } = require('../electron/mail-crypto.cjs');
const exchange = startMailKeyExchange({ recipientPublicKey: bobPubBytes });

const { envelope, aad } = encryptMailMessage({
  recipientPublicKey: bobPubBytes,
  subject: 'Holiday photo',
  body: 'Here is the photo we talked about.',
  sender: aliceAddress,
  recipient: bobAddress,
  messageId,
  exchange,
});

const payloadPushes = ['LBSX', 'v2', 'mail', aliceAddress, bobAddress, messageId, timestamp, JSON.stringify(envelope)];

const attachment = encryptAttachment({
  key: exchange.key,
  data: png,
  fileName: 'holiday photo.png',
  mimeType: 'image/png',
  sender: aliceAddress,
  recipient: bobAddress,
  messageId,
});
const attachmentScript = buildAttachmentScript(attachment, messageId);

const tx = new bsv.Transaction()
  .from([{ txId: 'a'.repeat(64), outputIndex: 0, script: bsv.Script.fromAddress(aliceAddress), satoshis: 50000 }])
  .to(bobAddress, 1)
  .addOutput(new bsv.Transaction.Output({ script: bsv.Script.buildSafeDataOut(payloadPushes), satoshis: 0 }))
  .addOutput(new bsv.Transaction.Output({ script: attachmentScript, satoshis: 0 }))
  .change(aliceAddress)
  .feePerKb(1000)
  .sign(alice);

const rawHex = tx.toString();
console.log('transaction size:', (rawHex.length / 2).toLocaleString(), 'bytes of 100,000');
assert.ok(rawHex.length / 2 < 100000, 'the transaction must fit inside the BSV limit');

// --- parse it back the way the sync path does ---
const parsed = new bsv.Transaction().fromBuffer(Buffer.from(rawHex, 'hex'));
const outputs = parsed.outputs.map((output, index) => ({ index, script: output.script }));

const mailOutput = outputs.find(row => {
  const chunks = row.script.chunks || [];
  const marker = chunks.findIndex(chunk => chunk.opcodenum === 0x6a);
  if (marker < 0) return false;
  return chunks.slice(marker + 1).length === 8
    && chunks[marker + 3].buf.toString('utf8') === 'mail';
});
assert.ok(mailOutput, 'the mail output must be found');

const chunks = mailOutput.script.chunks;
const marker = chunks.findIndex(chunk => chunk.opcodenum === 0x6a);
const pushes = chunks.slice(marker + 1).map(chunk => Buffer.from(chunk.buf));
assert.equal(pushes[0].toString('utf8'), 'LBSX');
assert.equal(pushes[2].toString('utf8'), 'mail');
assert.equal(pushes[3].toString('utf8'), aliceAddress);
assert.equal(pushes[4].toString('utf8'), bobAddress);

const parsedEnvelope = JSON.parse(pushes[7].toString('utf8'));

// --- discover the attachment output ---
const found = findAttachmentOutputs({ outputs }, messageId);
assert.equal(found.length, 1, 'exactly one attachment output must be discovered');
assert.equal(found[0].fileName, 'holiday_photo.png', 'the file name is sanitised and must survive the round trip');
assert.equal(found[0].mimeType, 'image/png');
assert.equal(found[0].byteLength, png.length);

// --- decrypt the body ---
const bodyKey = deriveRecipientKey({
  recipientPrivateKeyBytes: bob.toBuffer(),
  ephemeralPublicKeyBytes: Buffer.from(parsedEnvelope.e, 'base64'),
});
const opened = decryptMailMessage({
  recipientPrivateKey: bob.toBuffer(),
  envelope: parsedEnvelope,
  aad: buildMailAad({ sender: aliceAddress, recipient: bobAddress, messageId }),
});
assert.equal(opened.subject, 'Holiday photo');
assert.equal(opened.body, 'Here is the photo we talked about.');
console.log('body decrypted: subject =', JSON.stringify(opened.subject));

// --- decrypt the attachment ---
const attachmentOutput = outputs.find(row => row.index === found[0].vout);
const parsedAttachment = parseAttachmentOutput(attachmentOutput.script, messageId);
assert.ok(parsedAttachment, 'the attachment output must parse');

const attachmentAad = buildAttachmentAad({
  sender: aliceAddress,
  recipient: bobAddress,
  messageId,
  fileName: parsedAttachment.fileName,
  mimeType: parsedAttachment.mimeType,
  byteLength: parsedAttachment.byteLength,
});
const recovered = decryptAttachment({ key: bodyKey, envelope: parsedAttachment, aad: attachmentAad });
assert.ok(recovered.equals(png), 'the attachment must round-trip byte-identically');
console.log('attachment decrypted:', recovered.length.toLocaleString(), 'bytes, identical =', recovered.equals(png));
console.log('png signature preserved:', recovered.subarray(0, 8).toString('hex'));

// --- a third party cannot read either ---
const eveKey = deriveRecipientKey({
  recipientPrivateKeyBytes: eve.toBuffer(),
  ephemeralPublicKeyBytes: Buffer.from(parsedEnvelope.e, 'base64'),
});
assert.throws(
  () => decryptMailMessage({
    recipientPrivateKey: eve.toBuffer(),
    envelope: parsedEnvelope,
    aad: buildMailAad({ sender: aliceAddress, recipient: bobAddress, messageId }),
  }),
  /could not be decrypted|authenticate|decrypt/i,
  'a third party must not be able to read the body',
);
assert.throws(
  () => decryptAttachment({ key: eveKey, envelope: parsedAttachment, aad: attachmentAad }),
  /could not be authenticated or decoded/,
  'a third party must not be able to read the attachment',
);
console.log('third party with no key: blocked on both body and attachment');

// --- the plaintext must not appear anywhere in the raw transaction ---
const rawText = rawHex.toLowerCase();
const pngHex = png.subarray(0, 64).toString('hex');
assert.ok(!rawText.includes(pngHex), 'the attachment plaintext must not appear in the raw transaction');
const bodySnippet = 'Here is the photo we talked about'.toLowerCase();
assert.ok(!rawText.includes(Buffer.from(bodySnippet).toString('hex')), 'the body must not appear in the raw transaction');
console.log('raw transaction contains no plaintext of either payload: confirmed');

console.log('');
console.log('PASS: a real transaction carries an encrypted attachment, both payloads decrypt for the recipient only, and neither plaintext leaks into the raw transaction');
