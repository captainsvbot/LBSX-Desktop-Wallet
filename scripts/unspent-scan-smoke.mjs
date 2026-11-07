import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const profile = await mkdtemp(path.join(os.tmpdir(), 'lbsx-unspent-'));
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => profile },
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'test-key-store',
        encryptString: value => Buffer.from(`encrypted:${value}`),
        decryptString: value => value.toString().replace(/^encrypted:/, ''),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const bb = require('../electron/bananablocks.cjs');
const scanner = require('../electron/bsv-unspent.cjs');
Module._load = originalLoad;

const txid = index => index.toString(16).padStart(64, '0');
const row = (index, value = 1000, height = 900000) => ({
  height, tx_pos: 0, tx_hash: txid(index), value, isSpentInMempoolTx: false, status: 'confirmed',
});

// The fake server answers the real API contract: page one is a bare array with
// cursor headers, later pages carry the cursor in the body.
function makeServer(pages) {
  const calls = [];
  const handler = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const cursor = url.searchParams.get('cursor');
    const page = pages.find(entry => entry.cursor === cursor) || pages[0];
    return page.respond(url);
  };
  return { calls, handler };
}

function jsonResponse(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'x-ratelimit-limit': '80', 'x-ratelimit-remaining': '79', ...headers },
  });
}

try {
  // Page shapes are normalised into one row shape.
  assert.deepEqual(scanner.normalizeUnspentRow({ tx_hash: txid(1), tx_pos: 2, value: 546, height: 800000 }), {
    tx_hash: txid(1), tx_pos: 2, value: 546, height: 800000, status: 'confirmed',
    script_type: null, spent: false, spent_txid: null,
  });
  assert.equal(scanner.normalizeUnspentRow({ tx_hash: 'not-a-txid', tx_pos: 0, value: 1, height: 1 }), null);
  assert.equal(scanner.normalizeUnspentRow({ tx_hash: txid(2), tx_pos: -1, value: 1, height: 1 }), null);
  assert.equal(scanner.normalizeUnspentRow({ tx_hash: txid(2), tx_pos: 0, value: -5, height: 1 }), null);

  // A multi page scan follows the cursor until the server says there is no
  // more, and returns every row without a cap.
  const server = makeServer([
    {
      cursor: null,
      respond: () => jsonResponse(
        [row(1), row(2), row(3)],
        { 'x-has-more': 'true', 'x-next-cursor': 'cursor-one' },
      ),
    },
    {
      cursor: 'cursor-one',
      respond: () => jsonResponse({ items: [row(3), row(4), row(5)], cursor: 'cursor-two', hasMore: true }),
    },
    {
      cursor: 'cursor-two',
      respond: () => jsonResponse({ items: [row(6)], hasMore: false }),
    },
  ]);
  globalThis.fetch = server.handler;
  bb._test.resetRateLimit();

  const progress = [];
  const rows = await scanner.fetchAllUnspentUtxos('15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB', {
    pageSize: 3,
    onProgress: info => progress.push(info),
  });
  assert.equal(rows.length, 6, 'every output is returned and the duplicate is dropped');
  assert.deepEqual(rows.map(entry => entry.tx_hash), [txid(1), txid(2), txid(3), txid(4), txid(5), txid(6)]);
  assert.equal(server.calls.length, 3, 'the scan stops once the server reports no more pages');
  assert.equal(server.calls[1].searchParams.get('cursor'), 'cursor-one', 'the cursor is echoed back to the server');
  assert.equal(server.calls[2].searchParams.get('cursor'), 'cursor-two');
  assert.deepEqual(progress.at(-1), { completed: 3, count: 6 });

  // A scan is not capped: a page of one thousand rows is returned in full.
  const big = makeServer([
    { cursor: null, respond: () => jsonResponse(Array.from({ length: 1000 }, (_, index) => row(index + 10))) },
  ]);
  globalThis.fetch = big.handler;
  bb._test.resetRateLimit();
  const many = await scanner.fetchAllUnspentUtxos('15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB', { pageSize: 1000 });
  assert.equal(many.length, 1000, 'no cap is applied to the number of outputs');

  // The result wrapper used by the local fixtures is accepted as well.
  const legacy = makeServer([
    { cursor: null, respond: () => jsonResponse({ result: [row(7), row(8)] }) },
  ]);
  globalThis.fetch = legacy.handler;
  bb._test.resetRateLimit();
  const legacyRows = await scanner.fetchAllUnspentUtxos('15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB');
  assert.equal(legacyRows.length, 2);

  // A rate limited answer is retried instead of failing the scan.
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return new Response('{"error":"rate limit exceeded"}', { status: 429, headers: { 'x-ratelimit-limit': '80', 'x-ratelimit-remaining': '0' } });
    return jsonResponse([row(9)]);
  };
  bb._test.resetRateLimit();
  bb._test.setRateLimitWindowMs(60);
  const retried = await scanner.fetchAllUnspentUtxos('15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB');
  assert.equal(attempts, 2, 'the rate limited request is retried');
  assert.equal(retried.length, 1);

  // Once the allowance is spent the next request waits for the window.
  let remaining = 79;
  globalThis.fetch = async () => jsonResponse([row(10)], { 'x-ratelimit-remaining': String(remaining) });
  bb._test.resetRateLimit();
  bb._test.setRateLimitWindowMs(400);
  await bb.bananaBlocksFetch('https://bananablocks.com/api/v1/ping');
  remaining = 0;
  await bb.bananaBlocksFetch('https://bananablocks.com/api/v1/ping');
  assert.equal(bb.getRateLimitStatus().remaining, 0);
  const startedAt = Date.now();
  await bb.waitForRateLimitBudget();
  const waited = Date.now() - startedAt;
  assert.ok(waited >= 200, `the exhausted allowance pauses the next request (waited ${waited}ms)`);

  // A server error is reported with its status.
  globalThis.fetch = async () => new Response('{"error":"boom"}', { status: 500 });
  bb._test.resetRateLimit();
  await assert.rejects(
    () => scanner.fetchAllUnspentUtxos('15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB'),
    /HTTP 500/,
  );

  console.log('PASS: unbounded paginated UTXO scan, dual page shapes, cursor following, and rate-limit recovery');
} finally {
  await rm(profile, { recursive: true, force: true });
}
