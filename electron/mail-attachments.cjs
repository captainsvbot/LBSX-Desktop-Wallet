// Encrypted attachments for LBSX mail.
//
// An attachment is carried in its own data output, as RAW BINARY ciphertext.
// Pushing raw bytes rather than base64 inside the JSON envelope avoids a double
// expansion (1.33x for the inner base64, 1.33x again for the encrypted
// envelope) and roughly doubles how much fits in one BSV transaction.
//
// The attachment uses the SAME key material as the mail body - the recipient's
// public key and the same ECDH/HKDF derivation - but it gets:
//
//   - its OWN random IV, because GCM nonce reuse under one key leaks the XOR of
//     two plaintexts and destroys the authentication key;
//   - its OWN AAD, which binds the file name, MIME type and byte length, so
//     none of them can be tampered with in transit.
//
// The wire format of the attachment output is:
//
//   ['LBSX', 'v2', 'mail_attachment',
//    <message id>, <file name>, <mime type>, <byte length>,
//    <iv>, <auth tag>, <raw ciphertext bytes>]

const crypto = require('node:crypto');
const bsvModule = require('bsv');
const {
  ecdhSharedSecret,
  privateKeyBytes,
  deriveKey,
  startMailKeyExchange,
} = require('./mail-crypto.cjs');

const bsv = bsvModule.default || bsvModule;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD_ATTACHMENT_PREFIX = 'lbsx-mail-v1-att';
const PROTOCOL = 'LBSX';
const PROTOCOL_VERSION = 'v2';
const OP_ATTACHMENT = 'mail_attachment';

// BSV has NO 100 KB transaction limit. That was Bitcoin's rule. BSV's Genesis
// upgrade (February 2020, mainnet height 620,538) raised the maximum
// transaction size to 1 GB as a CONSENSUS rule, and block size became a
// configurable miner parameter with no protocol maximum.
//
// The wallet's own limit is therefore a product decision, not a network one:
// 50 MB per attachment, which comfortably holds a high-resolution photo or a
// substantial document. Beyond that the transaction gets expensive to relay
// and slow to propagate.
//
// The 1 GB consensus ceiling is kept here as a hard backstop, so a bug can
// never build a transaction the network would reject.
const BSV_CONSENSUS_MAX_TX_BYTES = 1000 * 1000 * 1000;
const TX_OVERHEAD_BYTES = 300;
const MAIL_OUTPUT_BYTES = 400;
const ATTACHMENT_HEADER_BYTES = 200;
// The whole mail - body plus every attachment - must stay under 50 MB. There
// is no separate per-file ceiling beyond that total, and no cap on how many
// files may be attached, because the constraint the user cares about is the
// SIZE of the email, not the number of files in it. A single file may use the
// whole budget; several files share it.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 80;

// Filenames are public on-chain, so they are sanitised of anything that could
// escape a directory or confuse a display.
function sanitizeFilename(name) {
  const base = String(name || 'attachment')
    .split(/[\\/]/).pop()            // strip any path components
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')            // no leading dots (no "." or "..")
    .slice(0, MAX_FILENAME_LENGTH);
  return base || 'attachment';
}

function normalizeMimeType(mimeType) {
  const value = String(mimeType || 'application/octet-stream').toLowerCase().trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/.test(value)
    ? value
    : 'application/octet-stream';
}

