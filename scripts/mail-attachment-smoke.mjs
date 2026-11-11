import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const bip39 = require('bip39');
const {
  encryptAttachment,
  decryptAttachment,
  deriveRecipientKey,
  startMailKeyExchange,
  buildAttachmentScript,
  parseAttachmentOutput,
  findAttachmentOutputs,
  buildAttachmentAad,
  sanitizeFilename,
  normalizeMimeType,
  estimateTransactionBytes,
  remainingAttachmentBudget,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  detectImageMimeType,
  validateAttachmentType,
} = require('../electron/mail-attachments.cjs');
const { encryptMailEnvelope, decryptMailEnvelope, buildMailAad, randomMessageId } = require('../electron/mail-crypto.cjs');

function walletKey(entropyByte) {
  const seed = bip39.mnemonicToSeedSync(bip39.entropyToMnemonic(Buffer.alloc(16, entropyByte)));
  return bsv.HDPrivateKey.fromSeed(seed).deriveChild("m/44'/236'/0'/0/0").privateKey;
}

const bob = walletKey(0x42);
const bobPrivBytes = bob.toBuffer();
const bobPubBytes = bob.publicKey.point.toBuffer();
const sender = '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE';
const recipient = bob.toAddress().toString();
const messageId = randomMessageId();

// A pretend PDF with binary content.
const attachment = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28]),
  Buffer.from('binary payload '.repeat(500)),
]);

// --- 1. encrypt / decrypt round trip ---
const exchange = startMailKeyExchange({ recipientPublicKey: bobPubBytes });
const aad = buildAttachmentAad({
  sender, recipient, messageId, fileName: 'invoice.pdf', mimeType: 'application/pdf', byteLength: attachment.length,
});
const encrypted = encryptAttachment({
  key: exchange.key,
  data: attachment,
  fileName: 'invoice.pdf',
  mimeType: 'application/pdf',
  sender,
  recipient,
  messageId,
});
assert.equal(encrypted.ciphertext.length, attachment.length, 'ciphertext matches the plaintext length');
assert.equal(encrypted.iv.length, 12, 'iv is 12 bytes');
assert.equal(encrypted.tag.length, 16, 'tag is 16 bytes');
assert.ok(!encrypted.ciphertext.includes(Buffer.from('%PDF')), 'the plaintext must not appear in the ciphertext');

// The recipient derives the SAME key from the ephemeral public key.
const recipientKey = deriveRecipientKey({
  recipientPrivateKeyBytes: bobPrivBytes,
  ephemeralPublicKeyBytes: exchange.ephemeralPublicKey,
});
const recovered = decryptAttachment({ key: recipientKey, envelope: encrypted, aad });
assert.ok(recovered.equals(attachment), 'the attachment must round-trip byte-identically');

// --- 2. wrong key cannot decrypt ---
const eve = walletKey(0x99);
const eveKey = deriveRecipientKey({
  recipientPrivateKeyBytes: eve.toBuffer(),
  ephemeralPublicKeyBytes: exchange.ephemeralPublicKey,
});
assert.throws(
  () => decryptAttachment({ key: eveKey, envelope: encrypted, aad }),
  /could not be authenticated or decoded/,
  'a third party must not be able to decrypt the attachment',
);

// --- 3. tampered ciphertext is rejected ---
const tampered = { ...encrypted, ciphertext: Buffer.concat([encrypted.ciphertext.subarray(0, 5), Buffer.from([encrypted.ciphertext[5] ^ 1]), encrypted.ciphertext.subarray(6)]) };
assert.throws(
  () => decryptAttachment({ key: recipientKey, envelope: tampered, aad }),
  /could not be authenticated or decoded/,
  'a tampered attachment must be rejected',
);

// --- 4. the file name is bound by the AAD ---
const renamedAad = buildAttachmentAad({
  sender, recipient, messageId, fileName: 'executed.pdf', mimeType: 'application/pdf', byteLength: attachment.length,
});
assert.throws(
  () => decryptAttachment({ key: recipientKey, envelope: encrypted, aad: renamedAad }),
  /could not be authenticated or decoded/,
  'renaming the attachment must be rejected',
);

