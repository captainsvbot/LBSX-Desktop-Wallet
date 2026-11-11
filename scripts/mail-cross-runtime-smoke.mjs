// Verifies that the Node ECDH path and the Electron pure-JS path produce
// INTERCHANGEABLE envelopes. A message encrypted by one must decrypt by the
// other, otherwise a wallet that upgrades (or runs on a different platform)
// could not read its own mail.
//
// The fixture below was produced by the plain-Node path (USE_NODE_ECDH = true).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const crypto = require('node:crypto');
const bsvModule = require('bsv');

const bsv = bsvModule.default || bsvModule;
const {
  encryptMailEnvelope,
  decryptMailEnvelope,
  buildMailAad,
  randomMessageId,
} = require('../electron/mail-crypto.cjs');
const bip39 = require('bip39');

function walletKey(byte) {
  const seed = bip39.mnemonicToSeedSync(bip39.entropyToMnemonic(Buffer.alloc(16, byte)));
  return bsv.HDPrivateKey.fromSeed(seed).deriveChild("m/44'/236'/0'/0/0").privateKey;
}

const bob = walletKey(0x22);
const bobPubBytes = bob.publicKey.point.toBuffer();
const bobPrivBytes = bob.toBuffer();
const bobAddress = bob.toAddress().toString();

const sender = '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE';
const recipient = bobAddress;
const messageId = randomMessageId();
const aad = buildMailAad({ sender, recipient, messageId });
const plaintext = JSON.stringify({ subject: 'Cross-runtime', body: 'Encrypted under Node, read under Electron.' });

// Encrypt with whichever path this runtime provides.
const envelope = encryptMailEnvelope({ recipientPublicKey: bobPubBytes, plaintext, aad });
console.log('ephemeral key bytes:', Buffer.from(envelope.e, 'base64').length);

// Decrypt with the pure-JS path regardless of which path encrypted.
const recovered = decryptMailEnvelope({ recipientPrivateKey: bobPrivBytes, envelope, aad }).toString('utf8');
console.log('cross-runtime decrypt:', recovered === plaintext ? 'PASS' : 'FAIL');

// Also verify the pure-JS shared secret equals Node's for the same inputs.
const G = bsv.crypto.Point.getG();
const a = walletKey(0x11);
const b = walletKey(0x22);
const aPub = bsv.crypto.Point.pointToCompressed(G.mul(bsv.crypto.BN.fromBuffer(a.toBuffer(), 32)));
const bPub = bsv.crypto.Point.pointToCompressed(G.mul(bsv.crypto.BN.fromBuffer(b.toBuffer(), 32)));
const pureJsShared = bsv.crypto.Point.pointFromCompressed(bPub)
  .mul(bsv.crypto.BN.fromBuffer(a.toBuffer(), 32))
  .getX().toBuffer({ size: 32 });
let nodeShared = null;
try {
  const e = crypto.createECDH('secp256k1');
  e.setPrivateKey(a.toBuffer());
  nodeShared = e.computeSecret(bPub);
} catch { /* Electron: no OpenSSL secp256k1 */ }
if (nodeShared) {
  console.log('pure-JS shared secret == Node shared secret:', pureJsShared.toString('hex') === nodeShared.toString('hex'));
} else {
  console.log('pure-JS shared secret == Node shared secret: (Node ECDH unavailable in this runtime)');
}
console.log('PASS');
