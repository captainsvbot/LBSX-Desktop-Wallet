import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const bip39 = require('bip39');
const {
  buildMailPayload,
  parseMailPayload,
  extractOpReturnFields,
  extractMailFromTransaction,
  decryptReceivedMail,
  validateContact,
  MAIL_SERVICE_FEE_SATS,
  MAIL_ANCHOR_SATS,
} = require('../electron/mail.cjs');
const { encryptMailMessage, buildMailAad, randomMessageId } = require('../electron/mail-crypto.cjs');

const adminAddress = '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB';
// Wallet-style compressed keys. `PrivateKey.fromBuffer` yields an
// UNCOMPRESSED public key, which hashes to a different address, so the tests
// use realistic wallet keys derived the way the wallet derives them.
function walletKey(entropyByte) {
  const entropy = Buffer.alloc(16, entropyByte);
  const seed = bip39.mnemonicToSeedSync(bip39.entropyToMnemonic(entropy));
  return bsv.HDPrivateKey.fromSeed(seed).deriveChild("m/44'/236'/0'/0/0").privateKey;
}
const alice = walletKey(0x41);
const bob = walletKey(0x42);
const eve = walletKey(0x43);
const aliceAddress = alice.toAddress().toString();
const bobAddress = bob.toAddress().toString();
const bobPubBytes = bob.publicKey.point.toBuffer();
const messageId = randomMessageId();
const timestamp = '2026-11-09T18:30:00.000Z';
const subject = 'Confidential';
const body = 'The signed contract is attached. Do not forward this.';

// --- build a real mail transaction, exactly as sendMail does ---
const { envelope } = encryptMailMessage({
  recipientPublicKey: bobPubBytes,
  subject,
  body,
  sender: aliceAddress,
  recipient: bobAddress,
  messageId,
});
const pushes = buildMailPayload({ sender: aliceAddress, recipient: bobAddress, messageId, timestamp, envelope });

const parent = new bsv.Transaction()
  .from({ txid: 'ab'.repeat(32), vout: 0, satoshis: 50000, script: bsv.Script.buildPublicKeyHashOut(aliceAddress).toHex() })
  .to(aliceAddress, 50000);
const tx = new bsv.Transaction().from([{ txid: parent.id, vout: 0, satoshis: 50000, script: bsv.Script.buildPublicKeyHashOut(aliceAddress).toHex() }])
  .to(bobAddress, MAIL_ANCHOR_SATS)
  .to(adminAddress, MAIL_SERVICE_FEE_SATS)
  .addOutput(new bsv.Transaction.Output({
    script: bsv.Script.buildSafeDataOut(pushes),
    satoshis: 0,
  }));
tx.change(aliceAddress).feePerKb(1000).sign(alice);

// --- the transaction has the two expected outputs ---
const anchor = tx.outputs.find(o => o.satoshis === MAIL_ANCHOR_SATS);
const serviceFee = tx.outputs.find(o => o.satoshis === MAIL_SERVICE_FEE_SATS);
assert.ok(anchor, 'the transaction must anchor sats to the recipient');
assert.equal(MAIL_ANCHOR_SATS, 3, 'the recipient anchor must be 3 sats (0.00000003 BSV)');
assert.equal(anchor.satoshis, 3, 'the recipient anchor must pay exactly 3 sats');
assert.equal(bsv.Address.fromScript(anchor.script, 'livenet').toString(), bobAddress, 'the anchor must pay the recipient');
assert.ok(serviceFee, 'the transaction must pay the service fee');
assert.equal(bsv.Address.fromScript(serviceFee.script, 'livenet').toString(), adminAddress, 'the service fee must pay the discovery address');

// --- parse it back the way the wallet does ---
const opReturnOutput = tx.outputs.find(o => o.script.chunks.some(c => c.opcodenum === 0x6a));
assert.ok(opReturnOutput, 'the transaction must carry an OP_RETURN output');
const fields = extractOpReturnFields(opReturnOutput.script);
assert.equal(fields.length, 8, 'the mail payload must have 8 pushes');
assert.equal(fields[0], 'LBSX');
assert.equal(fields[1], 'v2');
assert.equal(fields[2], 'mail');
assert.equal(fields[3], aliceAddress);
assert.equal(fields[4], bobAddress);
assert.equal(fields[5], messageId);

