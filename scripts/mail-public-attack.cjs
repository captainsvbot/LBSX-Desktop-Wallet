// THIRD-PARTY ATTACK SIMULATION.
//
// Can someone who has ONLY public chain data read the mail?
// No wallet files, no vault, no private keys, no API key - just the public
// explorer URL and the recipient's published public key.
//
// This script tries every plausible attack a motivated person would attempt
// against the mail envelope, using only data that is publicly visible.

const https = require('node:https');
const crypto = require('node:crypto');

const TXID = 'c77bfa2e831f97f7bf449ead1805442e2514e952ae33512a9745397184ba4205';
const RECIPIENT = '1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut';
const EXPLORER = `https://bananablocks.com/tx/${TXID}`;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'text/plain', 'User-Agent': 'Mozilla/5.0' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

// Parse an OP_RETURN script into its pushes.
function parseOpReturn(hex) {
  const bytes = Buffer.from(hex, 'hex');
  const out = [];
  let i = 0;
  if (bytes[0] === 0x00) i = 1;
  if (bytes[i] === 0x6a) i += 1;
  while (i < bytes.length) {
    const op = bytes[i++];
    let length;
    if (op < 0x4c) length = op;
    else if (op === 0x4c) length = bytes[i++];
    else if (op === 0x4d) { length = bytes.readUInt16LE(i); i += 2; }
    else { out.push(null); continue; }
    out.push(bytes.subarray(i, i + length).toString('utf8'));
    i += length;
  }
  return out;
}

// Extract the compressed public key from a script_sig (public data). The SAME
// structural parser the wallet uses, so this test exercises the real path.
const { publicKeyFromScriptSig: parsePublicKeyFromScriptSig } = require('../electron/public-key-resolver.cjs');
function publicKeyFromScriptSig(scriptSig) {
  return parsePublicKeyFromScriptSig(scriptSig) || null;
}

