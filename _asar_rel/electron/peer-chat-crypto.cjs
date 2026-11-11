const crypto = require('node:crypto');
const { ADMIN_DISCOVERY_ADDRESS } = require('./constants.cjs');

const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 2048;
const MAX_CIPHERTEXT_BYTES = IV_BYTES + TAG_BYTES + MAX_PLAINTEXT_BYTES;

function derivePeerChatKey() {
  // The public admin address is an app-level obfuscation key, not a secret.
  return crypto.createHash('sha256').update(ADMIN_DISCOVERY_ADDRESS, 'utf8').digest();
}

function encryptPeerChatContent(content) {
  const text = String(content);
  const plaintext = Buffer.from(text, 'utf8');
  if (!text.trim() || text.length > 500 || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error('Peer Chat content exceeds the supported size.');
  }

  const key = derivePeerChatKey();
  const iv = crypto.randomBytes(IV_BYTES);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  } finally {
    key.fill(0);
  }
}

function decryptPeerChatContent(payload) {
  if (typeof payload !== 'string' || payload.length > Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
    throw new Error('Peer Chat ciphertext is invalid.');
  }
  const packed = Buffer.from(payload, 'base64');
  if (packed.toString('base64') !== payload || packed.length <= IV_BYTES + TAG_BYTES
    || packed.length > MAX_CIPHERTEXT_BYTES) {
    throw new Error('Peer Chat ciphertext is invalid.');
  }

  const key = derivePeerChatKey();
  try {
    const iv = packed.subarray(0, IV_BYTES);
    const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    if (!text.trim() || text.length > 500 || plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new Error('Peer Chat content exceeds the supported size.');
    }
    return text;
  } catch {
    throw new Error('Peer Chat ciphertext could not be authenticated or decoded.');
  } finally {
    key.fill(0);
  }
}

module.exports = { encryptPeerChatContent, decryptPeerChatContent };
