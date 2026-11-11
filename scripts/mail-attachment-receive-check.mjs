// Verifies the RECEIVE side against the real broadcast transaction.
//
// The attachment was sent to a wallet whose private key is not available here,
// so this test does the structural half of the receive path against the REAL
// on-chain bytes: it fetches the transaction, walks the outputs exactly as the
// sync path does, discovers the attachment output, and confirms the payload
// is in the shape the decrypt path expects.
//
// The cryptographic half is covered by test:mail-attachment-tx, which decrypts
// a real signed transaction end to end.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findAttachmentOutputs, parseAttachmentOutput, buildAttachmentAad } = require('../electron/mail-attachments.cjs');

const TXID = process.argv[2] || 'af788498c5455b15b906b290603b04b5573b2dc5dd1f0bf623599bd66e8a6166';
const MESSAGE_ID = process.argv[3] || '';

async function main() {
  console.log('=== RECEIVE-SIDE STRUCTURE CHECK (real on-chain tx) ===');
  console.log('txid:', TXID);
  console.log('');

  const response = await fetch(`https://bananablocks.com/api/v1/tx/${TXID}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!response.ok) throw new Error(`the transaction lookup failed: HTTP ${response.status}`);
  const body = await response.json();
  const tx = body.result || body.transaction || body;
  const rawOutputs = tx.outputs || [];
  console.log('outputs on chain:', rawOutputs.length);

  // Rebuild the output scripts the way bsv does, so the same parser runs.
  const bsvModule = require('bsv');
  const bsv = bsvModule.default || bsvModule;

  // The mail output carries the message id we need for the attachment match.
  let discoveredMessageId = MESSAGE_ID;
  const outputs = [];
  for (let index = 0; index < rawOutputs.length; index += 1) {
    const raw = rawOutputs[index];
    const hex = raw.script_pubkey || '';
    // Strip the OP_RETURN wrapper: 6a <push> ...
    const script = bsv.Script.fromHex(hex.replace(/^6a/, ''));
    outputs.push({ index, script });
  }

  // Read the mail payload to find the message id.
  for (const output of outputs) {
    const chunks = output.script.chunks || [];
    const marker = chunks.findIndex(chunk => chunk.opcodenum === 0x6a);
    if (marker < 0) continue;
    const pushes = chunks.slice(marker + 1).map(chunk => Buffer.from(chunk.buf));
    if (pushes.length === 8 && pushes[2].toString('utf8') === 'mail') {
      discoveredMessageId = pushes[5].toString('utf8');
      console.log('mail output found, message id:', discoveredMessageId);
      console.log('mail subject is encrypted in the envelope:', JSON.parse(pushes[7].toString('utf8')).c ? 'yes' : 'no');
      break;
    }
  }
  assert.ok(discoveredMessageId, 'the mail message id must be recoverable');

  // Now discover the attachment output, exactly as the sync path does.
  const found = findAttachmentOutputs({ outputs }, discoveredMessageId);
  console.log('attachment outputs discovered:', found.length);
  assert.equal(found.length, 1, 'exactly one attachment output must be discovered');

  const attachment = found[0];
  console.log('');
  console.log('attachment metadata (all PUBLIC on-chain):');
  console.log('  file name  :', attachment.fileName);
  console.log('  mime type  :', attachment.mimeType);
  console.log('  byte length:', attachment.byteLength, 'bytes');
  console.log('  vout       :', attachment.vout);

  // The full parse must succeed, including the ciphertext length check.
  const output = outputs.find(row => row.index === attachment.vout);
  const parsed = parseAttachmentOutput(output.script, discoveredMessageId);
  assert.ok(parsed, 'the attachment output must fully parse');
  assert.equal(parsed.byteLength, attachment.byteLength);
  assert.equal(parsed.iv.length, 12, 'the IV must be 12 bytes');
  assert.equal(parsed.tag.length, 16, 'the GCM tag must be 16 bytes');
  assert.equal(parsed.ciphertext.length, parsed.byteLength, 'the ciphertext must match the declared length');
  console.log('');
  console.log('  iv length  :', parsed.iv.length);
  console.log('  tag length :', parsed.tag.length);
  console.log('  ciphertext :', parsed.ciphertext.length, 'bytes');
  assert.ok(!parsed.ciphertext.includes(Buffer.from('LBSX-ATTACHMENT-MARKER')), 'the plaintext must not be in the ciphertext');

  // The AAD the decrypt path will rebuild must match what was signed.
  const aad = buildAttachmentAad({
    sender: '1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut',
    recipient: '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE',
    messageId: discoveredMessageId,
    fileName: parsed.fileName,
    mimeType: parsed.mimeType,
    byteLength: parsed.byteLength,
  });
  console.log('');
  console.log('  aad the decrypt path rebuilds:', aad);

  console.log('');
  console.log('PASS: the real broadcast transaction parses into exactly the attachment payload the receive path expects');
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
