import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const bip39 = require('bip39');
const {
  addressFromPublicKeyBytes,
  parsePublicKeyHex,
  publicKeyBytes,
} = require('../electron/mail-crypto.cjs');
const { validateContact } = require('../electron/mail.cjs');

// Real wallet keys are seed-derived and therefore COMPRESSED.
// PrivateKey.fromBuffer() yields an UNCOMPRESSED public key, which is a
// different public key and hashes to a different address - that is correct
// behaviour, not a bug. These fixtures must therefore use realistic keys.
function walletKey(entropyByte) {
  const seed = bip39.mnemonicToSeedSync(bip39.entropyToMnemonic(Buffer.alloc(16, entropyByte)));
  return bsv.HDPrivateKey.fromSeed(seed).deriveChild("m/44'/236'/0'/0/0").privateKey;
}

const bob = walletKey(0x42);
const bobAddress = bob.toAddress().toString();
const bobPubHex = publicKeyBytes(bob.publicKey).toString('hex');

assert.equal(bob.publicKey.compressed, true, 'a seed-derived wallet key must be compressed');

// --- The two derivations must agree for a real wallet key ---
const viaHash160 = addressFromPublicKeyBytes(parsePublicKeyHex(bobPubHex));
const viaBsvFromHex = bsv.Address.fromPublicKey(bsv.PublicKey.fromHex(bobPubHex), 'livenet').toString();

assert.equal(viaHash160, bobAddress, 'hash160 over the compressed bytes must derive the wallet address');
assert.equal(viaBsvFromHex, bobAddress, "bsv's own fromHex path must also derive the wallet address");
assert.equal(viaHash160, viaBsvFromHex, 'both derivations must agree for a compressed wallet key');

// --- Contact validation must accept a genuine wallet key ---
const contact = validateContact({ address: bobAddress, publicKeyHex: bobPubHex, label: 'Bob' });
assert.equal(contact.address, bobAddress, 'a genuine wallet key must be accepted as a contact');

// --- And reject a mismatched pair ---
const other = walletKey(0x43);
assert.throws(
  () => validateContact({ address: bobAddress, publicKeyHex: publicKeyBytes(other.publicKey).toString('hex') }),
  /does not match the address/,
  'a public key that belongs to a different address must be rejected',
);

// --- An UNCOMPRESSED key is a genuinely different public key ---
// It must not be silently accepted for the compressed address.
const uncompressedKey = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 0x42));
const uncompressedHex = uncompressedKey.publicKey.toHex();
assert.throws(
  () => validateContact({ address: bobAddress, publicKeyHex: uncompressedHex }),
  /not a valid compressed secp256k1 key|does not match the address/,
  'an uncompressed key must not be accepted as the compressed wallet key',
);

// --- The wallet's own address derivation is never affected by mail code ---
assert.equal(bob.toAddress().toString(), bobAddress, 'the wallet address path is unchanged by mail');

console.log('PASS: compressed wallet keys derive the correct address by both paths, contacts validate correctly, and mismatched or uncompressed keys are rejected');
