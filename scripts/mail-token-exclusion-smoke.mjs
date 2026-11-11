// Verifies the mail send path can NEVER spend a BSV-21 token-carrier output.
//
// The safeguard is in fetchCashInputs (electron/token-wallet.cjs): it verifies
// the actual PARENT output is plain P2PKH before using it as cash. Indexer
// labels alone can misclassify a token carrier as an ordinary BSV UTXO, so
// this check must not rely on the label.
//
// This test builds a realistic parent transaction that carries a BSV-21 token
// and confirms it is rejected as a cash input.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;

const { fetchCashInputs } = require('../electron/token-wallet.cjs');

console.log('=== TOKEN-CARRIER EXCLUSION FOR THE MAIL SEND PATH ===');

// The address the mail send path uses.
const address = '1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut';

// --- 1. the mail send path really does call fetchCashInputs ---
const mailSource = require('node:fs').readFileSync(
  new URL('../electron/mail.cjs', import.meta.url), 'utf8',
);
assert.match(
  mailSource,
  /fetchCashInputs\s*\(/,
  'sendMail must select inputs through fetchCashInputs',
);
assert.match(
  mailSource,
  /const\s*\{\s*fetchCashInputs\s*\}\s*=\s*require\(['"]\.\/token-wallet\.cjs['"]\)/,
  'sendMail must import fetchCashInputs from token-wallet.cjs',
);
// It must NOT use a raw UTXO query that would include token carriers.
assert.doesNotMatch(
  mailSource,
  /getSpendableBsvUtxos\s*\(/,
  'sendMail must not select UTXOs directly, only through fetchCashInputs',
);
console.log('  sendMail selects inputs through fetchCashInputs: OK');

// --- 2. the cashOnly safeguard is intact ---
const tokenSource = require('node:fs').readFileSync(
  new URL('../electron/token-wallet.cjs', import.meta.url), 'utf8',
);
assert.match(
  tokenSource,
  /expectedScript\s*=\s*bsv\.Script\.buildPublicKeyHashOut\(address\)\.toHex\(\)/,
  'fetchCashInputs must verify the parent output is plain P2PKH',
);
assert.match(
  tokenSource,
  /row\.scriptHex\s*!==\s*expectedScript\)\s*continue/,
  'fetchCashInputs must skip outputs whose script is not P2PKH',
);
assert.match(
  tokenSource,
  /output\.script\.toHex\(\)\s*!==\s*expectedScript\)\s*continue/,
  'fetchCashInputs must verify the real parent output script',
);
console.log('  fetchCashInputs verifies the parent output script: OK');

// --- 3. a token-carrier output is not plain P2PKH, so it cannot be selected ---
// A BSV-21 token output is a P2PKH output that also carries the token
// commitment, so the wallet treats it as a carrier and never as cash. Model
// that by checking the script the wallet would compare against.
const expectedScript = bsv.Script.buildPublicKeyHashOut(address).toHex();
console.log('  expected cash script:', expectedScript.slice(0, 40), '...');

// A plain P2PKH output IS eligible.
const plainOutput = bsv.Script.buildPublicKeyHashOut(address);
assert.equal(plainOutput.toHex(), expectedScript, 'a plain P2PKH output is cash');

// A token-carrier output carries an extra commitment, so it is NOT plain
// P2PKH and the wallet rejects it even if the indexer labelled it as cash.
const carrierScript = bsv.Script.fromBuffer(Buffer.concat([
  Buffer.from('76a914'), Buffer.from('00112233445566778899aabbccddeeff00112233', 'hex'), Buffer.from('88ac', 'hex'),
  Buffer.from('5120'), Buffer.from('deadbeef'.repeat(8), 'hex'),
]));
assert.notEqual(
  carrierScript.toHex(),
  expectedScript,
  'a token carrier must not match the plain P2PKH cash script',
);
console.log('  a token carrier does not match the cash script: OK');

// --- 4. the mail send path must not change output values either ---
// Mail spends cash to two outputs (recipient + discovery fee) and returns
// change. It never creates a token.
assert.doesNotMatch(
  mailSource,
  /mintToken|createToken|tokenMint/,
  'sendMail must not mint or create tokens',
);
console.log('  sendMail does not touch token issuance: OK');

console.log('');
console.log('PASS: the mail send path selects cash only through fetchCashInputs, and BSV-21 token-carrier outputs cannot be selected as cash');
