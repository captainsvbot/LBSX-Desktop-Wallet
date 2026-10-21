import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Beef, MerklePath } = require('@bsv/sdk');
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const originalLoad = Module._load;
let savedHeaderChain = null;
let spvUserData = process.cwd();
let headerApiFetch = async () => { throw new Error('Unexpected SPV test API request.'); };
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => spvUserData } };
  if (request === './bananablocks.cjs') return {
    bananaBlocksFetch: (...args) => headerApiFetch(...args),
  };
  if (request === './wallet-data.cjs') return {
    getWalletData: async () => ({ proofs: [], bsvUtxos: [], tokenUtxos: [] }),
    getWalletHeaderChain: async () => savedHeaderChain,
    saveWalletHeaderChain: async (_address, headerChain) => { savedHeaderChain = headerChain; },
    getWalletTransactionProof: async () => null,
    saveWalletTransactionProof: async () => {},
    invalidateWalletProofs: async () => {},
  };
  return originalLoad.call(this, request, parent, isMain);
};
const spv = require('../electron/spv.cjs');
Module._load = originalLoad;

const genesisHeader = Buffer.from(
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c',
  'hex',
);

const historicalHeaders = Buffer.from(
  (await readFile(path.join('scripts', 'fixtures', 'bsv-483835-483858.headers'), 'utf8')).trim().split(/\s+/).join(''),
  'hex',
);
assert.equal(historicalHeaders.length, 24 * 80, 'the historical BSV regression fixture has the expected 24 headers');
const historicalValidator = spv._test.createHeaderValidator(historicalHeaders.subarray(0, 80), 483835);
historicalValidator.validateDifficulty = false; // This short fixture does not include the full retarget-aligned epoch.
for (let index = 1; index < historicalHeaders.length / 80; index++) {
  const height = 483835 + index;
  assert.equal(
    historicalValidator.addHeader({ buf: historicalHeaders.subarray(index * 80, (index + 1) * 80) }),
    true,
    `the canonical BSV header at height ${height} must pass proof-of-work and linkage validation`,
  );
}
assert.equal(historicalValidator.getTip().height, 23);
assert.equal(
  historicalValidator.getTip().hash,
  spv._test.headerHash(historicalHeaders.subarray(historicalHeaders.length - 80)),
  'the validated historical window must end at block 483858',
);

const alignedSeedIndex = 5;
const alignedSeedHeight = 483835 + alignedSeedIndex;
const alignedValidator = spv._test.createHeaderValidator(
  historicalHeaders.subarray(alignedSeedIndex * 80, (alignedSeedIndex + 1) * 80),
  alignedSeedHeight,
);
const rejectionReasons = [];
alignedValidator.logger = { warn: message => rejectionReasons.push(message) };
for (let index = alignedSeedIndex + 1; index < 19; index++) {
  const height = 483835 + index;
  const accepted = alignedValidator.addHeader({
    buf: historicalHeaders.subarray(index * 80, (index + 1) * 80),
  });
  if (height === 483853) {
    assert.equal(accepted, false, 'an aligned checkpoint without prior MTP context must reproduce the reported false rejection');
  } else {
    assert.equal(accepted, true, `the canonical BSV header at height ${height} should link to the aligned checkpoint`);
  }
}
assert.match(rejectionReasons[0] || '', /unexpected difficulty/,
  'the 483853 failure is caused by incomplete MTP context, not invalid proof-of-work or linkage');

const rangeStart = 483858;
const rangeValidator = spv._test.createHeaderValidator(
  historicalHeaders.subarray(alignedSeedIndex * 80, (alignedSeedIndex + 1) * 80),
  alignedSeedHeight,
);
for (let height = alignedSeedHeight + 1; height < rangeStart; height++) {
  const index = height - 483835;
  assert.equal(
    spv._test.addHeaderForRange(
      rangeValidator,
      historicalHeaders.subarray(index * 80, (index + 1) * 80),
      height,
      rangeStart,
    ),
    true,
    `previously validated cached header ${height} should remain proof-of-work and linkage checked`,
  );
}
const newHeaderIndex = rangeStart - 483835;
assert.equal(
  spv._test.addHeaderForRange(
    rangeValidator,
    historicalHeaders.subarray(newHeaderIndex * 80, (newHeaderIndex + 1) * 80),
    rangeStart,
    rangeStart,
  ),
  true,
  'difficulty checks resume for new headers after the cached prefix supplies full MTP context',
);

const key = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 32));
const tx = new bsv.Transaction().to(key.toAddress(), 1);
const txid = tx.id.toLowerCase();
const proof = new Beef();
proof.mergeProvenTxs([{
  rawTx: Buffer.from(tx.toString(), 'hex'),
  merklePath: new MerklePath(123, [[{ offset: 0, hash: txid, txid: true }]]),
  merkleRoot: txid,
}]);
const chainTracker = {
  currentHeight: async () => 123,
  isValidRootForHeight: async (root, height) => height === 123 && root === txid,
};

