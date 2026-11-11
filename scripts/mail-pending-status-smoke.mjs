// Tests the pending -> confirmed refresh that the Email Sync button relies on.
//
// The rule: a message stored as PENDING must flip to CONFIRMED once its
// transaction has been mined, and the Email Sync button must do that on its
// own - the activity rows are only refreshed by the ACTIVITY sync, so mail
// cannot depend on them for confirmation state.
//
// This drives the REAL refreshPendingMailStatuses against the REAL BananaBlocks
// API, using a transaction that is already mined.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The bananablocks module reads the API key from Electron's safeStorage and
// resolves its settings path from Electron's `app`, neither of which exist
// outside a running Electron process. The module is stubbed here so the REAL
// refresh logic can be exercised in plain Node.
//
// The BananaBlocks key is optional: the public API answers without one for
// public data.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lbsx-pending-status-'));
import Module from 'node:module';
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub',
  filename: 'electron-stub',
  loaded: true,
  exports: {
    app: { getPath: () => tempHome, getVersion: () => '2.1.13', isPackaged: false },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: value => Buffer.from(String(value), 'utf8'),
      decryptString: buffer => buffer.toString('utf8'),
    },
  },
};

const { refreshPendingMailStatuses } = require('../electron/mail.cjs');

console.log('=== PENDING -> CONFIRMED REFRESH ===');

// A real, mined mainnet transaction. block_height is 974830.
const MINED_TXID = 'd46a76fb5b5952aa0b1166f985a7598c101866d9e1d82a68a5214559872431b7';

function message(overrides = {}) {
  return {
    txid: MINED_TXID,
    messageId: 'a'.repeat(64),
    status: 'pending',
    blockHeight: 0,
    ...overrides,
  };
}

async function main() {
  // --- 1. a pending message whose transaction is mined becomes confirmed ---
  {
    const messages = [message()];
    const report = await refreshPendingMailStatuses(messages);

    assert.equal(report.checked, 1, 'the pending message was checked');
    // The BananaBlocks public API is rate limited. A 429 leaves the message
    // pending, which is correct behaviour but would make this test flaky when
    // the whole suite runs back to back. Retry a few times before failing.
    if (report.confirmed === 0) {
      console.log('  (rate limited by the chain API - retrying)');
      await new Promise(resolve => setTimeout(resolve, 3000));
      const retry = await refreshPendingMailStatuses(messages);
      assert.equal(retry.confirmed, 1, 'the mined transaction was detected as confirmed');
    }
    assert.equal(messages[0].status, 'confirmed', 'the message status flipped to confirmed');
    assert.ok(messages[0].blockHeight > 0, 'the block height was recorded');
    console.log('  a pending message with a mined transaction becomes confirmed: OK');
    console.log('    block height recorded:', messages[0].blockHeight);
  }

  // --- 2. an already-confirmed message is NOT re-checked ---
  {
    const messages = [message({ status: 'confirmed', blockHeight: 974830 })];
    const report = await refreshPendingMailStatuses(messages);

    assert.equal(report.checked, 0, 'a confirmed message is never re-checked');
    assert.equal(report.confirmed, 0, 'nothing changed');
    assert.equal(messages[0].blockHeight, 974830, 'the original block height is untouched');
    console.log('  an already-confirmed message is not re-checked: OK');
  }

  // --- 3. a pending message with an UNMINED transaction stays pending ---
  {
    // A txid that does not exist on chain: the lookup fails or returns no
    // height, and the message must stay pending rather than being marked
    // confirmed by mistake.
    const messages = [message({ txid: 'f'.repeat(64) })];
    const report = await refreshPendingMailStatuses(messages);

    assert.equal(report.checked, 1, 'the message was checked');
    assert.equal(report.confirmed, 0, 'an unmined transaction is not confirmed');
    assert.equal(messages[0].status, 'pending', 'the message stays pending');
    console.log('  a pending message with an unmined transaction stays pending: OK');
  }

  // --- 4. a failed lookup must not throw ---
  {
    // A malformed txid is filtered out by the TXID_RE guard, so it is never
    // even attempted.
    const messages = [message({ txid: 'not-a-txid' })];
    const report = await refreshPendingMailStatuses(messages);
    assert.equal(report.checked, 0, 'a malformed txid is skipped without a request');
    console.log('  a malformed txid is skipped without a request: OK');
  }

  // --- 5. a mixed batch: only the pending ones are touched ---
  {
    const messages = [
      message({ messageId: 'a'.repeat(64) }),
      message({ messageId: 'b'.repeat(64), status: 'confirmed', blockHeight: 1 }),
      message({ messageId: 'c'.repeat(64), txid: 'f'.repeat(64) }),
    ];
    const report = await refreshPendingMailStatuses(messages);

    assert.equal(report.checked, 2, 'only the two pending messages were checked');
    assert.equal(report.confirmed, 1, 'exactly one of them was confirmed');
    assert.equal(messages[0].status, 'confirmed', 'the mined one flipped');
    assert.equal(messages[1].status, 'confirmed', 'the already-confirmed one is untouched');
    assert.equal(messages[2].status, 'pending', 'the unmined one stays pending');
    console.log('  a mixed batch only touches the pending messages: OK');
  }

  // --- 6. nothing pending means no requests at all ---
  {
    const report = await refreshPendingMailStatuses([]);
    assert.equal(report.checked, 0);
    assert.equal(report.confirmed, 0);
    console.log('  an empty batch does no work: OK');
  }

  console.log('');
  console.log('PASS: the Email Sync refreshes pending messages to confirmed using the chain');
}

main().catch(error => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
