// Encrypted mail cryptography for the LBSX Desktop Wallet.
//
// This is ECIES-style end-to-end encryption over secp256k1:
//
//   shared_secret = ECDH(recipient_private_key, ephemeral_public_key)
//   key           = HKDF-SHA256(ikm=shared_secret, salt="", info="lbsx-mail-v1")
//   ciphertext    = AES-256-GCM(key, iv, plaintext, aad)
//
// Only the holder of the recipient's private key can decrypt the body. The chain
// observer, the indexer, and the wallet author all see ciphertext only.
//
// The AAD binds the ciphertext to its context. A message encrypted for Alice
// cannot be replayed as a message for Bob, because the recipient address is part
// of the authenticated data:
//
//   aad = "lbsx-mail-v1|" + sender_address + "|" + recipient_address + "|" + message_id
//
// IMPORTANT: this is NOT the Peer Chat obfuscation key. `peer-chat-crypto.cjs`
// derives its key from a public constant, which provides obfuscation against
// casual readers rather than confidentiality. Mail must use real ECDH against a
// recipient public key. See SECURITY.md for the full trust model.
//
// Node's native secp256k1 ECDH is used deliberately. `bsv@1.5.6` exposes ECDSA
// signing but no ECDH primitive, and `@bsv/sdk`'s ECIES helper only exposes the
// Electrum/Bitcore variants and operates on its own key types, which would
// require a key-conversion layer across two crypto stacks.

const crypto = require('node:crypto');
const bsvModule = require('bsv');

const bsv = bsvModule.default || bsvModule;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const PUBLIC_KEY_BYTES = 33;
const PRIVATE_KEY_BYTES = 32;
const HKDF_INFO = 'lbsx-mail-v1';
const AAD_PREFIX = 'lbsx-mail-v1';
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 8000;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Electron's bundled Node build exposes only a handful of OpenSSL curves and
// secp256k1 is NOT among them, so `crypto.createECDH('secp256k1')` throws
// "Failed to create key using named curve" inside the packaged app even though
// it works in a plain Node process. The wallet therefore computes the ECDH
// shared secret with bsv's own pure-JS secp256k1 point arithmetic, which is
// available everywhere and produces a byte-identical result.
//
// The shared secret is the X coordinate of the shared point, which is exactly
// what OpenSSL's ECDH returns for secp256k1 (32 bytes).
function nodeEcdhSupported() {
  try {
    const probe = crypto.createECDH('secp256k1');
    probe.generateKeys();
    return true;
  } catch {
    return false;
  }
}

const USE_NODE_ECDH = nodeEcdhSupported();

function pointFromCompressedBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== PUBLIC_KEY_BYTES) {
    throw new Error('The mail public key is invalid.');
  }
  return bsv.crypto.Point.pointFromCompressed(bytes);
}

// Pure-JS secp256k1 ECDH: shared = peerPoint * privateScalar, X coordinate only.
function ecdhSharedSecret(privateScalar, peerPublicKeyBytes) {
  const point = pointFromCompressedBytes(peerPublicKeyBytes);
  const scalar = bsv.crypto.BN.fromBuffer(privateScalar, PRIVATE_KEY_BYTES);
  const shared = point.mul(scalar);
  if (shared.isInfinity()) throw new Error('The mail key exchange failed.');
  return shared.getX().toBuffer({ size: PRIVATE_KEY_BYTES });
}

function isBase64(value) {
  if (typeof value !== 'string' || !value.length) return false;
  if (!BASE64_RE.test(value)) return false;
  const packed = Buffer.from(value, 'base64');
  return packed.toString('base64') === value;
}

function decodeBase64(value, label) {
  if (!isBase64(value)) throw new Error(`The mail ${label} is not valid base64.`);
  return Buffer.from(value, 'base64');
}

// Node's ECDH returns an uncompressed SEC1 point (65 bytes, 0x04 prefix). The
// mail wire format carries compressed SEC1 (33 bytes), matching the compressed
// public keys that bsv produces for P2PKH addresses.
function compressSec1(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('The mail public key is invalid.');
  if (buffer.length === PUBLIC_KEY_BYTES) return buffer;
  if (buffer.length !== 65 || buffer[0] !== 0x04) {
    throw new Error('The mail public key is not a valid secp256k1 point.');
  }
  const x = buffer.subarray(1, 33);
  const y = buffer.subarray(33, 65);
  const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;
  return Buffer.concat([Buffer.from([prefix]), x]);
}