// Detects the real type of an image from its magic bytes. The declared MIME
// type is not trusted on its own - the file's own signature decides what it
// is. This mirrors the token-image validation the wallet already uses.
function detectImageMimeType(bytes) {
  const data = Buffer.from(bytes || []);
  if (data.length >= 8
    && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 12
    && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (data.length >= 6
    && (data.toString('ascii', 0, 6) === 'GIF87a' || data.toString('ascii', 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  return '';
}

// The image types the wallet is willing to RENDER inline.
//
// SVG is deliberately excluded. An SVG is an XML document that can carry
// <script>, event handlers and external references, so rendering one inside
// the wallet - even in an <img> - is a scripting and tracking risk. SVG is
// still accepted as an ATTACHMENT, but it is never previewed inline: it is
// saved to disk and opened by the operating system instead.
//
// Every type listed here is a raster format whose decoder does not execute
// script and does not fetch external resources.
const INLINE_PREVIEW_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

// Whether a MIME type may be rendered inline in the app.
//
// The check is on the type the RECEIVER determined from the bytes, never on
// the type the sender claimed, so a sender cannot present an SVG as a PNG.
function canRenderInline(mimeType) {
  return INLINE_PREVIEW_MIME_TYPES.has(String(mimeType || '').toLowerCase());
}

// When a file IS an image, its declared type must match its real signature.
// This stops a file that claims to be a PNG but is actually something else
// from being rendered as an image.
function validateAttachmentType({ data, mimeType }) {
  const detected = detectImageMimeType(data);
  if (!detected) return;
  const declared = normalizeMimeType(mimeType);
  if (declared.startsWith('image/') && declared !== detected) {
    throw new Error(`This file is a ${detected.replace('image/', '').toUpperCase()}, not a ${declared.replace('image/', '').toUpperCase()}.`);
  }
}

// The AAD binds an attachment to its exact context. Changing the file name, the
// MIME type, the byte length, the sender, the recipient or the message id
// makes the GCM tag fail.
function buildAttachmentAad({ sender, recipient, messageId, fileName, mimeType, byteLength }) {
  const name = sanitizeFilename(fileName);
  const mime = normalizeMimeType(mimeType);
  const length = Number(byteLength);
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('The attachment size is invalid.');
  return `${AAD_ATTACHMENT_PREFIX}|${String(sender || '')}|${String(recipient || '')}`
    + `|${String(messageId || '').toLowerCase()}|${name}|${mime}|${length}`;
}

// Encrypts attachment bytes using the key material from an existing mail key
// exchange. Returns raw buffers, ready to be pushed.
//
// The attachment gets its OWN random IV and its OWN AAD. Reusing the body's IV
// under the same key would be catastrophic for GCM.
function encryptAttachment({ key, data, fileName, mimeType, sender, recipient, messageId }) {
  const bytes = Buffer.from(data || []);
  if (!bytes.length) throw new Error('The attachment is empty.');
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`The attachment must be ${formatSize(MAX_ATTACHMENT_BYTES)} or smaller.`);
  }
  const name = sanitizeFilename(fileName);
  const mime = normalizeMimeType(mimeType);
  const aad = buildAttachmentAad({
    sender, recipient, messageId, fileName: name, mimeType: mime, byteLength: bytes.length,
  });
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    fileName: name,
    mimeType: mime,
    byteLength: bytes.length,
    iv,
    tag: cipher.getAuthTag(),
    ciphertext,
    aad,
  };
}

// Decrypts attachment bytes using the key material from the mail key
// exchange. Throws when the payload does not authenticate.
function decryptAttachment({ key, envelope, aad }) {
  if (!envelope || !Buffer.isBuffer(envelope.iv) || !Buffer.isBuffer(envelope.tag)
    || !Buffer.isBuffer(envelope.ciphertext)) {
    throw new Error('The attachment payload is invalid.');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.iv);
    decipher.setAuthTag(envelope.tag);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    const plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    if (plaintext.length !== envelope.byteLength) throw new Error('The attachment size does not match.');
    return plaintext;
  } catch {
    throw new Error('The attachment could not be authenticated or decoded.');
  }
}

