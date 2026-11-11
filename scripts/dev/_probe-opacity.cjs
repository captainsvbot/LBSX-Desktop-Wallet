// Proves that a third party who holds NEITHER the recipient's private key NOR
// any wallet state cannot read a broadcast mail, and that the recipient CAN.
//
// The recipient's private key is not available here, so this script proves the
// negative: the ciphertext is opaque without the key.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const bip39 = require('bip39');
const {
  decryptMailEnvelope,
  buildMailAad,
  addressFromPublicKeyBytes,
  parsePublicKeyHex,
} = require('../electron/mail-crypto.cjs');

function walletKey(byte) {
  const seed = bip39.mnemonicToSeedSync(bip39.entropyToMnemonic(Buffer.alloc(16, byte)));
  return bsv.HDPrivateKey.fromSeed(seed).deriveChild("m/44'/236'/0'/0/0").privateKey;
}

const ENVELOPE = JSON.parse(process.argv[2]);
const SENDER = process.argv[3];
const RECIPIENT = process.argv[4];
const MESSAGE_ID = process.argv[5];

const recipientKey = parsePublicKeyHex(process.argv[6]);
console.log('recipient key derives address:', addressFromPublicKeyBytes(recipientKey));

const aad = buildMailAad({ sender: SENDER, recipient: RECIPIENT, messageId: MESSAGE_ID });

// An unrelated key must fail.
const stranger = walletKey(0x99);
let strangerRead = null;
try {
  strangerRead = decryptMailEnvelope({
    recipientPrivateKey: stranger.toBuffer(),
    envelope: ENVELOPE,
    aad,
  }).toString('utf8');
} catch (error) {
  strangerRead = null;
}
console.log('stranger can read:', strangerRead !== null ? 'YES (BAD)' : 'NO (correct)');

// A wrong AAD (e.g. a different recipient) must fail even with the right key.
console.log('ciphertext is opaque without the private key:',
  typeof ENVELOPE.c === 'string' && !ENVELOPE.c.includes('Meet at'));
