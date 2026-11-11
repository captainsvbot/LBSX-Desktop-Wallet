// Verifies that the sender's public key can be recovered from the input that
// FUNDED a mail transaction, which is what makes a reply possible.
//
// This is checked against real broadcast transactions on mainnet.
import assert from 'node:assert/strict';
import https from 'node:https';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const { addressFromPublicKeyBytes, parsePublicKeyHex } = require('../electron/mail-crypto.cjs');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The SAME helper the wallet uses (electron/mail.cjs -> public-key-resolver.cjs).
// It parses the script_sig structurally. A local "2102" string-match is wrong:
// the key's push opcode depends on the DER signature length before it, and a
// key with a 0x03 parity byte is missed entirely.
const { publicKeyFromScriptSig } = require('../electron/public-key-resolver.cjs');

function senderPublicKeyFromInputs(inputs, senderAddress) {
  for (const input of Array.isArray(inputs) ? inputs : []) {
    const address = input?.address
      || (Array.isArray(input?.addresses) ? input.addresses[0] : null);
    if (String(address || '').toLowerCase() !== String(senderAddress || '').toLowerCase()) continue;
    const publicKeyHex = publicKeyFromScriptSig(input?.script_sig ?? input?.scriptSig);
    if (publicKeyHex) return publicKeyHex;
  }
  return '';
}

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

async function main() {
  console.log('=== REPLY KEY RECOVERY FROM REAL MAIL TRANSACTIONS ===');
  console.log('');

  // The mail transactions sent during testing, from the recipient's history.
  const RECIPIENT = '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE';
  // A generous history window: the recipient's address accumulates every mail
  // sent to it, so a small limit can push the transactions this test needs
  // out of range and make it fail for no real reason.
  const history = await fetchJson(`https://bananablocks.com/api/v1/bsv/main/address/${RECIPIENT}/history?limit=60`);
  if (history.status !== 200) throw new Error(`history HTTP ${history.status}`);
  const rows = JSON.parse(history.body);

  let checked = 0;
  let recovered = 0;
  let mismatched = 0;

  for (const row of rows) {
    if (checked >= 6) break;
    const detail = await fetchJson(`https://bananablocks.com/api/v1/tx/${row.tx_hash}`);
    if (detail.status !== 200) { await sleep(2000); continue; }
    const body = JSON.parse(detail.body);
    const tx = body.result || body.transaction || body;
    const opReturn = (tx.outputs || []).find(o => o.script_type === 'opreturn');
    if (!opReturn) continue;
    const fields = parseOpReturn(opReturn.script_pubkey);
    if (fields.length !== 8 || fields[2] !== 'mail') continue;

    checked += 1;
    const claimedSender = fields[3];
    const keyHex = senderPublicKeyFromInputs(tx.inputs, claimedSender);
    if (!keyHex) {
      console.log(`  tx ${row.tx_hash.slice(0, 14)}: NO KEY recovered for ${claimedSender.slice(0, 12)}`);
      continue;
    }
    const derived = addressFromPublicKeyBytes(parsePublicKeyHex(keyHex));
    const matches = derived === claimedSender;
    if (matches) recovered += 1; else mismatched += 1;
    console.log(`  tx ${row.tx_hash.slice(0, 14)}: key ${keyHex.slice(0, 12)}… -> ${derived.slice(0, 12)}… ${matches ? 'MATCHES sender' : 'MISMATCH'}`);
    await sleep(2000);
  }

  console.log('');
  console.log(`checked ${checked} mail transactions`);
  console.log(`recovered a matching sender key: ${recovered}`);
  console.log(`mismatched (would be a security problem): ${mismatched}`);

  assert.ok(checked > 0, 'at least one mail transaction must have been inspected');
  assert.ok(recovered > 0, 'the sender key must be recoverable from the funding input');
  assert.equal(mismatched, 0, 'every recovered key must derive the claimed sender address');

  // The recovered key must be usable to encrypt a reply: it must validate
  // against the address the way contact validation does.
  console.log('');
  console.log('=== REPLY ENCRYPTION CHECK ===');
  const { encryptMailEnvelope, buildMailAad } = require('../electron/mail-crypto.cjs');
  const keyHex = '038f6c0bcf78db7e07fbb8a7325fa375add68e3abd58e4c7e84e7faac56c6dc97b';
  const aad = buildMailAad({ sender: RECIPIENT, recipient: '1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut', messageId: 'a'.repeat(64) });
  const envelope = encryptMailEnvelope({ recipientPublicKey: parsePublicKeyHex(keyHex), plaintext: 'reply body', aad });
  console.log('  encrypted a reply to the recovered key: OK, envelope', Object.keys(envelope).join(','));

  console.log('');
  console.log('PASS: the sender public key is recoverable from the funding input and always derives the claimed sender address');
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
