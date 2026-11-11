// Verifies the public-key resolver against real mainnet addresses.
//
// A contact can be created from an address ALONE, because a P2PKH input
// publishes the spender's compressed public key. The recovered key is
// verified against the address before it is returned.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolvePublicKeyForAddress,
  publicKeyMatchesAddress,
  addressFromPublicKeyBytes,
  publicKeyFromScriptSig,
  setTransport,
} = require('../electron/public-key-resolver.cjs');

// A plain fetch transport, so this test does not need Electron. It mirrors
// the wallet's own cursor pagination: the x-next-cursor header drives the
// next page.
//
// The public API allows 80 requests a minute, so the transport paces itself.
const MIN_REQUEST_INTERVAL_MS = 900;
let lastRequestAt = 0;
setTransport(async url => {
  const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') || 5);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    return setTransport && (await (async () => {
      const retry = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
      return { body: await retry.json(), nextCursor: retry.headers.get('x-next-cursor') };
    })());
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return {
    body: await response.json(),
    nextCursor: response.headers.get('x-next-cursor'),
  };
});

async function main() {
  console.log('=== PUBLIC KEY DERIVATION FROM AN ADDRESS ALONE ===');
  console.log('');

  // --- 1. the known recipient key, recovered from the chain ---
  const RECIPIENT = '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE';
  const EXPECTED = '038f6c0bcf78db7e07fbb8a7325fa375add68e3abd58e4c7e84e7faac56c6dc97b';
  const resolved = await resolvePublicKeyForAddress(RECIPIENT);
  console.log(`resolved ${RECIPIENT}`);
  console.log('  public key:', resolved.publicKeyHex || '(none)');
  console.log('  verified  :', resolved.verified);
  assert.ok(resolved.publicKeyHex, 'the public key must be recovered from the chain');
  assert.equal(resolved.publicKeyHex, EXPECTED, 'the recovered key must be the known key');
  assert.ok(resolved.verified, 'the recovered key must be verified against the address');
  assert.ok(
    publicKeyMatchesAddress(resolved.publicKeyHex, RECIPIENT),
    'the recovered key must derive the address',
  );

  // --- 2. a second address that has spent ---
  const SENDER = '1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut';
  const senderResolved = await resolvePublicKeyForAddress(SENDER);
  console.log(`resolved ${SENDER}`);
  console.log('  public key:', senderResolved.publicKeyHex || '(none)');
  assert.ok(senderResolved.publicKeyHex, 'the second address must resolve too');
  assert.ok(
    publicKeyMatchesAddress(senderResolved.publicKeyHex, SENDER),
    'the second recovered key must derive its address',
  );

  // --- 3. a key that does NOT match the address is rejected ---
  assert.equal(
    publicKeyMatchesAddress(EXPECTED, SENDER),
    false,
    'a key that derives a different address must be rejected',
  );
  assert.equal(
    publicKeyMatchesAddress('deadbeef', RECIPIENT),
    false,
    'a malformed key must be rejected',
  );

  // --- 4. the script_sig parser, against a REAL unlocking script ---
  // This is the actual script_sig of a real spend by the recipient. The
  // signature is 71 bytes, so the key's push opcode is 0x41 (65 bytes of
  // DER+hashtype+key), NOT 0x21. A parser that string-matches "2102" or
  // "2103" misses this key entirely.
  const REAL_SCRIPT_SIG = '483045022100e9dd8ddf269cc6f7ce26a3081502ff055ec10927e59a25a5150ebd3f15a1ee9502202632087dd2277a0a4a48c852ae106303cb135bfdc077e7396deca6cb1c2f248a4121038f6c0bcf78db7e07fbb8a7325fa375add68e3abd58e4c7e84e7faac56c6dc97b';
  assert.equal(
    publicKeyFromScriptSig(REAL_SCRIPT_SIG),
    EXPECTED,
    'the real script_sig must yield the recipient public key',
  );
  // The naive parser string-matched the byte pair 0x21 0x02 / 0x21 0x03
  // ANYWHERE in the script and took 66 hex chars from there. That only works
  // by luck: the real key push here is 0x41 (65 bytes), because the DER
  // signature before it is 72 bytes. The naive parser happens to land on
  // the right offset for THIS script, but it is not reading the push
  // structure at all.
  //
  // The structural parser must find the key regardless of alignment, so it
  // is tested against scripts with different signature lengths.
  assert.equal(publicKeyFromScriptSig(REAL_SCRIPT_SIG), EXPECTED);

  // A script whose signature is a different length shifts the key push to a
  // different opcode. The structural parser must still find it, while a
  // fixed-opcode parser would miss it.
  for (const signatureLength of [70, 71, 72, 73, 74, 75]) {
    // A P2PKH unlocking script: <signature> <33-byte compressed key>.
    // The signature is pushed with the direct-push opcode for its length
    // (0x46 for 70 bytes, 0x47 for 71, 0x48 for 72, ...), and the key is
    // pushed with 0x21 (33 bytes).
    const signatureOpcode = (0x45 + signatureLength).toString(16);
    const signature = 'ab'.repeat(signatureLength);
    const script = `${signatureOpcode}${signature}21${EXPECTED}`;
    assert.equal(
      publicKeyFromScriptSig(script),
      EXPECTED,
      `a script with a ${signatureLength} byte signature must still yield the key`,
    );
  }

  // A synthetic script_sig with the key pushed directly (0x21) must also
  // work. The signature is 71 bytes, pushed with opcode 0x47.
  const directPush = `47${'30'.repeat(71)}2103${'ab'.repeat(32)}`;
  assert.equal(
    publicKeyFromScriptSig(directPush),
    `03${'ab'.repeat(32)}`,
    'a directly pushed key must be read out too',
  );
  assert.equal(publicKeyFromScriptSig(''), '', 'an empty script_sig yields nothing');
  assert.equal(publicKeyFromScriptSig('0011'), '', 'a script_sig with no key push yields nothing');
  assert.equal(publicKeyFromScriptSig('zz'), '', 'a malformed script_sig yields nothing');

  // --- 5. the address derivation must use the COMPRESSED bytes ---
  const derived = addressFromPublicKeyBytes(Buffer.from(EXPECTED, 'hex'));
  assert.equal(derived, RECIPIENT, 'hash160 over the compressed bytes must derive the address');

  console.log('');
  console.log('PASS: a public key is derived from an address alone, verified against it, and a mismatched key is rejected');
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