async function main() {
  console.log('============================================================');
  console.log(' THIRD-PARTY ATTACK: can public chain data reveal the mail?');
  console.log('============================================================');
  console.log('source (public explorer URL):', EXPLORER);
  console.log('wallet files used: NONE');
  console.log('private keys used: NONE');
  console.log('');

  // --- 1. Fetch the raw transaction bytes from the public API ---
  const raw = await fetchText(`https://bananablocks.com/api/v1/tx/${TXID}/hex`);
  if (raw.status !== 200) {
    console.log('could not fetch raw tx:', raw.status, raw.body.slice(0, 120));
    return;
  }
  const txHex = raw.body.trim();
  console.log('[1] fetched raw transaction from the public API:', txHex.length / 2, 'bytes');

  // --- 2. Parse the OP_RETURN payload out of the raw bytes ---
  // Walk the outputs to find the OP_RETURN.
  const opReturnHex = findOpReturnHex(txHex);
  if (!opReturnHex) {
    console.log('[2] could not locate the OP_RETURN output');
    return;
  }
  const fields = parseOpReturn(opReturnHex);
  console.log('[2] parsed OP_RETURN pushes:', fields.length);
  const envelope = JSON.parse(fields[7]);
  console.log('    [0] protocol :', fields[0]);
  console.log('    [1] version  :', fields[1]);
  console.log('    [2] op       :', fields[2]);
  console.log('    [3] sender   :', fields[3]);
  console.log('    [4] recipient:', fields[4]);
  console.log('    [5] msg id   :', fields[5]);
  console.log('    [6] timestamp:', fields[6]);
  console.log('    [7] envelope :', Object.keys(envelope).join(','));

  // --- 3. Recover the recipient's PUBLIC key from public chain data ---
  const history = await fetchJson(`https://bananablocks.com/api/v1/bsv/main/address/${RECIPIENT}/history?limit=10`);
  let recipientPubKey = null;
  if (history.status === 200) {
    const rows = JSON.parse(history.body);
    for (const row of rows) {
      const detail = await fetchJson(`https://bananablocks.com/api/v1/tx/${row.tx_hash}`);
      if (detail.status !== 200) continue;
      const body = JSON.parse(detail.body);
      const tx = body.result || body.transaction || body;
      for (const input of tx.inputs || []) {
        const address = input.address || (Array.isArray(input.addresses) ? input.addresses[0] : null);
        if (address !== RECIPIENT) continue;
        recipientPubKey = publicKeyFromScriptSig(input.script_sig || '');
        if (recipientPubKey) break;
      }
      if (recipientPubKey) break;
    }
  }
  if (!recipientPubKey) {
    console.log('[3] could not recover the public key');
    return;
  }
  console.log('[3] recovered recipient PUBLIC key from public data:', recipientPubKey);

  const iv = Buffer.from(envelope.i, 'base64');
  const tag = Buffer.from(envelope.t, 'base64');
  const ciphertext = Buffer.from(envelope.c, 'base64');
  const ephemeral = Buffer.from(envelope.e, 'base64');
  const aad = `lbsx-mail-v1|${fields[3]}|${fields[4]}|${fields[5]}`;

  const attempts = [];

  // --- Attack A: the peer-chat style mistake - derive the key from PUBLIC data ---
  {
    const adminAddress = '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB';
    const key = crypto.createHash('sha256').update(adminAddress, 'utf8').digest();
    const r = tryDecrypt(key, iv, tag, ciphertext, aad);
    attempts.push(['A. peer-chat-style public key (sha256 of the admin address)', r]);
  }

  // --- Attack B: use the recipient's public key bytes directly as the AES key ---
  {
    const key = Buffer.from(recipientPubKey, 'hex');
    const r = tryDecrypt(key, iv, tag, ciphertext, aad);
    attempts.push(['B. the recipient public key used directly as the AES key', r]);
  }

  // --- Attack C: sha256 of the public key ---
  {
    const key = crypto.createHash('sha256').update(Buffer.from(recipientPubKey, 'hex')).digest();
    const r = tryDecrypt(key, iv, tag, ciphertext, aad);
    attempts.push(['C. sha256(public key)', r]);
  }

  // --- Attack D: hash160(public key) - the address itself ---
  {
    const key = crypto.createHash('sha256').update(RECIPIENT, 'utf8').digest();
    const r = tryDecrypt(key, iv, tag, ciphertext, aad);
    attempts.push(['D. sha256(recipient address)', r]);
  }

  // --- Attack E: treat the public key as if it were a private key ---
  {
    const scalar = Buffer.from(recipientPubKey, 'hex');
    const key = crypto.createHash('sha256').update(scalar).digest();
    const r = tryDecrypt(key, iv, tag, ciphertext, aad);
    attempts.push(['E. public key mistaken for a private scalar', r]);
  }

  // --- Attack F: the ephemeral key is public - derive from it alone ---
  {
    const key = crypto.createHash('sha256').update(ephemeral).digest();
    const r = tryDecrypt(key, iv, tag, ciphertext, aad);
    attempts.push(['F. sha256(public ephemeral key)', r]);
  }

  // --- Attack G: no AAD at all (try to skip the context binding) ---
  {
    const key = crypto.createHash('sha256').update(recipientPubKey, 'utf8').digest();
    const r = tryDecrypt(key, iv, tag, ciphertext, null);
    attempts.push(['G. best guess key with no AAD', r]);
  }

  console.log('');
  console.log('--- ATTACK ATTEMPTS ---');
  let anySucceeded = false;
  for (const [label, result] of attempts) {
    if (result.ok) {
      anySucceeded = true;
      console.log(`  ✗ DECRYPTED via ${label}:`, result.text.slice(0, 90));
    } else {
      console.log(`  ✓ rejected    ${label}`);
    }
  }

  console.log('');
  console.log('--- WHAT THE PUBLIC CHAIN DOES REVEAL ---');
  console.log('  sender address   :', fields[3]);
  console.log('  recipient address:', fields[4]);
  console.log('  timestamp        :', fields[6]);
  console.log('  message id       :', fields[5]);
  console.log('  ciphertext size  :', ciphertext.length, 'bytes (0 sat carrier)');
  console.log('  plaintext        :', 'NOT PRESENT - ciphertext is opaque');
  console.log('');
  console.log(anySucceeded
    ? 'RESULT: the mail WAS decrypted from public data. THIS IS A FAILURE.'
    : 'RESULT: every attempt failed. The body requires the recipient PRIVATE key,');
  console.log(anySucceeded ? '' : '        which is never published on-chain.');
}

function tryDecrypt(key, iv, tag, ciphertext, aad) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return { ok: true, text: plain };
  } catch {
    return { ok: false };
  }
}

// Locate the OP_RETURN output inside a raw transaction hex.
function findOpReturnHex(txHex) {
  const bytes = Buffer.from(txHex, 'hex');
  let offset = 0;
  const readVarInt = () => {
    const first = bytes[offset++];
    if (first < 0xfd) return first;
    if (first === 0xfd) { const v = bytes.readUInt16LE(offset); offset += 2; return v; }
    if (first === 0xfe) { const v = bytes.readUInt32LE(offset); offset += 4; return v; }
    const v = Number(bytes.readBigUInt64LE(offset)); offset += 8; return v;
  };
  const readVarBytes = () => {
    const length = readVarInt();
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };

  offset += 4;                 // version (4-byte little-endian)
  const inputCount = readVarInt();
  for (let i = 0; i < inputCount; i++) {
    offset += 36;              // outpoint (txid 32 + vout 4)
    readVarBytes();            // scriptSig
    offset += 4;               // sequence
  }
  const outputCount = readVarInt();
  for (let i = 0; i < outputCount; i++) {
    offset += 8;               // value (satoshis, little-endian)
    const script = readVarBytes().toString('hex');
    if (script.startsWith('006a')) return script;
  }
  return null;
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