// Builds the compressed SEC1 bytes (33 bytes) for a bsv PublicKey.
//
// `publicKey.point.toBuffer()` always returns the compressed form, but the
// `compressed` flag on the PublicKey instance is what decides whether
// `pubkey.toBuffer()` (and therefore the P2PKH address hash) uses the 33-byte or
// the 65-byte encoding. A wallet key derived from a seed is compressed, so the
// wallet's own address is hash160 over the compressed bytes. Mail must agree
// with that exactly, or contact validation would reject the user's own key.
function publicKeyBytes(publicKey) {
  if (!publicKey || typeof publicKey.point?.toBuffer !== 'function') {
    throw new Error('A valid recipient public key is required.');
  }
  return compressSec1(publicKey.point.toBuffer());
}

// Derives the P2PKH address that a compressed SEC1 public key controls.
//
// `bsv.PublicKey.fromBuffer` treats its input as DER, so raw SEC1 bytes must
// not be fed through it; the address is derived from the hash directly.
//
// For a real wallet key (seed-derived, therefore compressed) this produces the
// same address as `Address.fromPublicKey(PublicKey.fromHex(key))` - verified
// by `npm run test:mail-address-derivation`. Deriving it from the hash is used
// here because it is unambiguous about which bytes are hashed and does not
// depend on how a public-key parser sets its `compressed` flag.
//
// The wallet's OWN address is unaffected either way: it comes from
// `privateKey.toAddress()`, which this feature never touches.
function addressFromPublicKeyBytes(publicKeyBytesBuffer) {
  return bsv.Address.fromPublicKeyHash(
    bsv.crypto.Hash.sha256ripemd160(publicKeyBytesBuffer),
    'livenet',
  ).toString();
}

// Parses a compressed SEC1 hex public key into the bytes that control the
// given address, verifying that they actually match it.
function parsePublicKeyHex(publicKeyHex) {
  const hex = String(publicKeyHex || '').trim().toLowerCase();
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(hex)) {
    throw new Error('The public key is not a valid compressed secp256k1 key.');
  }
  const bytes = Buffer.from(hex, 'hex');
  // Reject a point that is not on the secp256k1 curve.
  try {
    bsv.crypto.Point.fromX(bytes[0] === 0x03, bytes.subarray(1));
  } catch {
    throw new Error('The public key is not a valid secp256k1 point.');
  }
  return bytes;
}

// 32-byte private scalar for a bsv PrivateKey or a raw buffer.
function privateKeyBytes(privateKey) {
  const bytes = Buffer.isBuffer(privateKey)
    ? privateKey
    : (typeof privateKey?.toBuffer === 'function' ? privateKey.toBuffer() : null);
  if (!Buffer.isBuffer(bytes) || bytes.length !== PRIVATE_KEY_BYTES) {
    throw new Error('The recipient private key is not a valid secp256k1 scalar.');
  }
  return bytes;
}

function deriveKey(sharedSecret) {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    sharedSecret,
    Buffer.alloc(0),
    Buffer.from(HKDF_INFO, 'utf8'),
    32,
  ));
}

// Builds the authenticated associated data for a mail message. Every field is
// covered by the GCM tag, so neither the sender, the recipient, nor the message
// id can be altered without the recipient detecting it.
function buildMailAad({ sender, recipient, messageId } = {}) {
  const senderAddress = String(sender || '').trim();
  const recipientAddress = String(recipient || '').trim();
  const id = String(messageId || '').trim().toLowerCase();
  if (!senderAddress || !recipientAddress) throw new Error('The mail sender and recipient are required.');
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('The mail message id is invalid.');
  return `${AAD_PREFIX}|${senderAddress}|${recipientAddress}|${id}`;
}

function randomMessageId() {
  return crypto.randomBytes(32).toString('hex');
}

// The THREAD ROOT is the message id of the FIRST message in a conversation.
//
// It has to be something BOTH sides can derive, so it is the original
// message's own id - which the recipient learns when they decrypt that first
// message, and the sender already has. A reply carries the root of the
// thread it belongs to; the first message of a thread carries its own id.
//
// It is a 32-byte hex id like a message id, and it is validated the same way.
function normalizeThreadRootId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!id) return '';
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw new Error('The mail thread id is invalid.');
  }
  return id;
}