const validHeader = await spv._test.validateHeaderRange('unused-test-cache', 0, 0, genesisHeader);
assert.equal(validHeader.tipHeight, 0);
assert.equal(validHeader.tipHash, '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
assert(BigInt(validHeader.chainWork) > 0n, 'the genesis header contributes validated chain work');
await assert.rejects(
  () => spv._test.validateHeaderRange('unused-test-cache', 0, 0, Buffer.alloc(80)),
  /genesis block/,
  'the header validator must reject a chain not anchored at mainnet genesis',
);

const verified = await spv._test.verifyBeefHex(txid, proof.toHex(), chainTracker, 123);
assert.equal(verified.txid, txid);
assert.equal(verified.blockHeight, 123);
assert.equal(verified.rawTxHex, tx.toString());
assert.equal(verified.verified, true);
assert.equal(verified.validationVersion, 1, 'BEEF proof records keep their independent validation version');
await assert.rejects(
  () => spv._test.verifyBeefHex(txid, proof.toHex(), {
    ...chainTracker,
    isValidRootForHeight: async () => false,
  }, 123),
  /does not match the locally validated BSV header chain/,
  'a BEEF inclusion proof must be rejected when its root is not on the validated chain',
);
await assert.rejects(
  () => spv._test.verifyBeefHex(txid, proof.toHex(), chainTracker, 124),
  /does not match the wallet history/,
  'a BEEF proof at a different indexed height must be rejected',
);

const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'lbsx-spv-cache-'));
try {
  const partialCachePath = path.join(cacheDirectory, 'partial.headers');
  await writeFile(partialCachePath, Buffer.alloc((2016 + 1) * 80));
  const partialCacheState = await spv._test.loadValidatedCache(
    'partial-cache-wallet',
    partialCachePath,
    async (_file, startHeight) => {
      if (startHeight === 0) return { chainWork: '123' };
      throw new Error('synthetic invalid cached range');
    },
  );
  assert.equal(partialCacheState.tipHeight, 2015);
  assert.equal(partialCacheState.repairFromHeight, 2016);
  assert.equal(partialCacheState.chainWork, '123', 'cache repair retains accumulated work from the validated prefix');

  const syntheticCachePath = path.join(cacheDirectory, 'synthetic.headers');
  await writeFile(syntheticCachePath, Buffer.alloc((2016 + 1) * 80));
  await assert.rejects(
    () => spv._test.validateFullCache(syntheticCachePath, 2017, async (_file, startHeight) => {
      if (startHeight === 0) return { chainWork: '123' };
      throw new Error('synthetic invalid cached range');
    }),
    error => error.invalidRangeStart === 2016
      && error.validatedTipHeight === 2015
      && error.chainWork === '123',
    'cache validation reports the last trusted prefix so a bad suffix can be replaced without redownloading the prefix',
  );

  const cachePath = path.join(cacheDirectory, 'mainnet.headers');
  await writeFile(cachePath, genesisHeader);
  spv._test.resetState();
  const validationProgress = [];
  const unsubscribe = spv.onProgress(progress => {
    if (progress.phase === 'validating') validationProgress.push(progress.completed);
  });
  const firstCacheState = await spv._test.loadValidatedCache('test-wallet', cachePath);
  const firstValidationProgressCount = validationProgress.length;
  const secondCacheState = await spv._test.loadValidatedCache('test-wallet', cachePath);
  unsubscribe();
  assert.equal(firstCacheState.tipHeight, 0);
  assert.equal(secondCacheState.tipHash, firstCacheState.tipHash);
  assert(firstValidationProgressCount > 0, 'the first cache load should validate its headers');
  assert.equal(validationProgress.length, firstValidationProgressCount, 'a successfully validated cache must not restart full header validation');

  const recoveryCachePath = path.join(cacheDirectory, 'spv', 'mainnet.headers');
  await mkdir(path.dirname(recoveryCachePath), { recursive: true });
  const invalidHeader = Buffer.from(genesisHeader);
  invalidHeader.writeUInt32LE(invalidHeader.readUInt32LE(68) + 1, 68);
  await writeFile(recoveryCachePath, Buffer.concat([genesisHeader, invalidHeader]));
  spvUserData = cacheDirectory;
  headerApiFetch = async url => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith('/block/tip')) {
      return new Response(JSON.stringify({
        height: 0,
        hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
      }));
    }
    if (pathname.endsWith('/block/headers/0-0')) {
      return new Response(genesisHeader, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    throw new Error(`Unexpected SPV recovery URL ${url}`);
  };
  spv._test.resetState();
  spv._test.setRequestIntervalMs(0);
  const recoveredCacheState = await spv.ensureHeaderChain('repair-test-wallet');
  assert.equal(recoveredCacheState.tipHeight, 0, 'an invalid cached suffix is rebuilt from the verified prefix');
  assert.deepEqual(await readFile(recoveryCachePath), genesisHeader, 'successful cache repair removes the invalid suffix');
  assert.equal(savedHeaderChain.validationVersion, 3, 'repaired cache metadata records the updated validation rules');
} finally {
  await rm(cacheDirectory, { recursive: true, force: true });
}

console.log('PASS: SPV genesis anchoring, chain work, BEEF inclusion, invalid proof rejection, and cached header validation');