// Derives the recipient-side key from the ephemeral public key carried in the
// mail envelope and the recipient's private key.
function deriveRecipientKey({ recipientPrivateKeyBytes, ephemeralPublicKeyBytes }) {
  const shared = ecdhSharedSecret(recipientPrivateKeyBytes, ephemeralPublicKeyBytes);
  try {
    return deriveKey(shared);
  } finally {
    shared.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Script building and parsing
// ---------------------------------------------------------------------------

// Pushes arbitrary bytes with the correct minimal-length opcode.
function pushData(data) {
  const value = Buffer.from(data);
  if (value.length < 0x4c) return Buffer.concat([Buffer.from([value.length]), value]);
  if (value.length <= 0xff) return Buffer.concat([Buffer.from([0x4c, value.length]), value]);
  if (value.length <= 0xffff) {
    const length = Buffer.alloc(2);
    length.writeUInt16LE(value.length);
    return Buffer.concat([Buffer.from([0x4d]), length, value]);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(value.length);
  return Buffer.concat([Buffer.from([0x4e]), length, value]);
}

// Builds the data output that carries one encrypted attachment.
function buildAttachmentScript(attachment, messageId) {
  return bsv.Script.fromBuffer(Buffer.concat([
    Buffer.from([0x00, 0x6a]),
    pushData(Buffer.from(PROTOCOL)),
    pushData(Buffer.from(PROTOCOL_VERSION)),
    pushData(Buffer.from(OP_ATTACHMENT)),
    pushData(Buffer.from(String(messageId).toLowerCase())),
    pushData(Buffer.from(attachment.fileName)),
    pushData(Buffer.from(attachment.mimeType)),
    pushData(Buffer.from(String(attachment.byteLength))),
    pushData(attachment.iv),
    pushData(attachment.tag),
    pushData(attachment.ciphertext),
  ]));
}

// Reads the pushes that follow an OP_RETURN marker, as raw buffers.
//
// The chain API returns each output's script as a HEX STRING under
// script_pubkey, so hex is converted to a parsed script first. A script that
// is already parsed (a bsv Script object) is accepted as-is.
function readPushes(script) {
  let parsed = script;
  if (typeof script === 'string') {
    const hex = script.trim();
    if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
    try {
      parsed = bsv.Script.fromHex(hex);
    } catch {
      return null;
    }
  }
  const chunks = parsed?.chunks || [];
  const marker = chunks.findIndex(chunk => chunk.opcodenum === 0x6a);
  if (marker < 0) return null;
  const pushes = [];
  for (const chunk of chunks.slice(marker + 1)) {
    if (!chunk.buf) return null;
    pushes.push(Buffer.from(chunk.buf));
  }
  return pushes;
}

// Parses an attachment output. Returns null when it is not one.
//
// The pushes are, in order:
//   0 LBSX | 1 v2 | 2 mail_attachment | 3 message id | 4 file name |
//   5 mime type | 6 byte length | 7 iv | 8 auth tag | 9 raw ciphertext
function parseAttachmentOutput(script, messageId) {
  const pushes = readPushes(script);
  if (!pushes || pushes.length !== 10) return null;
  const text = index => pushes[index].toString('utf8');
  if (text(0) !== PROTOCOL || text(1) !== PROTOCOL_VERSION || text(2) !== OP_ATTACHMENT) return null;
  if (messageId && text(3).toLowerCase() !== String(messageId).toLowerCase()) return null;
  const byteLength = Number(text(6));
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_ATTACHMENT_BYTES) return null;
  if (pushes[7].length !== IV_BYTES || pushes[8].length !== TAG_BYTES) return null;
  if (pushes[9].length !== byteLength) return null;
  return {
    messageId: text(3).toLowerCase(),
    fileName: sanitizeFilename(text(4)),
    mimeType: normalizeMimeType(text(5)),
    byteLength,
    iv: pushes[7],
    tag: pushes[8],
    ciphertext: pushes[9],
  };
}

// Finds every attachment output belonging to a message in a transaction.
//
// The chain API returns each output's script as a HEX STRING under
// script_pubkey, so that field is used when it is present. A parsed script
// under `script` is also accepted.
function findAttachmentOutputs(transaction, messageId) {
  const found = [];
  for (const output of transaction?.outputs || []) {
    const script = output?.script_pubkey ?? output?.scriptPubKey ?? output?.script;
    const attachment = parseAttachmentOutput(script, messageId);
    if (attachment) found.push({ ...attachment, vout: output.index ?? found.length });
  }
  return found;
}

// Estimates the transaction size for a set of attachments, so the UI can warn
// before the user signs.
function estimateTransactionBytes(attachmentCount = 0) {
  return TX_OVERHEAD_BYTES + MAIL_OUTPUT_BYTES + attachmentCount * ATTACHMENT_HEADER_BYTES;
}

// How many more bytes of attachment the transaction budget allows.
function remainingAttachmentBudget(attachmentCount = 0) {
  return BSV_CONSENSUS_MAX_TX_BYTES - estimateTransactionBytes(attachmentCount);
}

// Formats a byte count for user-facing messages.
function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value % (1024 * 1024) ? 1 : 0)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(value % 1024 ? 1 : 0)} KB`;
  return `${value} bytes`;
}

module.exports = {
  encryptAttachment,
  decryptAttachment,
  deriveRecipientKey,
  startMailKeyExchange,
  buildAttachmentScript,
  parseAttachmentOutput,
  findAttachmentOutputs,
  readPushes,
  buildAttachmentAad,
  sanitizeFilename,
  normalizeMimeType,
  detectImageMimeType,
  validateAttachmentType,
  canRenderInline,
  estimateTransactionBytes,
  remainingAttachmentBudget,
  formatSize,
  pushData,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_FILENAME_LENGTH,
  BSV_CONSENSUS_MAX_TX_BYTES,
};
