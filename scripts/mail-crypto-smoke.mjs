import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const bip39 = require('bip39');

// Derives a wallet-style key: compressed, on the wallet's derivation path.
// `PrivateKey.fromBuffer` yields an UNCOMPRESSED public key, which hashes to a
// different address, so the tests must use realistic wallet keys.
function walletKey(entropyByte) {
  const entropy = Buffer.alloc(16, entropyByte);
  const phrase = bip39.entropyToMnemonic(entropy);
  const seed = bip39.mnemonicToSeedSync(phrase);
  return bsv.HDPrivateKey.fromSeed(seed).deriveChild("m/44'/236'/0'/0/0").privateKey;
}

const alice = walletKey(0x11);
const bob = walletKey(0x22);
const eve = walletKey(0x33);
const aliceAddress = alice.toAddress().toString();
const bobAddress = bob.toAddress().toString();

// The wallet's own keys are compressed, so the address is hash160 over the
// compressed SEC1 bytes. Mail must agree with that exactly.
const bobPubBytes = bob.publicKey.point.toBuffer();
const bobPrivBytes = bob.toBuffer();
const evePrivBytes = eve.toBuffer();
assert.equal(
  bsv.Address.fromPublicKeyHash(bsv.crypto.Hash.sha256ripemd160(bobPubBytes), 'livenet').toString(),
  bobAddress,
  'the compressed public key must derive the wallet address',
);

const {
  encryptMailEnvelope,
  decryptMailEnvelope,
  encryptMailMessage,
  decryptMailMessage,
  buildMailAad,
  randomMessageId,
  MAX_BODY_LENGTH,
} = require('../electron/mail-crypto.cjs');

const messageId = randomMessageId();
const aad = buildMailAad({ sender: aliceAddress, recipient: bobAddress, messageId });
const plaintext = JSON.stringify({ subject: 'Contract', body: 'Meet at 0900. Bring the signed contract.' });

// --- 1. round trip ---
const envelope = encryptMailEnvelope({ recipientPublicKey: bobPubBytes, plaintext, aad });
const recovered = decryptMailEnvelope({ recipientPrivateKey: bobPrivBytes, envelope, aad }).toString('utf8');
assert.equal(recovered, plaintext, 'round trip must recover the plaintext exactly');

// --- 2. envelope shape ---
for (const field of ['e', 'i', 't', 'c']) {
  assert.equal(typeof envelope[field], 'string', `envelope.${field} must be a string`);
  assert.ok(envelope[field].length > 0, `envelope.${field} must not be empty`);
}
assert.equal(Buffer.from(envelope.e, 'base64').length, 33, 'ephemeral key must be 33 bytes');
assert.equal(Buffer.from(envelope.i, 'base64').length, 12, 'iv must be 12 bytes');
assert.equal(Buffer.from(envelope.t, 'base64').length, 16, 'tag must be 16 bytes');

// --- 3. wrong key cannot decrypt ---
assert.throws(
  () => decryptMailEnvelope({ recipientPrivateKey: evePrivBytes, envelope, aad }),
  /could not be authenticated or decoded/,
  'a third party must not be able to decrypt the mail',
);

// --- 4. tampered ciphertext is rejected ---
const tamperedCiphertext = { ...envelope, c: flipLastByte(envelope.c) };
assert.throws(
  () => decryptMailEnvelope({ recipientPrivateKey: bobPrivBytes, envelope: tamperedCiphertext, aad }),
  /could not be authenticated or decoded/,
  'a tampered ciphertext must be rejected',
);

// --- 5. tampered authentication tag is rejected ---
const tamperedTag = { ...envelope, t: flipLastByte(envelope.t) };
assert.throws(
  () => decryptMailEnvelope({ recipientPrivateKey: bobPrivBytes, envelope: tamperedTag, aad }),
  /could not be authenticated or decoded/,
  'a tampered authentication tag must be rejected',
);

// --- 6. AAD swap (recipient redirection) is rejected ---
const redirectedAad = buildMailAad({ sender: aliceAddress, recipient: eve.toAddress().toString(), messageId });
assert.throws(
  () => decryptMailEnvelope({ recipientPrivateKey: bobPrivBytes, envelope, aad: redirectedAad }),
  /could not be authenticated or decoded/,
  'redirecting the recipient must be rejected',
);

// --- 7. AAD with a different message id is rejected ---
const replayedAad = buildMailAad({ sender: aliceAddress, recipient: bobAddress, messageId: randomMessageId() });
assert.throws(
  () => decryptMailEnvelope({ recipientPrivateKey: bobPrivBytes, envelope, aad: replayedAad }),
  /could not be authenticated or decoded/,
  'replaying into a different message id must be rejected',
);

// --- 8. malformed envelopes are rejected before decryption ---
for (const bad of [
  { ...envelope, e: 'not base64!!' },
  { ...envelope, i: Buffer.from('short').toString('base64') },
  { ...envelope, t: Buffer.from('short').toString('base64') },
  { ...envelope, c: '' },
]) {
  assert.throws(
    () => decryptMailEnvelope({ recipientPrivateKey: bobPrivBytes, envelope: bad, aad }),
    /invalid|base64/,
    'a malformed envelope must be rejected',
  );
}

// --- 9. structured message round trip ---
const structured = encryptMailMessage({
  recipientPublicKey: bobPubBytes,
  subject: 'Re: deal',
  body: 'Agreed. Do not forward this.',
  sender: aliceAddress,
  recipient: bobAddress,
  messageId,
});
const opened = decryptMailMessage({ recipientPrivateKey: bobPrivBytes, envelope: structured.envelope, aad: structured.aad });
assert.equal(opened.subject, 'Re: deal');
assert.equal(opened.body, 'Agreed. Do not forward this.');

// --- 10. two envelopes for the same plaintext differ (fresh ephemeral key + iv) ---
const second = encryptMailEnvelope({ recipientPublicKey: bobPubBytes, plaintext, aad });
assert.notEqual(second.e, envelope.e, 'each message must use a fresh ephemeral key');
assert.notEqual(second.c, envelope.c, 'each message must use a fresh iv');

// --- 11. body size limits are enforced ---
assert.throws(
  () => encryptMailMessage({
    recipientPublicKey: bobPubBytes,
    subject: 'x',
    body: 'y'.repeat(MAX_BODY_LENGTH + 1),
    sender: aliceAddress,
    recipient: bobAddress,
    messageId,
  }),
  /too long/,
  'an oversized body must be rejected',
);

// --- 12. an invalid message id is rejected ---
assert.throws(
  () => buildMailAad({ sender: aliceAddress, recipient: bobAddress, messageId: 'not-hex' }),
  /message id is invalid/,
  'an invalid message id must be rejected',
);

function flipLastByte(base64) {
  const bytes = Buffer.from(base64, 'base64');
  bytes[bytes.length - 1] ^= 0x01;
  return bytes.toString('base64');
}

console.log('PASS: mail E2EE round-trip, wrong-key, tamper, AAD-swap, replay, malformed-envelope rejection, and size limits');