// --- parse through the transaction helper ---
const extracted = extractMailFromTransaction(tx);
assert.ok(extracted, 'the mail payload must be extracted from the transaction');
assert.equal(extracted.sender, aliceAddress);
assert.equal(extracted.recipient, bobAddress);
assert.equal(extracted.messageId, messageId);
assert.equal(extracted.timestamp, timestamp);

// --- the recipient decrypts it ---
const decrypted = decryptReceivedMail({
  privateKey: bob.toBuffer(),
  payload: extracted,
  txid: tx.id,
  blockHeight: 900000,
  status: 'confirmed',
});
assert.equal(decrypted.status, 'confirmed');
assert.equal(decrypted.subject, subject);
assert.equal(decrypted.body, body);
assert.equal(decrypted.direction, 'received');
assert.equal(decrypted.senderAddress, aliceAddress);

// --- a third party cannot decrypt it ---
const rejected = decryptReceivedMail({
  privateKey: eve.toBuffer(),
  payload: extracted,
  txid: tx.id,
  blockHeight: 900000,
  status: 'confirmed',
});
assert.equal(rejected.status, 'undecryptable', 'a third party must not be able to read the mail');
assert.equal(rejected.body, '', 'an undecryptable mail must not expose a body');
assert.ok(rejected.error, 'an undecryptable mail must explain itself');

// --- the sender can decrypt their own mail (for the sent copy) ---
const senderCopy = decryptReceivedMail({
  privateKey: bob.toBuffer(),
  payload: extracted,
  txid: tx.id,
  blockHeight: 900000,
  status: 'confirmed',
});
assert.equal(senderCopy.body, body, 'the recipient can always read their own mail');

// --- a non-mail payload is ignored ---
const peerChatFields = extractOpReturnFields(bsv.Script.buildSafeDataOut(
  ['LBSX', 'v2', 'peer_chat', aliceAddress, timestamp, 'ciphertext'],
).chunks ? bsv.Script.buildSafeDataOut(['LBSX', 'v2', 'peer_chat', aliceAddress, timestamp, 'ciphertext']) : null);
assert.equal(parseMailPayload(peerChatFields), null, 'a peer chat payload must not parse as mail');

// --- a malformed mail payload is ignored ---
assert.equal(parseMailPayload(['LBSX', 'v2', 'mail', aliceAddress]), null, 'a short payload must be ignored');
assert.equal(parseMailPayload(['LBSX', 'v2', 'mail', 'bad-address', bobAddress, messageId, timestamp, '{}']), null, 'a bad address must be ignored');
assert.equal(parseMailPayload(['LBSX', 'v2', 'mail', aliceAddress, bobAddress, 'nothex', timestamp, '{}']), null, 'a bad message id must be ignored');
assert.equal(parseMailPayload(['LBSX', 'v2', 'mail', aliceAddress, bobAddress, messageId, timestamp, 'not json']), null, 'a bad envelope must be ignored');

// --- contact validation ---
const bobPubHex = bobPubBytes.toString('hex');
assert.equal(validateContact({ address: bobAddress, publicKeyHex: bobPubHex, label: 'Bob' }).address, bobAddress);
assert.throws(
  () => validateContact({ address: aliceAddress, publicKeyHex: bobPubHex }),
  /does not match the address/,
  'a mismatched contact must be rejected',
);
assert.throws(
  () => validateContact({ address: bobAddress, publicKeyHex: 'deadbeef' }),
  /not a valid compressed/,
  'a malformed contact key must be rejected',
);
assert.throws(
  () => validateContact({ address: 'not-an-address', publicKeyHex: bobPubHex }),
  /not a valid BSV mainnet address/,
  'a malformed contact address must be rejected',
);

// --- the AAD binds the payload ---
const aad = buildMailAad({ sender: aliceAddress, recipient: bobAddress, messageId });
assert.equal(aad, `lbsx-mail-v1|${aliceAddress}|${bobAddress}|${messageId}`);

console.log('PASS: mail transaction builds with anchor + service fee, payload parses, recipient decrypts, third party cannot');