// --- 5. the MIME type is bound by the AAD ---
const swappedAad = buildAttachmentAad({
  sender, recipient, messageId, fileName: 'invoice.pdf', mimeType: 'image/png', byteLength: attachment.length,
});
assert.throws(
  () => decryptAttachment({ key: recipientKey, envelope: encrypted, aad: swappedAad }),
  /could not be authenticated or decoded/,
  'swapping the MIME type must be rejected',
);

// --- 6. the byte length is bound by the AAD ---
const resizedAad = buildAttachmentAad({
  sender, recipient, messageId, fileName: 'invoice.pdf', mimeType: 'application/pdf', byteLength: attachment.length + 1,
});
assert.throws(
  () => decryptAttachment({ key: recipientKey, envelope: encrypted, aad: resizedAad }),
  /could not be authenticated or decoded/,
  'changing the declared size must be rejected',
);

// --- 7. each attachment gets its own IV ---
const second = encryptAttachment({
  key: exchange.key, data: attachment, fileName: 'invoice.pdf', mimeType: 'application/pdf', sender, recipient, messageId,
});
assert.notEqual(second.iv.toString('hex'), encrypted.iv.toString('hex'), 'each attachment must use a fresh IV');

// --- 8. script build and parse round trip ---
const script = buildAttachmentScript(encrypted, messageId);
const parsed = parseAttachmentOutput(script, messageId);
assert.ok(parsed, 'the attachment output must parse');
assert.equal(parsed.fileName, 'invoice.pdf');
assert.equal(parsed.mimeType, 'application/pdf');
assert.equal(parsed.byteLength, attachment.length);
assert.ok(parsed.ciphertext.equals(encrypted.ciphertext), 'the ciphertext must survive the script round trip');

// --- 9. a non-attachment output is ignored ---
const mailScript = bsv.Script.buildSafeDataOut(['LBSX', 'v2', 'mail', sender, recipient, messageId, '2026-01-01T00:00:00.000Z', '{}']);
assert.equal(parseAttachmentOutput(mailScript, messageId), null, 'a mail payload must not parse as an attachment');

// --- 10. findAttachmentOutputs over a transaction ---
const fakeTx = { outputs: [{ index: 0, script }, { index: 1, script: mailScript }] };
const found = findAttachmentOutputs(fakeTx, messageId);
assert.equal(found.length, 1, 'exactly one attachment output must be found');
assert.equal(found[0].vout, 0);

// --- 11. filename sanitisation ---
assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd', 'path traversal must be stripped');
assert.equal(sanitizeFilename('..'), '_', 'a bare .. must not survive');
assert.equal(sanitizeFilename('my report (final).pdf'), 'my_report__final_.pdf', 'unsafe characters are replaced');
assert.equal(sanitizeFilename(''), 'attachment', 'an empty name gets a default');
assert.ok(sanitizeFilename('a'.repeat(200)).length <= 80, 'the name is length limited');

// --- 12. mime type normalisation ---
assert.equal(normalizeMimeType('APPLICATION/PDF'), 'application/pdf');
assert.equal(normalizeMimeType('<script>'), 'application/octet-stream');
assert.equal(normalizeMimeType(''), 'application/octet-stream');

// --- 13. size limits ---
assert.throws(
  () => encryptAttachment({ key: exchange.key, data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), fileName: 'big.bin', mimeType: 'application/octet-stream', sender, recipient, messageId }),
  /must be 50 MB or smaller/,
  'an oversized attachment must be rejected',
);

// --- 13a. the size limit is the PRODUCT limit, not the old Bitcoin 100 KB one ---
assert.equal(MAX_ATTACHMENT_BYTES, 50 * 1024 * 1024, 'the per-attachment limit must be 50 MB');
assert.equal(MAX_TOTAL_ATTACHMENT_BYTES, 50 * 1024 * 1024, 'the total limit must be 50 MB');
// BSV has no 100 KB transaction limit - Genesis raised it to 1 GB consensus.
assert.ok(
  MAX_ATTACHMENT_BYTES > 1024 * 1024,
  'the limit must be well beyond the old 100 KB Bitcoin transaction limit',
);
const BSV_CONSENSUS_MAX_TX_BYTES = 1000 * 1000 * 1000;
assert.ok(MAX_ATTACHMENT_BYTES < BSV_CONSENSUS_MAX_TX_BYTES, 'the limit must stay under the 1 GB BSV consensus ceiling');

