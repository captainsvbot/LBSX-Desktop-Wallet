import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const spvTestMock = require('./spv-test-mock.cjs');
const profile = await mkdtemp(path.join(os.tmpdir(), 'lbsx-wallet-data-'));
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => profile } };
  if (request === './vault.cjs') return { getWalletDataEncryptionKey: () => Buffer.alloc(32, 0x5a) };
  if (request === './spv.cjs') return spvTestMock;
  return originalLoad.call(this, request, parent, isMain);
};
const walletData = require('../electron/wallet-data.cjs');
const { broadcastTrackedTransaction } = require('../electron/transaction-tracker.cjs');
const tokenWallet = require('../electron/token-wallet.cjs');
const { syncWalletBalances, syncWalletActivity, checkPendingTransactionStatuses, _test: chainTest } = require('../electron/chain.cjs');
Module._load = originalLoad;

const key = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 13));
const address = key.toAddress().toString();
const recipient = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 14)).toAddress().toString();
const p2pkh = bsv.Script.buildPublicKeyHashOut(address);
const tokenId = `${'ab'.repeat(32)}_1`;
const tokenScript = tokenWallet._test.transferScript(address, tokenId, '77');

function response(data, status = 200, contentType = 'application/json', headers = {}) {
  return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': contentType, ...headers } });
}