/**
 * Starts a key exchange with the recipient and returns the material both the
 * mail body and any attachments derive from.
 *
 * The SAME ephemeral key pair is used for the whole message. That is what lets
 * the recipient derive one shared secret and decrypt every output from it.
 * Each individual payload still gets its OWN random IV and its OWN AAD, so
 * nonce reuse never happens.
 *
 * @param {{recipientPublicKey: Buffer}} options
 * @returns {{ephemeralPublicKey: Buffer, sharedSecret: Buffer, key: Buffer}}
 */
function startMailKeyExchange({ recipientPublicKey } = {}) {
  const recipientBytes = compressSec1(recipientPublicKey);
  let sharedSecret;
  let ephemeralPublicKey;
  if (USE_NODE_ECDH) {
    const ephemeral = crypto.createECDH('secp256k1');
    ephemeral.generateKeys();
    sharedSecret = ephemeral.computeSecret(recipientBytes);
    ephemeralPublicKey = compressSec1(ephemeral.getPublicKey());
  } else {
    // Pure-JS path (Electron): pick a random scalar and derive the ephemeral
    // public key from it, then compute the shared point.
    const scalar = crypto.randomBytes(PRIVATE_KEY_BYTES);
    const scalarBn = bsv.crypto.BN.fromBuffer(scalar, PRIVATE_KEY_BYTES);
    if (scalarBn.isZero() || scalarBn.cmp(bsv.crypto.Point.getN()) >= 0) {
      throw new Error('The mail key exchange failed.');
    }
    const generator = bsv.crypto.Point.getG();
    ephemeralPublicKey = bsv.crypto.Point.pointToCompressed(generator.mul(scalarBn));
    sharedSecret = ecdhSharedSecret(scalar, recipientBytes);
  }
  return { ephemeralPublicKey, sharedSecret, key: deriveKey(sharedSecret) };
}

/**
 * Encrypts a mail body to a recipient public key.
 * @param {{recipientPublicKey: Buffer, plaintext: string, aad: string, exchange?: object}} options
 *        recipientPublicKey is the compressed SEC1 public key (33 bytes).
 *        exchange may be a key exchange started with startMailKeyExchange, so
 *        the body and any attachments share ONE ephemeral key.
 * @returns {{e: string, i: string, t: string, c: string}} base64 envelope
 */
function encryptMailEnvelope({ recipientPublicKey, plaintext, aad, exchange } = {}) {
  const text = String(plaintext ?? '');
  const bytes = Buffer.from(text, 'utf8');
  if (!text.length || bytes.length > MAX_PLAINTEXT_BYTES) {
    throw new Error('The mail body exceeds the supported size.');
  }
  const associatedData = String(aad || '');
  if (!associatedData.startsWith(`${AAD_PREFIX}|`)) {
    throw new Error('The mail associated data is invalid.');
  }

  const material = exchange || startMailKeyExchange({ recipientPublicKey });
  const { ephemeralPublicKey } = material;
  // Work on a COPY of the key. When the caller passed an exchange, the key
  // buffer belongs to them and is still needed for the attachments - wiping it
  // here would encrypt the attachments with a zeroed key.
  const key = Buffer.from(material.key);
  const iv = crypto.randomBytes(IV_BYTES);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return {
      e: ephemeralPublicKey.toString('base64'),
      i: iv.toString('base64'),
      t: cipher.getAuthTag().toString('base64'),
      c: ciphertext.toString('base64'),
    };
  } finally {
    key.fill(0);
    // Only clear the shared secret when this function created the exchange.
    // When the caller passed one, it owns that material and may still need it
    // for the attachments.
    if (!exchange && material.sharedSecret) material.sharedSecret.fill(0);
  }
}

/**
 * Decrypts a mail body with the recipient private key.
 * @param {{recipientPrivateKey: Buffer, envelope: object, aad: string}} options
 *        recipientPrivateKey is the 32-byte private scalar.
 * @returns {Buffer} plaintext bytes
 */
