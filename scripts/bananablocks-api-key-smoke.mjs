import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const profile = await mkdtemp(path.join(os.tmpdir(), 'lbsx-bb-key-'));
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
const config = require('../electron/bananablocks.cjs');
Module._load = originalLoad;

const apiKey = 'bb_live_smoke-test-key';
const calls = [];
globalThis.fetch = async (input, options = {}) => {
  calls.push({ url: String(input), headers: new Headers(options.headers || {}) });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

try {
  assert.deepEqual(await config.getBananaBlocksApiKeyStatus(), {
    configured: false, enabled: false, secureStorageAvailable: true,
  });

  const enabled = await config.saveBananaBlocksApiKey({ apiKey, enabled: true });
  assert.equal(enabled.configured, true);
  assert.equal(enabled.enabled, true);
  const saved = await readFile(path.join(profile, 'bananablocks-api-key.json'), 'utf8');
  assert(!saved.includes(apiKey), 'the API key must not be stored as plaintext');

  await config.bananaBlocksFetch('https://bananablocks.com/api/v1/status', { headers: { Accept: 'application/json' } });
  assert.equal(calls.at(-1).headers.get('x-api-key'), apiKey);
  await config.bananaBlocksFetch('https://example.com/status');
  assert.equal(calls.at(-1).headers.has('x-api-key'), false, 'the API key must not be sent to another host');

  const disabled = await config.saveBananaBlocksApiKey({ apiKey: '', enabled: false });
  assert.equal(disabled.configured, true, 'disabling keeps the encrypted key available for later');
  assert.equal(disabled.enabled, false);
  await config.bananaBlocksFetch('https://bananablocks.com/api/v1/status');
  assert.equal(calls.at(-1).headers.has('x-api-key'), false);

  await config.saveBananaBlocksApiKey({ apiKey: '', enabled: true });
  await config.bananaBlocksFetch('https://bananablocks.com/api/v1/status');
  assert.equal(calls.at(-1).headers.get('x-api-key'), apiKey, 'a saved key can be enabled again without re-entering it');

  const removed = await config.removeBananaBlocksApiKey();
  assert.equal(removed.configured, false);
  assert.equal(removed.enabled, false);
  await config.bananaBlocksFetch('https://bananablocks.com/api/v1/status');
  assert.equal(calls.at(-1).headers.has('x-api-key'), false);
  console.log('PASS: optional BananaBlocks API key is encrypted, scoped to BananaBlocks, and can be enabled, disabled, and removed');
} finally {
  await rm(profile, { recursive: true, force: true });
}
