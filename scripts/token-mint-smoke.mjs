import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const spvTestMock = require('./spv-test-mock.cjs');
const { ADMIN_DISCOVERY_ADDRESS } = require('../electron/constants.cjs');
const profile = await mkdtemp(path.join(os.tmpdir(), 'lbsx-token-mint-'));
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => profile } };
  if (request === './vault.cjs') return { getWalletDataEncryptionKey: () => Buffer.alloc(32, 0x6b) };
  if (request === './spv.cjs') return spvTestMock;
  return originalLoad.call(this, request, parent, isMain);
};
const walletData = require('../electron/wallet-data.cjs');
const { mintBsv21Token, getTokenIconData, _test, _market } = require('../electron/token-wallet.cjs');
const { reconcileDefinitivelyRejectedTransactions } = require('../electron/transaction-tracker.cjs');
const { syncWalletBalances, _test: chainTest } = require('../electron/chain.cjs');
chainTest.setApiMinIntervalMs(0);
Module._load = originalLoad;

const key = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 23));
const address = key.toAddress().toString();
const p2pkh = bsv.Script.buildPublicKeyHashOut(address);
const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const imageDataUrl = `data:image/png;base64,${imageBytes.toString('base64')}`;
const extendedImageBytes = Buffer.concat([imageBytes, Buffer.alloc(70000, 0xa5)]);
const broadcastTransactions = [];

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

