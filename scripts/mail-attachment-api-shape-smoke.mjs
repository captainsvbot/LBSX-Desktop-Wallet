// Reproduces the exact receive path that failed in the packaged app.
//
// The chain API returns each output's script as a HEX STRING under
// script_pubkey. The attachment parsers originally read output.script (a
// parsed Script object), so they found nothing and the fetch threw
// "The attachment output is missing from that transaction."
//
// This test runs the REAL functions against the REAL API response.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findAttachmentOutputs, parseAttachmentOutput } = require('../electron/mail-attachments.cjs');

const TXID = 'af788498c5455b15b906b290603b04b5573b2dc5dd1f0bf623599bd66e8a6166';

async function main() {
  console.log('=== RECEIVE PATH AGAINST THE REAL API RESPONSE ===');
  console.log('txid:', TXID);
  console.log('');

  const response = await fetch(`https://bananablocks.com/api/v1/tx/${TXID}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  const transaction = body.result || body.transaction || body;
  const outputs = transaction.outputs || [];

  // The API shape, exactly as the wallet sees it.
  console.log('API output shape:', Object.keys(outputs[0]).join(', '));
  assert.equal(typeof outputs[0].script_pubkey, 'string', 'the API must return a hex script string');
  assert.equal(outputs[0].script, undefined, 'the API must NOT return a parsed script');

  // --- this is the call that used to find nothing ---
  const found = findAttachmentOutputs({ outputs }, process.argv[2] || '');
  console.log('findAttachmentOutputs found:', found.length);
  assert.ok(found.length >= 1, 'the attachment output must be found in the raw API response');

  // Without a message id filter it still resolves the output.
  const anyFound = findAttachmentOutputs({ outputs });
  assert.equal(anyFound.length, 1, 'exactly one attachment output exists in this transaction');
  console.log('attachment output found without a message id filter:', anyFound.length);

  const attachment = anyFound[0];
  console.log('  file name  :', attachment.fileName);
  console.log('  mime type  :', attachment.mimeType);
  console.log('  byte length:', attachment.byteLength);
  console.log('  vout       :', attachment.vout);

  // The full parse must work from the hex string too.
  const output = outputs.find(row => Number(row.index) === Number(attachment.vout));
  const parsed = parseAttachmentOutput(output.script_pubkey, attachment.messageId);
  assert.ok(parsed, 'the attachment output must fully parse from the hex string');
  assert.equal(parsed.byteLength, attachment.byteLength);
  assert.equal(parsed.ciphertext.length, parsed.byteLength);
  assert.equal(parsed.iv.length, 12);
  assert.equal(parsed.tag.length, 16);
  console.log('  parsed from hex: iv', parsed.iv.length, 'tag', parsed.tag.length, 'ciphertext', parsed.ciphertext.length);
  assert.ok(!parsed.ciphertext.includes(Buffer.from('LBSX-ATTACHMENT-MARKER')), 'no plaintext in the ciphertext');

  console.log('');
  console.log('PASS: the attachment is found and parsed from the real API response, which carries the script as a hex string');
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
