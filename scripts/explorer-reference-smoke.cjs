const assert = require('node:assert/strict');
const { buildBananaBlocksUrl } = require('../electron/explorer.cjs');

const txid = 'ab'.repeat(32);
const tokenId = `${txid}_1`;

assert.equal(buildBananaBlocksUrl({ kind: 'txid', value: txid }), `https://bananablocks.com/tx/${txid}`);
assert.equal(buildBananaBlocksUrl({ kind: 'token', value: tokenId }), `https://bananablocks.com/token/${tokenId}`);
assert.equal(buildBananaBlocksUrl({ kind: 'outpoint', value: `${txid}.2` }), `https://bananablocks.com/tx/${txid}`);
assert.throws(() => buildBananaBlocksUrl({ kind: 'txid', value: 'https://example.com' }), /valid BananaBlocks/);
assert.throws(() => buildBananaBlocksUrl({ kind: 'token', value: `${txid}_1/../tx` }), /valid BananaBlocks/);
assert.throws(() => buildBananaBlocksUrl(null), /reference is required/);

console.log('PASS: BananaBlocks explorer references are correctly routed and invalid IDs are rejected');