try {
  await walletData.saveImportedToken(address, { tokenId, symbol: 'TST', name: 'Test Token', decimals: 2, balance: '0' });
  const imported = await walletData.getWalletActivitySnapshot(address);
  assert.equal(imported.importedTokens[0].tokenId, tokenId);
  assert.equal(imported.activities[0].type, 'token-import');

  const confirmedAdminTx = new bsv.Transaction()
    .from({ txid: '55'.repeat(32), vout: 0, satoshis: 10000, script: p2pkh.toHex() })
    .to(address, 9000);
  const pendingAdminTx = new bsv.Transaction()
    .from({ txid: '56'.repeat(32), vout: 0, satoshis: 10000, script: p2pkh.toHex() })
    .to(address, 9000);
  await walletData.saveWalletAdminIndexSnapshot(address, {
    transactions: [{
      txid: confirmedAdminTx.id.toLowerCase(),
      blockHeight: 900010,
      blockTime: 1760000000,
      rawTxHex: confirmedAdminTx.toString(),
      confirmed: true,
      details: { inputs: [], outputs: [] },
    }],
    pendingTransactions: [{
      txid: pendingAdminTx.id.toLowerCase(),
      blockHeight: 0,
      blockTime: 0,
      rawTxHex: pendingAdminTx.toString(),
      confirmed: false,
      details: { inputs: [], outputs: [] },
    }],
    syncedAt: new Date().toISOString(),
    historyComplete: true,
  });
  const adminIndexSnapshot = await walletData.getWalletAdminIndexSnapshot(address);
  assert.equal(adminIndexSnapshot.transactions[0].txid, confirmedAdminTx.id.toLowerCase(),
    'confirmed admin index records persist in encrypted wallet data');
  assert.equal(adminIndexSnapshot.pendingTransactions[0].txid, pendingAdminTx.id.toLowerCase(),
    'unconfirmed admin listing records persist separately in encrypted wallet data');
  assert.equal(adminIndexSnapshot.pendingTransactions[0].confirmed, false);
  const peerMessageTxid = '57'.repeat(32);
  await walletData.saveWalletPeerChatSnapshot(address, {
    messages: [{
      txid: peerMessageTxid,
      senderAddress: address,
      content: 'Encrypted local peer-chat history',
      isEncrypted: true,
      timestamp: new Date().toISOString(),
      status: 'pending',
      blockHeight: 0,
    }],
    lastScannedTxid: peerMessageTxid,
    syncedAt: new Date().toISOString(),
  });
  const peerChatSnapshot = await walletData.getWalletPeerChatSnapshot(address);
  assert.equal(peerChatSnapshot.messages[0].txid, peerMessageTxid,
    'pending Peer Chat messages and scan pointers persist in encrypted wallet data');
  assert.equal(peerChatSnapshot.messages[0].isEncrypted, true,
    'the local feed preserves whether a message used the app-obfuscated on-chain format');
  assert.equal(peerChatSnapshot.lastScannedTxid, peerMessageTxid);

  const firstTx = new bsv.Transaction();
  firstTx.from({ txid: '11'.repeat(32), vout: 0, satoshis: 50000, script: p2pkh.toHex() });
  firstTx.to(recipient, 10000);
  firstTx.to(address, 39900);
  const firstTxid = firstTx.id.toLowerCase();
  await broadcastTrackedTransaction({
    address,
    txid: firstTxid,
    rawHex: firstTx.toString(),
    type: 'bsv-send',
    inputOutpoints: [`${'11'.repeat(32)}.0`],
    details: { title: 'BSV sent', amountSats: 10000, recipient },
    broadcast: async () => {},
  });
  const firstChange = (await walletData.getSpendableBsvUtxos(address)).find(row => row.txid === firstTxid);
  assert(firstChange, 'locally accepted change is spendable before confirmation');
  assert.equal(firstChange.state, 'pending');

  let broadcastTx;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/tx/broadcast') || url.pathname.endsWith('/bsv/main/tx/raw')) {
      const body = JSON.parse(init.body);
      broadcastTx = new bsv.Transaction(body.rawtx || body.txhex);
      return response({ txid: broadcastTx.id });
    }
    throw new Error(`Unexpected BSV-send URL ${url}`);
  };
  const childSend = await tokenWallet.sendBsv(key, { recipient, amount: '0.00010000' });
  assert.equal(childSend.txid, broadcastTx.id.toLowerCase());
  assert.equal(broadcastTx.inputs[0].prevTxId.toString('hex'), firstTxid, '0-conf child spends locally tracked parent change');
  assert.equal(broadcastTx.inputs[0].outputIndex, firstChange.vout);
  const childActivity = (await walletData.getWalletActivitySnapshot(address)).activities.find(row => row.txid === childSend.txid);
  assert.equal(childActivity.details.walletInputSats, String(firstChange.satoshis), 'local send history records the wallet input value');
  assert.equal(BigInt(childActivity.details.walletInputSats) - BigInt(childActivity.details.changeSats), BigInt(childActivity.details.walletNetSpentSats), 'local send history records returned change and net BSV debit');
  assert.equal(BigInt(childActivity.details.walletNetSpentSats), BigInt(childSend.amountSats) + BigInt(childSend.serviceFeeSats) + BigInt(childActivity.details.feeSats), 'the net BSV debit includes the service fee and the actual network fee');
  const afterChild = await walletData.getSpendableBsvUtxos(address);
  assert(!afterChild.some(row => row.txid === firstTxid), 'the parent change is no longer spendable after local consumption');
  assert(afterChild.some(row => row.txid === childSend.txid && row.state === 'pending'), 'the child change is available for another 0-conf spend');

  const tokenTx = new bsv.Transaction();
  tokenTx.from({ txid: '22'.repeat(32), vout: 0, satoshis: 1000, script: p2pkh.toHex() });
  tokenTx.addOutput(new bsv.Transaction.Output({ script: tokenScript, satoshis: 1 }));
  const tokenTxid = tokenTx.id.toLowerCase();
  await broadcastTrackedTransaction({
    address,
    txid: tokenTxid,
    rawHex: tokenTx.toString(),
    type: 'token-buy',
    inputOutpoints: [`${'22'.repeat(32)}.0`],
    details: { title: 'BSV-21 token purchased', tokenId, tokenAmount: '77', decimals: 2 },
    broadcast: async () => {},
  });
  const spendableToken = await walletData.getSpendableTokenUtxos(address, tokenId);
  assert.equal(spendableToken[0].amount, '77', 'locally created BSV-21 output is tracked before confirmation');
  assert.equal(spendableToken[0].state, 'pending');

  const legacyLocks = [{
    id: `${tokenTxid}_0`, tokenId, ownerAddress: address, amount: '0.77', amountBase: '77',
    lockTxid: tokenTxid, outpoint: `${tokenTxid}_0`, unlockTimestamp: 9999999999, status: 'locked',
  }];
  await writeFile(path.join(profile, 'token-locks.json'), JSON.stringify(legacyLocks), 'utf8');
  await tokenWallet.migrateLegacyTokenLocks(address);
  const migrated = await walletData.getWalletData(address);
  assert.equal(migrated.tokenLocks.length, 1, 'legacy locker data is preserved in the encrypted wallet store');
  assert(!((await readdir(profile)).includes('token-locks.json')), 'plaintext legacy locker file is removed after migration');

  const remoteTxid = '33'.repeat(32);
  let detailLookups = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const pathname = url.pathname;
    if (pathname.endsWith('/unconfirmed/history')) return response({ result: [] });
    if (pathname.endsWith('/history')) return response([{ tx_hash: remoteTxid, height: 900001 }]);
    if (pathname === `/api/v1/tx/${remoteTxid}`) {
      detailLookups++;
      return response({
        txid: remoteTxid,
        block_height: 900001,
        block_time: 1760000000,
        inputs: [{ address: recipient, value: 12000 }],
        outputs: [{
          index: 0,
          address,
          value: 10000,
          parsed: { bsv21: { valid: true, op: 'transfer', id: tokenId, amt: '123', sym: 'TST' } },
        }],
      });
    }
    if (pathname.endsWith('/unspent')) return response([{ tx_hash: remoteTxid, tx_pos: 0, value: 10000, height: 900001 }]);
    if (pathname.endsWith('/status')) return response({ txStatus: 'SEEN_ON_NETWORK' });
    throw new Error(`Unexpected history URL ${url}`);
  };
  const synced = await syncWalletActivity(address);
  const received = synced.activities.find(row => row.txid === remoteTxid);
  assert(received, 'history refresh stores the transaction locally');
  assert.equal(received.type, 'bsv-receive');
  assert.equal(received.amountSats, 10000);
  assert.equal(received.tokenAmount, '123');
  assert.equal(received.status, 'confirmed');
  assert.equal(synced.historyBackfillComplete, true);
  assert.equal(synced.utxoCount, 1);
  const outgoingSummary = chainTest.summarizeWalletTransaction({
    txid: '44'.repeat(32),
    inputs: [{ address, value: 50000 }],
    outputs: [{ address: recipient, value: 10000 }, { address, value: 39900 }],
  }, address, { txid: '44'.repeat(32), height: 900002 }, null);
  assert.equal(outgoingSummary.type, 'bsv-send');
  assert.equal(outgoingSummary.details.walletInputSats, '50000');
  assert.equal(outgoingSummary.details.changeSats, '39900');
  assert.equal(outgoingSummary.details.walletNetSpentSats, '10100');
  assert.equal(outgoingSummary.details.feeSats, '100', 'chain details preserve the fee separately from change and net debit');
  const persistedChainSnapshot = await walletData.saveWalletChainSnapshot(address, {
    address,
    balance: { confirmed: '123456', unconfirmed: '789', spendableBsvSats: '122000', pendingLocalBsvSats: '789' },
    tokens: [{ tokenId, symbol: 'TST', name: 'Test Token', decimals: 2, balance: '12345' }],
    errors: { bsv: null, tokens: null, utxos: null },
    utxoCount: 1,
    syncedAt: '2026-01-01T00:00:00.000Z',
    balanceSyncedAt: '2026-01-01T00:00:00.000Z',
    tokensSyncedAt: '2026-01-01T00:00:00.000Z',
    utxoSyncedAt: '2026-01-01T00:00:00.000Z',
    source: 'BananaBlocks API',
  });
  assert.equal(persistedChainSnapshot.balance.confirmed, '123456');
  assert.equal((await walletData.getWalletActivitySnapshot(address)).chainSnapshot.tokens[0].balance, '12345');
  await syncWalletActivity(address);
  assert.equal(detailLookups, 1, 'subsequent refreshes do not refetch known transaction details');
  assert.equal((await walletData.getWalletActivitySnapshot(address)).chainSnapshot.balance.confirmed, '123456', 'activity refresh preserves the cached balance snapshot');

  chainTest.setApiMinIntervalMs(0);
  const statusAddress = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 26)).toAddress().toString();
  const statusScript = bsv.Script.buildPublicKeyHashOut(statusAddress);
  const statusTx = new bsv.Transaction()
    .from({ txid: 'a1'.repeat(32), vout: 0, satoshis: 10000, script: statusScript.toHex() })
    .to(recipient, 5000)
    .to(statusAddress, 4900);
  const statusTxid = statusTx.id.toLowerCase();
  await broadcastTrackedTransaction({
    address: statusAddress,
    txid: statusTxid,
    rawHex: statusTx.toString(),
    type: 'bsv-send',
    details: { title: 'BSV sent' },
    broadcast: async () => {},
  });
  let minedStatusLookups = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/unconfirmed/history')) return response({ result: [] });
    if (url.pathname.endsWith('/history')) return response([{ tx_hash: statusTxid, height: 0 }]);
    if (url.pathname === `/api/v1/tx/${statusTxid}/status`) {
      minedStatusLookups++;
      return response({ txStatus: 'MINED', blockHeight: 901234 });
    }
    if (url.pathname.endsWith('/unspent')) return response({ result: [] });
    throw new Error(`Unexpected mined-status sync URL ${url}`);
  };
  const minedStatusSync = await syncWalletActivity(statusAddress);
  const minedActivity = minedStatusSync.activities.find(row => row.txid === statusTxid);
  assert.equal(minedStatusLookups, 1, 'pending local transactions are status-checked even when history still reports them as unconfirmed');
  assert.equal(minedActivity.status, 'confirmed');
  assert.equal(minedActivity.blockHeight, 901234);
  assert.equal((await walletData.getWalletData(statusAddress)).transactions.find(row => row.txid === statusTxid).status, 'confirmed',
    'the local transaction and its spend state advance when BananaBlocks reports MINED');

  const statusOnlyTx = new bsv.Transaction()
    .from({ txid: 'a2'.repeat(32), vout: 0, satoshis: 10000, script: statusScript.toHex() })
    .to(recipient, 5000)
    .to(statusAddress, 4900);
  const statusOnlyTxid = statusOnlyTx.id.toLowerCase();
  await broadcastTrackedTransaction({
    address: statusAddress,
    txid: statusOnlyTxid,
    rawHex: statusOnlyTx.toString(),
    type: 'peer-chat-message',
    details: { title: 'Peer Chat message' },
    broadcast: async () => {},
  });
  const priorHistoryRefreshAt = (await walletData.getWalletActivitySnapshot(statusAddress)).syncedAt;
  let statusOnlyLookups = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === `/api/v1/tx/${statusOnlyTxid}/status`) {
      statusOnlyLookups++;
      return response({ txStatus: 'CONFIRMED', block_height: 901235, confirmations: 2 });
    }
    throw new Error(`Unexpected pending-status-only URL ${url}`);
  };
  const statusOnlySnapshot = await checkPendingTransactionStatuses(statusAddress);
  const statusOnlyActivity = statusOnlySnapshot.activities.find(row => row.txid === statusOnlyTxid);
  assert.equal(statusOnlyLookups, 1, 'the pending-only check requests status without refreshing address history or UTXOs');
  assert.equal(statusOnlySnapshot.checkedTransactions, 1);
  assert.equal(statusOnlyActivity.status, 'confirmed', 'the status-only check updates the locally stored Activity row');
  assert.equal(statusOnlyActivity.blockHeight, 901235);
  assert.equal(statusOnlySnapshot.syncedAt, priorHistoryRefreshAt, 'a status-only check does not misreport the full history refresh time');
  assert(statusOnlySnapshot.transactionStatusCheckedAt, 'the status-check time is retained in the encrypted wallet snapshot');

  const historyConfirmedTx = new bsv.Transaction()
    .from({ txid: 'a3'.repeat(32), vout: 0, satoshis: 10000, script: statusScript.toHex() })
    .to(recipient, 5000)
    .to(statusAddress, 4900);
  const historyConfirmedTxid = historyConfirmedTx.id.toLowerCase();
  await broadcastTrackedTransaction({
    address: statusAddress,
    txid: historyConfirmedTxid,
    rawHex: historyConfirmedTx.toString(),
    type: 'peer-chat-message',
    details: { title: 'Peer Chat message' },
    broadcast: async () => {},
  });
  let unexpectedHistoryStatusLookups = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/unconfirmed/history')) return response({ result: [] });
    if (url.pathname.endsWith('/history')) return response([{ tx_hash: historyConfirmedTxid, height: 901236 }]);
    if (url.pathname === `/api/v1/tx/${historyConfirmedTxid}/status`) {
      unexpectedHistoryStatusLookups++;
      return response({ txStatus: 'SEEN_ON_NETWORK' });
    }
    if (url.pathname.endsWith('/unspent')) return response({ result: [] });
    throw new Error(`Unexpected confirmed-history sync URL ${url}`);
  };
  const historyConfirmedSnapshot = await syncWalletActivity(statusAddress);
  const historyConfirmedActivity = historyConfirmedSnapshot.activities.find(row => row.txid === historyConfirmedTxid);
  assert.equal(unexpectedHistoryStatusLookups, 0, 'a confirmed history height is used directly instead of requesting a stale mempool status');
  assert.equal(historyConfirmedActivity.status, 'confirmed', 'confirmed chain history advances the saved Activity status');
  assert.equal(historyConfirmedActivity.blockHeight, 901236);
  assert.equal((await walletData.getWalletData(statusAddress)).transactions.find(row => row.txid === historyConfirmedTxid).status, 'confirmed');

  const pageAddress = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 16)).toAddress().toString();
  const pagedTxids = Array.from({ length: 478 }, (_, index) => (index + 1).toString(16).padStart(64, '0'));
  const pagedHistoryCursors = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/unconfirmed/history')) return response({ result: [] });
    if (url.pathname.endsWith('/history')) {
      const cursor = url.searchParams.get('cursor');
      pagedHistoryCursors.push(cursor);
      const start = cursor ? Number(cursor.replace(/^next-/, '')) : 0;
      const page = pagedTxids.slice(start, start + 100);
      const headers = start + page.length < pagedTxids.length
        ? { 'X-Has-More': 'true', 'X-Next-Cursor': `next-${start + page.length}` }
        : { 'X-Has-More': 'false' };
      return response(page.map((txid, index) => ({ tx_hash: txid, height: 900100 + start + index })), 200, 'application/json', headers);
    }
    if (/\/tx\/[0-9a-f]{64}$/.test(url.pathname)) {
      const txid = url.pathname.split('/').at(-1);
      return response({ txid, block_height: 900100, inputs: [], outputs: [] });
    }
    if (url.pathname.endsWith('/unspent')) return response({ result: [] });
    throw new Error(`Unexpected paginated history URL ${url}`);
  };
  const pagedSync = await syncWalletActivity(pageAddress);
  assert.equal(pagedSync.scannedTransactions, 478, 'cursor-based history backfill reads all 478 indexed transactions');
  assert.equal(pagedSync.historyPagesRead, 5);
  assert.deepEqual(pagedHistoryCursors, [null, 'next-100', 'next-200', 'next-300', 'next-400'],
    'subsequent pages use the opaque server continuation cursor instead of numeric skip offsets');
  assert.equal(pagedSync.historyBackfillComplete, true);
  assert.equal((await walletData.getWalletActivitySnapshot(pageAddress)).activities.length, 478);

  const incrementalTxids = ['fe'.repeat(32), 'fd'.repeat(32)];
  const incrementalHistoryCursors = [];
  let incrementalDetailLookups = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/unconfirmed/history')) return response({ result: [] });
    if (url.pathname.endsWith('/history')) {
      const cursor = url.searchParams.get('cursor');
      incrementalHistoryCursors.push(cursor);
      const page = cursor
        ? pagedTxids.slice(98, 198)
        : [...incrementalTxids, ...pagedTxids.slice(0, 98)];
      return response(page.map((tx_hash, index) => {
        const originalIndex = pagedTxids.indexOf(tx_hash);
        return { tx_hash, height: originalIndex < 0 ? 901000 + index : 900100 + originalIndex };
      }), 200, 'application/json', {
        'X-Has-More': 'true',
        'X-Next-Cursor': cursor ? 'next-200' : 'next-100',
      });
    }
    if (/\/tx\/[0-9a-f]{64}$/.test(url.pathname)) {
      const txid = url.pathname.split('/').at(-1);
      incrementalDetailLookups++;
      return response({ txid, block_height: 901000, inputs: [], outputs: [] });
    }
    if (url.pathname.endsWith('/unspent')) return response({ result: [] });
    throw new Error(`Unexpected incremental history URL ${url}`);
  };
  const incrementalSync = await syncWalletActivity(pageAddress);
  const incrementalSnapshot = await walletData.getWalletActivitySnapshot(pageAddress);
  assert.deepEqual(incrementalHistoryCursors, [null, 'next-100'],
    'after full backfill, refresh follows new history until it reaches a page containing only known txids');
  assert.equal(incrementalSync.historyPagesRead, 2);
  assert.equal(incrementalSync.processedTransactions, 2, 'only the two unseen transactions need detail lookups');
  assert.equal(incrementalDetailLookups, 2);
  assert.equal(incrementalSnapshot.activities.length, 480, 'new rows merge into the existing local history without duplicates');
  assert.equal(new Set(incrementalSnapshot.activities.map(row => row.txid)).size, 480);

  const resumeAddress = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 19)).toAddress().toString();
  const resumeTxids = Array.from({ length: 150 }, (_, index) => (index + 501).toString(16).padStart(64, '0'));
  let cursorPageRetries = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/unconfirmed/history')) return response({ result: [] });
    if (url.pathname.endsWith('/history')) {
      const cursor = url.searchParams.get('cursor');
      if (cursor === 'next-100' && cursorPageRetries < 4) {
        cursorPageRetries++;
        return response({ error: 'rate limit exceeded' }, 429, 'application/json', { 'Retry-After': '0' });
      }
      const start = cursor ? Number(cursor.replace(/^next-/, '')) : 0;
      const page = resumeTxids.slice(start, start + 100);
      const headers = start + page.length < resumeTxids.length
        ? { 'X-Has-More': 'true', 'X-Next-Cursor': `next-${start + page.length}` }
        : { 'X-Has-More': 'false' };
      return response(page.map((txid, index) => ({ tx_hash: txid, height: 900300 + start + index })), 200, 'application/json', headers);
    }
    if (url.pathname.endsWith('/unspent')) return response({ result: [] });
    throw new Error(`Unexpected cursor-resume URL ${url}`);
  };
  const interruptedSync = await syncWalletActivity(resumeAddress);
  const interruptedData = await walletData.getWalletData(resumeAddress);
  assert.equal(cursorPageRetries, 4, 'cursor page errors use the normal rate-limit retry budget');
  assert.equal(interruptedSync.historyBackfillComplete, false);
  assert.equal(interruptedData.historyCursor, 'next-100', 'the encrypted wallet data preserves the failed page cursor');
  assert.equal(interruptedData.historyPageCursor, 1);

  const resumedHistoryCursors = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/unconfirmed/history')) return response({ result: [] });
    if (url.pathname.endsWith('/history')) {
      const cursor = url.searchParams.get('cursor');
      resumedHistoryCursors.push(cursor);
      const start = cursor ? Number(cursor.replace(/^next-/, '')) : 0;
      const page = resumeTxids.slice(start, start + 100);
      const headers = start + page.length < resumeTxids.length
        ? { 'X-Has-More': 'true', 'X-Next-Cursor': `next-${start + page.length}` }
        : { 'X-Has-More': 'false' };
      return response(page.map((txid, index) => ({ tx_hash: txid, height: 900300 + start + index })), 200, 'application/json', headers);
    }
    if (/\/tx\/[0-9a-f]{64}$/.test(url.pathname)) {
      const txid = url.pathname.split('/').at(-1);
      return response({ txid, block_height: 900300, inputs: [], outputs: [] });
    }
    if (url.pathname.endsWith('/unspent')) return response({ result: [] });
    throw new Error(`Unexpected resumed cursor URL ${url}`);
  };
  const resumedSync = await syncWalletActivity(resumeAddress);
  assert.deepEqual(resumedHistoryCursors, ['next-100'], 'a later refresh resumes from the persisted opaque cursor');
  assert.equal(resumedSync.scannedTransactions, 50);
  assert.equal(resumedSync.processedTransactions, 150, 'queued references from before the interruption are retained and processed');
  assert.equal(resumedSync.historyBackfillComplete, true);
  assert.equal((await walletData.getWalletActivitySnapshot(resumeAddress)).activities.length, 150);

  const rateAddress = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 17)).toAddress().toString();
  const queuedTxids = ['f1'.repeat(32), 'f2'.repeat(32)];
  let rateLimitedDetailRequests = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/unconfirmed/history')) return response({ result: [] });
    if (url.pathname.endsWith('/history')) return response({ result: queuedTxids.map(tx_hash => ({ tx_hash, height: 900200 })) });
    if (/\/tx\/[0-9a-f]{64}$/.test(url.pathname)) {
      rateLimitedDetailRequests++;
      return response({ error: 'rate limit exceeded' }, 429, 'application/json', { 'Retry-After': '0' });
    }
    throw new Error(`Unexpected rate-limited history URL ${url}`);
  };
  const limitedSync = await syncWalletActivity(rateAddress);
  assert.equal(rateLimitedDetailRequests, 4, '429 responses are retried with the configured retry budget');
  assert.equal(limitedSync.remaining, 2, 'the failed and unprocessed detail lookups remain queued');
  assert(limitedSync.errors.some(message => message.includes('rate limiting')));
  assert(limitedSync.activities.find(row => row.txid === queuedTxids[0])?.details?.lookupError);
  assert.equal((await walletData.getWalletActivitySnapshot(rateAddress)).remaining, 2);

  let recoveredLookups = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/unconfirmed/history')) return response({ result: [] });
    if (url.pathname.endsWith('/history')) return response({ result: queuedTxids.map(tx_hash => ({ tx_hash, height: 900200 })) });
    if (/\/tx\/[0-9a-f]{64}$/.test(url.pathname)) {
      recoveredLookups++;
      const txid = url.pathname.split('/').at(-1);
      return response({ txid, block_height: 900200, inputs: [], outputs: [] });
    }
    if (url.pathname.endsWith('/unspent')) return response({ result: [] });
    throw new Error(`Unexpected history recovery URL ${url}`);
  };
  const recoveredSync = await syncWalletActivity(rateAddress);
  assert.equal(recoveredLookups, 2, 'the next refresh retries both the failed and deferred transactions');
  assert.equal(recoveredSync.remaining, 0);
  assert(recoveredSync.activities.filter(row => queuedTxids.includes(row.txid)).every(row => !row.details?.lookupError), 'successful detail lookups clear their retry marker');

  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/balance')) return response({ confirmed: '765432', unconfirmed: '12' });
    if (url.pathname.endsWith('/tokens')) return response({ tokens: [{ token_id: tokenId, symbol: 'TST', name: 'Test Token', decimals: 2, balance: '9876' }] });
    if (url.pathname.endsWith('/history') && url.pathname.includes('/token/')) return response({ transfers: [] });
    if (/\/tx\/[0-9a-f]{64}$/.test(url.pathname)) return response({ error: 'not found' }, 404);
    if (url.pathname.endsWith('/unspent')) return response({ result: [] });
    throw new Error(`Unexpected balance snapshot URL ${url}`);
  };
  const refreshedBalance = await syncWalletBalances(address);
  assert.equal(refreshedBalance.balance.confirmed, '765432');
  assert.equal(refreshedBalance.balance.unconfirmed, '12');
  assert.equal(refreshedBalance.tokens[0].balance, '9876');
  assert.equal((await walletData.getWalletActivitySnapshot(address)).chainSnapshot.balance.confirmed, '765432', 'successful chain sync persists balance and token holdings');

  globalThis.fetch = async () => response({ error: 'rate limit exceeded' }, 429, 'application/json', { 'Retry-After': '0' });
  const preservedBalance = await syncWalletBalances(address);
  assert.equal(preservedBalance.balance.confirmed, '765432', 'failed balance sync retains the last successful cached balance');
  assert.equal(preservedBalance.tokens[0].balance, '9876', 'failed token sync retains the last successful token holdings');
  assert(preservedBalance.errors.bsv.includes('HTTP 429'));

  const unconfirmedAddress = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 29)).toAddress().toString();
  const unconfirmedTxid = '8a'.repeat(32);
  let unconfirmedHistoryLookups = 0;
  let unconfirmedDetailLookups = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/balance')) return response({ confirmed: '2500', unconfirmed: '100' });
    if (url.pathname.endsWith('/tokens')) return response({ tokens: [] });
    if (url.pathname.endsWith('/unspent')) return response({ result: [] });
    if (url.pathname.endsWith('/unconfirmed/history')) {
      unconfirmedHistoryLookups++;
      return response({ result: [
        { txid: unconfirmedTxid, delta_satoshis: -2500 },
        { txid: unconfirmedTxid, delta_satoshis: -2500 },
      ] });
    }
    if (url.pathname === `/api/v1/tx/${unconfirmedTxid}`) {
      unconfirmedDetailLookups++;
      return response({
        txid: unconfirmedTxid,
        inputs: [{ address: unconfirmedAddress, value: 2500 }],
        outputs: [{ address: recipient, value: 2300 }],
      });
    }
    throw new Error(`Unexpected unconfirmed activity URL ${url}`);
  };
  const firstUnconfirmedSync = await syncWalletBalances(unconfirmedAddress);
  const firstUnconfirmedSnapshot = await walletData.getWalletActivitySnapshot(unconfirmedAddress);
  let unconfirmedActivity = firstUnconfirmedSnapshot.activities.find(row => row.txid === unconfirmedTxid);
  assert(unconfirmedActivity, 'balance sync stores newly detected unconfirmed transactions in encrypted local activity');
  assert.equal(unconfirmedActivity.type, 'bsv-send');
  assert.equal(unconfirmedActivity.status, 'unconfirmed');
  assert.equal(unconfirmedActivity.blockHeight, 0);
  assert.equal(firstUnconfirmedSnapshot.syncedAt, null, 'a mempool check does not claim that confirmed history backfill has run');
  assert.equal(firstUnconfirmedSnapshot.historyBackfillComplete, false);
  assert.equal(firstUnconfirmedSync.errors.activity, null);
  await syncWalletBalances(unconfirmedAddress);
  unconfirmedActivity = (await walletData.getWalletActivitySnapshot(unconfirmedAddress)).activities
    .find(row => row.txid === unconfirmedTxid);
  assert.equal(unconfirmedActivity.status, 'unconfirmed', 'repeat balance sync preserves the pending activity state');
  assert.equal(unconfirmedHistoryLookups, 2, 'balance sync checks only the lightweight mempool index for new transactions');
  assert.equal(unconfirmedDetailLookups, 1, 'transaction details are fetched once and then read from encrypted local history');

  const localFirstKey = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 20));
  const localFirstAddress = localFirstKey.toAddress().toString();
  const localFirstP2pkh = bsv.Script.buildPublicKeyHashOut(localFirstAddress);
  const localFirstTokenId = `${'cd'.repeat(32)}_1`;
  const localTokenParent = new bsv.Transaction()
    .from({ txid: '66'.repeat(32), vout: 0, satoshis: 10000, script: localFirstP2pkh.toHex() })
    .addOutput(new bsv.Transaction.Output({
      script: tokenWallet._test.transferScript(localFirstAddress, localFirstTokenId, '600'),
      satoshis: 1,
    }));
  const localTokenParentTwo = new bsv.Transaction()
    .from({ txid: '68'.repeat(32), vout: 0, satoshis: 10000, script: localFirstP2pkh.toHex() })
    .addOutput(new bsv.Transaction.Output({
      script: tokenWallet._test.transferScript(localFirstAddress, localFirstTokenId, '300'),
      satoshis: 1,
    }));
  const localCashParent = new bsv.Transaction()
    .from({ txid: '77'.repeat(32), vout: 0, satoshis: 150000, script: localFirstP2pkh.toHex() })
    .addOutput(new bsv.Transaction.Output({ script: localFirstP2pkh, satoshis: 120000 }));
  let syncInputLookups = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const pathname = url.pathname;
    if (pathname.endsWith('/balance')) return response({ confirmed: '120000', unconfirmed: '0' });
    if (pathname.endsWith('/tokens')) return response({
      tokens: [{ token_id: localFirstTokenId, symbol: 'LFT', name: 'Local First Token', decimals: 0, balance: '900' }],
    });
    if (pathname.endsWith('/unspent')) return response([{
      tx_hash: localCashParent.id.toLowerCase(), tx_pos: 0, value: 120000, height: 900500,
    }]);
    if (pathname.includes('/token/') && pathname.endsWith('/history')) {
      syncInputLookups++;
      return response({
        transfers: [{
          txid: localTokenParent.id.toLowerCase(), vout: 0, to_address: localFirstAddress, amount: '600',
        }, {
          txid: localTokenParentTwo.id.toLowerCase(), vout: 0, to_address: localFirstAddress, amount: '300',
        }],
      });
    }
    if (pathname.endsWith('/spend') || pathname.includes('/txo/')) {
      syncInputLookups++;
      return response({ spent: false, script_type: 'p2pkh', address: localFirstAddress });
    }
    if (pathname.endsWith('/hex')) {
      syncInputLookups++;
      const txid = pathname.split('/').at(-2);
      if (txid === localTokenParent.id.toLowerCase()) return response(localTokenParent.toString(), 200, 'text/plain');
      if (txid === localTokenParentTwo.id.toLowerCase()) return response(localTokenParentTwo.toString(), 200, 'text/plain');
      if (txid === localCashParent.id.toLowerCase()) return response(localCashParent.toString(), 200, 'text/plain');
    }
    throw new Error(`Unexpected local-first sync URL ${url}`);
  };
  const localFirstSync = await syncWalletBalances(localFirstAddress);
  assert.equal(localFirstSync.errors.utxos, null, 'sync verifies and caches spendable BSV and BSV-21 inputs');
  assert(syncInputLookups > 0, 'initial sync performs the lookups needed to verify inputs');
  assert.equal((await walletData.getSpendableBsvUtxos(localFirstAddress))[0].txid, localCashParent.id.toLowerCase());
  const syncedTokenInputs = await walletData.getSpendableTokenUtxos(localFirstAddress, localFirstTokenId);
  assert.equal(syncedTokenInputs.length, 2, 'sync persists all verified candidate token inputs within its verification window');
  assert.equal(syncedTokenInputs[0].txid, localTokenParent.id.toLowerCase(), 'the largest token input is first for the current single-input send path');
  let repeatedSyncInputReads = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/balance')) return response({ confirmed: '120000', unconfirmed: '0' });
    if (url.pathname.endsWith('/tokens')) return response({
      tokens: [{ token_id: localFirstTokenId, symbol: 'LFT', name: 'Local First Token', decimals: 0, balance: '900' }],
    });
    if (url.pathname.endsWith('/unspent')) return response([{
      tx_hash: localCashParent.id.toLowerCase(), tx_pos: 0, value: 120000, height: 900500,
    }]);
    repeatedSyncInputReads++;
    throw new Error(`A known verified input was unexpectedly re-fetched during sync: ${url}`);
  };
  await syncWalletBalances(localFirstAddress);
  assert.equal(repeatedSyncInputReads, 0, 'repeat sync refreshes snapshots without re-fetching cached input parents, statuses, or token history');
  let cachedInputReads = 0;
  let localFirstBroadcasts = 0;
  let localFirstBroadcast;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/tx/broadcast') || url.pathname.endsWith('/bsv/main/tx/raw')) {
      localFirstBroadcast = new bsv.Transaction(JSON.parse(init.body).rawtx || JSON.parse(init.body).txhex);
      localFirstBroadcasts++;
      return response({ txid: localFirstBroadcast.id.toLowerCase() });
    }
    cachedInputReads++;
    throw new Error(`A cached send unexpectedly read an input from BananaBlocks: ${url}`);
  };
  await tokenWallet.sendToken(localFirstKey, {
    tokenId: localFirstTokenId, decimals: 0, amount: '100', recipient, symbol: 'LFT',
  });
  assert.equal(localFirstBroadcasts, 1, 'a synced token send still broadcasts through BananaBlocks');
  assert.equal(cachedInputReads, 0, 'a synced token send uses only locally cached token and cash inputs');
  assert.equal(localFirstBroadcast.inputs[0].prevTxId.toString('hex'), localTokenParent.id.toLowerCase());
  assert.equal(localFirstBroadcast.inputs[1].prevTxId.toString('hex'), localCashParent.id.toLowerCase());

  const recoveryKey = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 18));
  const recoveryAddress = recoveryKey.toAddress().toString();
  const recoveryP2pkh = bsv.Script.buildPublicKeyHashOut(recoveryAddress);
  const recoveryFundingTx = new bsv.Transaction()
    .from({ txid: '55'.repeat(32), vout: 0, satoshis: 250000, script: recoveryP2pkh.toHex() })
    .to(recoveryAddress, 200000);
  await walletData.cacheVerifiedBsvUtxos(recoveryAddress, [{
    txid: recoveryFundingTx.id.toLowerCase(),
    vout: 0,
    satoshis: recoveryFundingTx.outputs[0].satoshis,
    scriptHex: recoveryFundingTx.outputs[0].script.toHex(),
    rawTxHex: recoveryFundingTx.toString(),
    spvVerified: true,
    blockHeight: 900000,
    blockHash: '12'.repeat(32),
  }]);
  const rejectedTx = new bsv.Transaction()
    .from({
      txid: recoveryFundingTx.id.toLowerCase(),
      vout: 0,
      satoshis: recoveryFundingTx.outputs[0].satoshis,
      script: recoveryP2pkh.toHex(),
    })
    .to(recipient, 10000)
    .change(recoveryAddress)
    .feePerKb(1000)
    .sign(recoveryKey);
  await walletData.prepareWalletTransaction(recoveryAddress, {
    txid: rejectedTx.id.toLowerCase(),
    rawHex: rejectedTx.toString(),
    type: 'token-mint',
    details: { title: 'Rejected BSV-21 mint' },
  });
  await walletData.setWalletTransactionStatus(
    recoveryAddress,
    rejectedTx.id,
    'broadcast-uncertain',
    'BananaBlocks rejected the transaction: ARC txStatus REJECTED | ARC 464: Invalid outputs',
  );
  assert.equal((await walletData.getSpendableBsvUtxos(recoveryAddress)).length, 0,
    'an uncertain transaction reserves its input until a definitive rejection is reconciled');
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/balance')) return response({ confirmed: '0', unconfirmed: '0' });
    if (url.pathname.endsWith('/tokens')) return response({ tokens: [] });
    if (url.pathname.endsWith('/unspent')) return response([{
      tx_hash: recoveryFundingTx.id.toLowerCase(), tx_pos: 0,
      value: recoveryFundingTx.outputs[0].satoshis, height: 900000,
    }]);
    throw new Error(`Unexpected rejection-recovery sync URL ${url}`);
  };
  const recoveredRejectedTransaction = await syncWalletBalances(recoveryAddress);
  const recoveredRejectedData = await walletData.getWalletData(recoveryAddress);
  assert.equal(recoveredRejectedData.transactions.find(row => row.txid === rejectedTx.id.toLowerCase()).status, 'rejected',
    'a definitive ARC rejection saved locally is reconciled before the balance snapshot is calculated');
  assert.equal((await walletData.getSpendableBsvUtxos(recoveryAddress))[0].txid, recoveryFundingTx.id.toLowerCase(),
    'the original verified input is released when the rejection is reconciled');
  assert.equal(recoveredRejectedTransaction.balance.spendableBsvSats, '200000',
    'the refreshed local snapshot includes the released verified input');

  const proofAddress = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 27)).toAddress().toString();
  const proofScript = bsv.Script.buildPublicKeyHashOut(proofAddress);
  const proofTx = new bsv.Transaction()
    .from({ txid: '56'.repeat(32), vout: 0, satoshis: 10000, script: proofScript.toHex() })
    .to(proofAddress, 9000);
  const proofTxid = proofTx.id.toLowerCase();
  await walletData.cacheVerifiedBsvUtxos(proofAddress, [{
    txid: proofTxid, vout: 0, satoshis: proofTx.outputs[0].satoshis,
    scriptHex: proofTx.outputs[0].script.toHex(), rawTxHex: proofTx.toString(),
  }]);
  assert.equal((await walletData.getSpendableBsvUtxos(proofAddress)).length, 0,
    'confirmed indexer outputs are not spendable until a local SPV proof is recorded');
  const proofRecord = {
    txid: proofTxid, blockHeight: 900001, blockHash: 'ab'.repeat(32),
    merkleRoot: 'cd'.repeat(32), beefHex: '0102',
    verified: true, validationVersion: 1,
  };
  await walletData.saveWalletTransactionProof(proofAddress, proofRecord);
  await walletData.cacheVerifiedBsvUtxos(proofAddress, [{
    txid: proofTxid, vout: 0, satoshis: proofTx.outputs[0].satoshis,
    scriptHex: proofTx.outputs[0].script.toHex(), rawTxHex: proofTx.toString(),
    spvVerified: true, blockHeight: proofRecord.blockHeight, blockHash: proofRecord.blockHash,
  }]);
  assert.equal((await walletData.getSpendableBsvUtxos(proofAddress))[0].txid, proofTxid,
    'a locally persisted verified BEEF proof unlocks the confirmed output');
  await walletData.saveWalletHeaderChain(proofAddress, {
    validationVersion: 3, tipHeight: 900001, tipHash: 'ef'.repeat(32),
    remoteTipHeight: 900001, staleRemoteTip: false, chainWork: '123456',
    digest: 'ab'.repeat(32),
  });
  assert.equal((await walletData.getWalletActivitySnapshot(proofAddress)).headerChain.tipHeight, 900001,
    'validated header-chain metadata is stored in the encrypted wallet record');
  const proofAddressHash = (await import('node:crypto')).createHash('sha256').update(proofAddress).digest('hex');
  const encryptedProofFile = await readFile(path.join(profile, 'wallet-data', `${proofAddressHash}.enc`), 'utf8');
  assert(!encryptedProofFile.includes(proofTxid) && !encryptedProofFile.includes('0102'),
    'BEEF proofs and transaction identifiers remain encrypted at rest');
  await walletData.invalidateWalletProofs(proofAddress, [proofTxid]);
  assert.equal((await walletData.getSpendableBsvUtxos(proofAddress)).length, 0,
    'a proof invalidated by a chain reorganization removes the confirmed output from spendability');
  const spentAddress = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 28)).toAddress().toString();
  const spentScript = bsv.Script.buildPublicKeyHashOut(spentAddress);
  const spentTx = new bsv.Transaction()
    .from({ txid: '57'.repeat(32), vout: 0, satoshis: 10000, script: spentScript.toHex() })
    .to(spentAddress, 9000);
  await walletData.cacheVerifiedBsvUtxos(spentAddress, [{
    txid: spentTx.id.toLowerCase(), vout: 0, satoshis: 9000,
    scriptHex: spentTx.outputs[0].script.toHex(), rawTxHex: spentTx.toString(),
    spvVerified: true, blockHeight: 900001, blockHash: 'ef'.repeat(32),
  }]);
  await walletData.cacheObservedBsvUtxos(spentAddress, [], { complete: false });
  assert.equal((await walletData.getSpendableBsvUtxos(spentAddress)).length, 1,
    'an incomplete UTXO snapshot cannot mark an absent cached output spent');
  await walletData.cacheObservedBsvUtxos(spentAddress, [], { complete: true });
  assert.equal((await walletData.getSpendableBsvUtxos(spentAddress)).length, 0,
    'a complete UTXO snapshot marks absent confirmed cash outputs spent');

  const hash = (await import('node:crypto')).createHash('sha256').update(address).digest('hex');
  const encryptedFile = await readFile(path.join(profile, 'wallet-data', `${hash}.enc`), 'utf8');
  assert(!encryptedFile.includes(tokenId), 'wallet data is encrypted at rest');
  assert(!encryptedFile.includes('"symbol":"TST"'), 'token metadata is encrypted at rest');
  const anotherAddress = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 15)).toAddress().toString();
  assert.equal((await walletData.getWalletActivitySnapshot(anotherAddress)).activities.length, 0, 'wallet data is isolated by address');
  console.log('PASS: encrypted wallet-local imports, sync-time verified inputs, cached balances, paginated history, rate-limit recovery, and 0-conf BSV/token tracking');
} finally {
  globalThis.fetch = undefined;
  await rm(profile, { recursive: true, force: true });
}