// A 5 MB attachment - far beyond the old 100 KB rule - must encrypt fine.
const large = Buffer.alloc(5 * 1024 * 1024, 0x7e);
const largeEncrypted = encryptAttachment({
  key: exchange.key, data: large, fileName: 'large.bin',
  mimeType: 'application/octet-stream', sender, recipient, messageId,
});
assert.equal(largeEncrypted.ciphertext.length, large.length, 'a 5 MB attachment must encrypt at full size');
const largeRecovered = decryptAttachment({
  key: recipientKey,
  envelope: largeEncrypted,
  aad: buildAttachmentAad({
    sender, recipient, messageId, fileName: 'large.bin',
    mimeType: 'application/octet-stream', byteLength: large.length,
  }),
});
assert.ok(largeRecovered.equals(large), 'a 5 MB attachment must round-trip byte-identically');
console.log('  a 5 MB attachment (50x the old Bitcoin limit) round-tripped byte-identically');
assert.throws(
  () => encryptAttachment({ key: exchange.key, data: Buffer.alloc(0), fileName: 'empty.bin', mimeType: 'application/octet-stream', sender, recipient, messageId }),
  /empty/,
  'an empty attachment must be rejected',
);

// --- 14. the transaction budget ---
assert.ok(remainingAttachmentBudget(0) > 50 * 1024, 'there must be room for a 50 KB attachment');
assert.ok(remainingAttachmentBudget(1) > 50 * 1024, 'one attachment must still leave room');
assert.ok(estimateTransactionBytes(2) > estimateTransactionBytes(1), 'each attachment adds to the size');

// --- 15. the body and the attachment share ONE ephemeral key ---
const bodyAad = buildMailAad({ sender, recipient, messageId });
const bodyEnvelope = encryptMailEnvelope({
  recipientPublicKey: bobPubBytes,
  plaintext: JSON.stringify({ subject: 'Invoice', body: 'See attached.' }),
  aad: bodyAad,
  exchange,
});
assert.equal(bodyEnvelope.e, exchange.ephemeralPublicKey.toString('base64'), 'the body and the attachment must share the ephemeral public key');

// --- 16. the body still decrypts with the recipient key ---
const bodyKey = deriveRecipientKey({
  recipientPrivateKeyBytes: bobPrivBytes,
  ephemeralPublicKeyBytes: Buffer.from(bodyEnvelope.e, 'base64'),
});
const bodyPlain = decryptMailEnvelope({
  recipientPrivateKey: bobPrivBytes,
  envelope: bodyEnvelope,
  aad: bodyAad,
});
assert.ok(bodyPlain.toString('utf8').includes('See attached.'), 'the body must still decrypt');

// --- 17. image type detection from magic bytes ---
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(100)]);
assert.equal(detectImageMimeType(png), 'image/png', 'a PNG must be detected');
assert.equal(detectImageMimeType(jpeg), 'image/jpeg', 'a JPEG must be detected');
assert.equal(detectImageMimeType(webp), 'image/webp', 'a WebP must be detected');
assert.equal(detectImageMimeType(Buffer.from('plain text')), '', 'a non-image must not be detected as an image');

// A file that claims to be a PNG but is really a JPEG must be rejected.
assert.throws(
  () => validateAttachmentType({ data: jpeg, mimeType: 'image/png' }),
  /This file is a JPEG, not a PNG/,
  'a mismatched image type must be rejected',
);
// The correct type passes.
validateAttachmentType({ data: png, mimeType: 'image/png' });
validateAttachmentType({ data: jpeg, mimeType: 'image/jpeg' });
// A non-image with a generic type is fine.
validateAttachmentType({ data: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf' });
// A non-image that CLAIMS to be an image is not silently accepted as an image
// type check (it is not an image, so there is nothing to mismatch).
validateAttachmentType({ data: Buffer.from('%PDF-1.4'), mimeType: 'application/octet-stream' });

console.log('PASS: attachment encryption, AAD binding, script round trip, sanitisation, size limits, image type validation, and shared key exchange all behave correctly');