try {
  const fundingTx = new bsv.Transaction()
    .from({ txid: '77'.repeat(32), vout: 0, satoshis: 2000000, script: p2pkh.toHex() })
    .to(address, 1500000);
  await walletData.cacheVerifiedBsvUtxos(address, [{
    txid: fundingTx.id.toLowerCase(),
    vout: 0,
    satoshis: fundingTx.outputs[0].satoshis,
    scriptHex: fundingTx.outputs[0].script.toHex(),
    rawTxHex: fundingTx.toString(),
    spvVerified: true,
    blockHeight: 900000,
    blockHash: '12'.repeat(32),
  }]);

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/tx/broadcast')) {
      const body = JSON.parse(init.body);
      const tx = new bsv.Transaction(body.rawtx);
      broadcastTransactions.push(tx);
      return response({ txid: tx.id.toLowerCase() });
    }
    throw new Error(`Unexpected token mint URL ${url}`);
  };

  const result = await mintBsv21Token(key, {
    symbol: 'LBSXWALLET',
    supply: '100000',
    decimals: 8,
    imageDataUrl,
    imageName: 'lbsxwallet-icon.png',
  });
  assert.equal(broadcastTransactions.length, 1, 'the image and BSV-21 deployment are broadcast atomically');

  const [mintTx] = broadcastTransactions;
  const imageChunks = mintTx.outputs[0].script.chunks.filter(chunk => chunk.buf);
  assert.equal(imageChunks[0].buf.toString('utf8'), 'ord', 'the canonical Ordinals envelope prefix is used');
  assert.equal(imageChunks[1].buf.toString('utf8'), 'image/png');
  assert.equal(imageChunks[2].buf.toString('hex'), imageBytes.toString('hex'), 'the original image bytes are embedded on-chain');
  assert.equal(mintTx.outputs[0].satoshis, 1, 'the image inscription is carried by a 1-satoshi output');
  assert(mintTx.outputs[0].script.toHex().endsWith(p2pkh.toHex()), 'the image inscription output is locked to the wallet');
  assert.equal(_test.readOrdinalImageData(mintTx.outputs[0].script.toHex()), imageDataUrl,
    'the on-chain Ordinals output can be decoded back to its original image data URL');
  const extendedImageScript = _test.ordinalImageScript(extendedImageBytes, 'image/png', address);
  const extendedImageChunks = extendedImageScript.chunks.filter(chunk => chunk.buf);
  assert.deepEqual(extendedImageChunks[2].buf, extendedImageBytes, 'images larger than 65,535 bytes use a valid Ordinals data push');

  const inscription = _test.readInscription(mintTx.outputs[1].script.toHex());
  assert.equal(inscription.op, 'deploy+mint');
  assert.equal(inscription.sym, 'LBSXWALLET');
  assert.equal(inscription.amt, '10000000000000');
  assert.equal(inscription.dec, '8');
  assert.equal(inscription.icon, '_0', 'the deployment references the image at vout 0 in the same transaction');
  assert.equal(mintTx.outputs[1].satoshis, 1);
  assert.equal(mintTx.outputs[2].satoshis, 1);
  assert.equal(mintTx.outputs[2].script.toHex(), bsv.Script.buildPublicKeyHashOut(ADMIN_DISCOVERY_ADDRESS).toHex(), 'a 1-satoshi admin index output is present');
  assert.equal(result.txid, mintTx.id.toLowerCase());
  assert.equal(result.imageTxid, result.txid);
  assert.equal(result.tokenId, `${mintTx.id.toLowerCase()}_1`);
  assert.equal(result.symbol, 'LBSXWALLET');
  assert.equal(result.supply, '100000');
  assert.equal(result.amountBase, '10000000000000');
  assert.equal(result.decimals, 8);
  assert.equal(result.icon, `${mintTx.id.toLowerCase()}_0`);

  const localToken = (await walletData.getSpendableTokenUtxos(address, result.tokenId))[0];
  assert(localToken, 'the minted token output is tracked as locally spendable');
  assert.equal(localToken.amount, '10000000000000');
  assert.equal(localToken.state, 'pending');
  const localMintInput = await _market.fetchSpendableTokenOutput(address, result.tokenId);
  assert.equal(localMintInput.txid, mintTx.id.toLowerCase(), 'locally cached deploy+mint outputs derive their token id from the outpoint');
  assert.equal(localMintInput.vout, 1);
  assert.equal(await getTokenIconData(address, { tokenId: result.tokenId, icon: '_0' }), imageDataUrl,
    'minted-token images are extracted from the locally tracked parent transaction without an API lookup');

  const remoteIconTx = new bsv.Transaction().addOutput(new bsv.Transaction.Output({
    script: _test.ordinalImageScript(imageBytes, 'image/png', address),
    satoshis: 1,
  }));
  let remoteIconReads = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.pathname, `/api/v1/bsv/main/tx/${remoteIconTx.id.toLowerCase()}/hex`);
    remoteIconReads++;
    return new Response(remoteIconTx.toString(), { status: 200, headers: { 'Content-Type': 'text/plain' } });
  };
  assert.equal(await getTokenIconData(address, {
    tokenId: `${remoteIconTx.id.toLowerCase()}_1`,
    icon: '_0',
  }), imageDataUrl, 'an uncached token image can be recovered from BananaBlocks transaction hex');
  assert.equal(remoteIconReads, 1);

  const indexedKey = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 25));
  const indexedAddress = indexedKey.toAddress().toString();
  const indexedP2pkh = bsv.Script.buildPublicKeyHashOut(indexedAddress);
  const indexedMintTx = new bsv.Transaction()
    .from({ txid: '99'.repeat(32), vout: 0, satoshis: 10000, script: indexedP2pkh.toHex() })
    .addOutput(new bsv.Transaction.Output({
      script: _test.ordinalImageScript(imageBytes, 'image/png', indexedAddress),
      satoshis: 1,
    }))
    .addOutput(new bsv.Transaction.Output({
      script: _test.bsv21DeployScript(indexedAddress, 'LBSXWALLET', 10000000000000n, 8, '_0'),
      satoshis: 1,
    }));
  const indexedTokenId = `${indexedMintTx.id.toLowerCase()}_1`;
  let indexedParentReads = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const pathname = url.pathname;
    if (pathname.includes('/token/') && pathname.endsWith('/history')) {
      return response({
        transfers: [{
          txid: indexedMintTx.id.toLowerCase(),
          vout: 1,
          to_address: indexedAddress,
          amount: '10000000000000',
          op: 'deploy+mint',
          token_id: indexedTokenId,
        }],
      });
    }
    if (pathname.endsWith('/spend')) return response({ spent: false });
    if (pathname.includes('/txo/')) return response({
      value: 1,
      index: 1,
      script_type: 'p2pkh',
      address: indexedAddress,
      spent: false,
    });
    if (pathname.endsWith('/hex')) {
      indexedParentReads++;
      return new Response(indexedMintTx.toString(), { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    throw new Error(`Unexpected indexed-mint lookup URL ${url}`);
  };
  const indexedMintInput = await _market.fetchSpendableTokenOutput(indexedAddress, indexedTokenId);
  assert.equal(indexedMintInput.txid, indexedMintTx.id.toLowerCase());
  assert.equal(indexedMintInput.vout, 1);
  assert.equal(indexedMintInput.amount, 10000000000000n);
  assert.equal(indexedParentReads, 1, 'an indexed deploy+mint UTXO is verified from its parent and cached');
  assert.equal((await walletData.getSpendableTokenUtxos(indexedAddress, indexedTokenId)).length, 1);

  const snapshot = await walletData.getWalletActivitySnapshot(address);
  assert.equal(snapshot.chainSnapshot.tokens[0].tokenId, result.tokenId);
  assert.equal(snapshot.chainSnapshot.tokens[0].balance, '10000000000000');
  assert.equal(snapshot.chainSnapshot.tokens[0].icon, `${mintTx.id.toLowerCase()}_0`);
  assert(!snapshot.activities.some(row => row.type === 'token-image'), 'the atomic mint does not create a separate image transaction record');
  assert(snapshot.activities.some(row => row.type === 'token-mint'));
  const mintActivity = snapshot.activities.find(row => row.type === 'token-mint');
  assert(mintActivity, 'the combined image and deployment activity is saved locally');
  assert.equal(mintActivity.details.tokenId, result.tokenId);
  assert.equal(mintActivity.details.icon, result.icon);
  assert.equal(mintActivity.details.walletInputSats, '1500000');
  assert.equal(BigInt(mintActivity.details.walletInputSats) - BigInt(mintActivity.details.changeSats), BigInt(mintActivity.details.walletNetSpentSats));
  const mintOutputSats = mintTx.outputs.reduce((sum, output) => sum + BigInt(output.satoshis), 0n);
  const mintFee = BigInt(mintActivity.details.feeSats);
  assert(mintFee > 0n, 'the transaction fee is positive');
  assert.equal(BigInt(mintActivity.details.walletInputSats) - mintOutputSats, mintFee, 'the fee matches input sats minus all serialized outputs');
  assert.equal(await walletData.getTrackedTransactionHex(address, mintTx.id), mintTx.toString(), 'the raw transaction is saved locally for chaining and history');

  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/balance')) return response({ confirmed: '900000', unconfirmed: '0' });
    if (url.pathname.endsWith('/tokens')) return response({
      tokens: [{
        token_id: result.tokenId, symbol: 'LBSXWALLET', name: 'LBSXWALLET', decimals: 8,
        balance: result.amountBase, icon: '_0',
      }],
    });
    if (url.pathname.endsWith('/unspent')) return response({ result: [] });
    throw new Error(`Unexpected post-mint sync URL ${url}`);
  };
  const postMintSync = await syncWalletBalances(address);
  assert(postMintSync.tokens.some(token => token.tokenId === result.tokenId), 'a successful chain sync retains the pending locally minted token until the indexer reports it');
  assert.equal(postMintSync.tokens.find(token => token.tokenId === result.tokenId).icon, result.icon,
    'BananaBlocks _0 metadata is normalized to the full cached image outpoint');

  await assert.rejects(() => mintBsv21Token(key, {
    symbol: 'TOOBIG',
    supply: '184467440737.09551616',
    decimals: 8,
    imageDataUrl,
    imageName: 'too-big.png',
  }), /exceeds the supported BSV-21 amount range/);
  assert.equal(broadcastTransactions.length, 1, 'amounts above the BSV-21 uint64 limit are rejected before any additional broadcast');

  await assert.rejects(() => mintBsv21Token(key, {
    symbol: 'BAD',
    supply: '1',
    decimals: 0,
    imageDataUrl: `data:image/png;base64,${Buffer.from('not a png').toString('base64')}`,
    imageName: 'bad.png',
  }), /does not match its image type/);
  assert.equal(broadcastTransactions.length, 1, 'invalid image payloads are rejected before any additional broadcast');

  const rejectedKey = bsv.PrivateKey.fromBuffer(Buffer.alloc(32, 24));
  const rejectedAddress = rejectedKey.toAddress().toString();
  const rejectedP2pkh = bsv.Script.buildPublicKeyHashOut(rejectedAddress);
  const rejectedFundingTx = new bsv.Transaction()
    .from({ txid: '88'.repeat(32), vout: 0, satoshis: 2000000, script: rejectedP2pkh.toHex() })
    .to(rejectedAddress, 1500000);
  await walletData.cacheVerifiedBsvUtxos(rejectedAddress, [{
    txid: rejectedFundingTx.id.toLowerCase(),
    vout: 0,
    satoshis: rejectedFundingTx.outputs[0].satoshis,
    scriptHex: rejectedFundingTx.outputs[0].script.toHex(),
    rawTxHex: rejectedFundingTx.toString(),
    spvVerified: true,
    blockHeight: 900000,
    blockHash: '12'.repeat(32),
  }]);
  let rejectionBroadcasts = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/tx/broadcast')) {
      rejectionBroadcasts++;
      const tx = new bsv.Transaction(JSON.parse(init.body).rawtx);
      return response({
        error: 'ARC txStatus REJECTED',
        extraInfo: 'ARC 464: Invalid outputs - Transaction is invalid because the outputs are non-existent or invalid',
      }, 400);
    }
    throw new Error(`Unexpected rejection test URL ${url}`);
  };
  await assert.rejects(() => mintBsv21Token(rejectedKey, {
    symbol: 'DUST',
    supply: '1',
    decimals: 0,
    imageDataUrl,
    imageName: 'dust.png',
  }), /ARC txStatus REJECTED \| ARC 464: Invalid outputs.*marked rejected.*inputs were released/);
  assert.equal(rejectionBroadcasts, 1, 'a definitive BananaBlocks rejection is not retried through another broadcast route');
  const rejectedData = await walletData.getWalletData(rejectedAddress);
  const rejectedMint = rejectedData.transactions.find(row => row.type === 'token-mint');
  assert.equal(rejectedMint.status, 'rejected');
  assert.equal((await walletData.getSpendableBsvUtxos(rejectedAddress))[0].state, 'confirmed', 'inputs reserved for a rejected mint are released');

  const legacyRejectedTx = new bsv.Transaction()
    .from({ txid: rejectedFundingTx.id.toLowerCase(), vout: 0, satoshis: 1500000, script: rejectedP2pkh.toHex() })
    .to(rejectedAddress, 1000)
    .change(rejectedAddress)
    .feePerKb(1000)
    .sign(rejectedKey);
  await walletData.prepareWalletTransaction(rejectedAddress, {
    txid: legacyRejectedTx.id.toLowerCase(),
    rawHex: legacyRejectedTx.toString(),
    type: 'bsv-send',
    details: { title: 'Test transaction' },
  });
  await walletData.setWalletTransactionStatus(rejectedAddress, legacyRejectedTx.id, 'broadcast-uncertain',
    'BananaBlocks did not confirm broadcast acceptance. HTTP 400: {"error":"ARC 464: Invalid outputs - Transaction is invalid because the outputs are non-existent or invalid"}');
  const reconciled = await reconcileDefinitivelyRejectedTransactions(rejectedAddress);
  assert(reconciled.includes(legacyRejectedTx.id.toLowerCase()), 'Activity/input reconciliation releases prior uncertain records with explicit rejections');
  assert.equal((await walletData.getSpendableBsvUtxos(rejectedAddress))[0].state, 'confirmed');
  console.log('PASS: atomic Ordinals image/BSV-21 mint, local token tracking, and BananaBlocks validation-rejection recovery');
} finally {
  globalThis.fetch = undefined;
  await rm(profile, { recursive: true, force: true });
}