function decryptMailEnvelope({ recipientPrivateKey, envelope, aad } = {}) {
  if (!envelope || typeof envelope !== 'object') throw new Error('The mail envelope is missing.');
  const associatedData = String(aad || '');
  if (!associatedData.startsWith(`${AAD_PREFIX}|`)) {
    throw new Error('The mail associated data is invalid.');
  }
  const ephemeralBytes = decodeBase64(envelope.e, 'ephemeral key');
  if (ephemeralBytes.length !== PUBLIC_KEY_BYTES) throw new Error('The mail envelope is invalid.');
  const iv = decodeBase64(envelope.i, 'initialisation vector');
  if (iv.length !== IV_BYTES) throw new Error('The mail envelope is invalid.');
  const tag = decodeBase64(envelope.t, 'authentication tag');
  if (tag.length !== TAG_BYTES) throw new Error('The mail envelope is invalid.');
  const ciphertext = decodeBase64(envelope.c, 'ciphertext');
  if (!ciphertext.length || ciphertext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error('The mail envelope is invalid.');
  }

  const recipientBytes = privateKeyBytes(recipientPrivateKey);
  const secret = ecdhSharedSecret(recipientBytes, ephemeralBytes);
  const key = deriveKey(secret);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('The mail could not be authenticated or decoded.');
  } finally {
    key.fill(0);
    secret.fill(0);
  }
}

// Encrypts a structured mail body { subject, body } for a recipient.
//
// `threadRootId` is carried INSIDE the encrypted envelope. That is deliberate:
// the thread id is metadata the recipient needs, but it must not change the
// wire format or the AAD, or every already-sent mail would fail to decrypt.
// An old wallet reading a new mail simply ignores the extra field.
function encryptMailMessage({ recipientPublicKey, subject, body, sender, recipient, messageId, exchange, threadRootId } = {}) {
  const subjectText = String(subject ?? '').trim();
  const bodyText = String(body ?? '');
  if (!bodyText.trim()) throw new Error('The mail body is required.');
  if (subjectText.length > MAX_SUBJECT_LENGTH) throw new Error('The mail subject is too long.');
  if (bodyText.length > MAX_BODY_LENGTH) throw new Error('The mail body is too long.');
  const aad = buildMailAad({ sender, recipient, messageId });
  const thread = normalizeThreadRootId(threadRootId);
  const plaintext = { subject: subjectText, body: bodyText };
  // Only include the thread field when there is one, so a plain mail encrypts
  // to exactly the same shape it always did.
  if (thread) plaintext.threadRootId = thread;
  const envelope = encryptMailEnvelope({
    recipientPublicKey,
    plaintext: JSON.stringify(plaintext),
    aad,
    // When the caller supplies an exchange, the body and any attachments share
    // ONE ephemeral key, so the recipient derives a single shared secret.
    exchange,
  });
  return { envelope, aad };
}

// Decrypts a structured mail body and validates its shape.
function decryptMailMessage({ recipientPrivateKey, envelope, aad } = {}) {
  const plaintext = decryptMailEnvelope({ recipientPrivateKey, envelope, aad }).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('The mail body could not be decoded.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('The mail body could not be decoded.');
  const subject = String(parsed.subject ?? '');
  const body = String(parsed.body ?? '');
  if (!body.trim()) throw new Error('The mail body could not be decoded.');
  if (subject.length > MAX_SUBJECT_LENGTH || body.length > MAX_BODY_LENGTH) {
    throw new Error('The mail body exceeds the supported size.');
  }
  return { subject, body, threadRootId: normalizeThreadRootId(parsed.threadRootId) };
}

module.exports = {
  encryptMailEnvelope,
  decryptMailEnvelope,
  encryptMailMessage,
  decryptMailMessage,
  buildMailAad,
  randomMessageId,
  normalizeThreadRootId,
  publicKeyBytes,
  addressFromPublicKeyBytes,
  parsePublicKeyHex,
  compressSec1,
  // Shared primitives, so the attachment path derives its key exactly the same
  // way the mail body does.
  ecdhSharedSecret,
  privateKeyBytes,
  deriveKey,
  startMailKeyExchange,
  MAX_SUBJECT_LENGTH,
  MAX_BODY_LENGTH,
  MAX_PLAINTEXT_BYTES,
  HKDF_INFO,
};
