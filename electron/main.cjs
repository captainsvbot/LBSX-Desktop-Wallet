const { app, BrowserWindow, clipboard, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getVaultStatus, importVault, unlockVault, lockVault, getWalletSummary, getWalletPrivateKey } = require('./vault.cjs');
const { syncWalletBalances, syncWalletActivity, checkPendingTransactionStatuses } = require('./chain.cjs');
const { sendBsv, sendPeerChatMessage, sendToken, mintBsv21Token, createTokenLock, claimTokenLock, getTokenLocks, migrateLegacyTokenLocks, getTokenIconData } = require('./token-wallet.cjs');
const { syncPeerChat, getPeerChatSnapshot } = require('./peer-chat.cjs');
const { syncTradingDiscovery, getTradingDiscoveryCache } = require('./trading.cjs');
const { getTokenOrderBook, getTokenMarketInfo, getTokenSellQuote, buildAndBroadcastList, buildAndBroadcastBuy, buildAndBroadcastCancel } = require('./market.cjs');
const { getBananaBlocksApiKeyStatus, saveBananaBlocksApiKey, removeBananaBlocksApiKey } = require('./bananablocks.cjs');
const { getWalletActivitySnapshot, saveImportedToken } = require('./wallet-data.cjs');
const { deleteConnectedWallet } = require('./wallet-deletion.cjs');
const { onProgress: onSpvProgress } = require('./spv.cjs');
const { buildBananaBlocksUrl } = require('./explorer.cjs');

// Isolated data directories are only enabled for automated smoke runs.
if (process.env.LBSX_TEST_USER_DATA_DIR && (!app.isPackaged || process.env.LBSX_TEST_PACKAGED === '1')) {
  app.setPath('userData', path.resolve(process.env.LBSX_TEST_USER_DATA_DIR));
}

let mainWindow;

onSpvProgress(progress => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('wallet:spv-progress', progress);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    icon: path.join(__dirname, '..', 'assets', 'lbsx-wallet.ico'),
    backgroundColor: '#0b1011',
    title: 'LBSX Desktop Wallet',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL(`http://127.0.0.1:${process.env.LBSX_E2E_PORT || 5173}`);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedDevUrl = !app.isPackaged && url.startsWith('http://127.0.0.1:5173/');
    const allowedPackagedUrl = app.isPackaged && url.startsWith('file://');
    if (!allowedDevUrl && !allowedPackagedUrl) event.preventDefault();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('vault:status', () => getVaultStatus());
ipcMain.handle('app:copy-text', (event, text) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Clipboard access is unavailable.');
  if (typeof text !== 'string' || !text.length || text.length > 2048) throw new Error('The value cannot be copied.');
  clipboard.writeText(text);
  return true;
});
ipcMain.handle('app:open-explorer', async (event, reference = {}) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Explorer links are unavailable.');
  await shell.openExternal(buildBananaBlocksUrl(reference));
  return true;
});
ipcMain.handle('vault:import', async (_event, payload) => importVault(payload));
ipcMain.handle('vault:unlock', async (_event, payload) => unlockVault(payload));
ipcMain.handle('vault:lock', () => { lockVault(); return { locked: true }; });
ipcMain.handle('vault:delete', () => deleteConnectedWallet(app.getPath('userData')));
ipcMain.handle('wallet:summary', () => getWalletSummary());
ipcMain.handle('wallet:get-activity', async () => {
  const address = getWalletSummary().address;
  await migrateLegacyTokenLocks(address);
  return getWalletActivitySnapshot(address);
});
ipcMain.handle('wallet:sync-activity', () => syncWalletActivity(getWalletSummary().address));
ipcMain.handle('wallet:check-pending-statuses', async () => {
  const address = getWalletSummary().address;
  if (app.isPackaged && process.env.LBSX_TEST_PACKAGED === '1') {
    return { ...(await getWalletActivitySnapshot(address)), checkedTransactions: 0 };
  }
  return checkPendingTransactionStatuses(address);
});
ipcMain.handle('wallet:get-imported-tokens', async () => (await getWalletActivitySnapshot(getWalletSummary().address)).importedTokens);
ipcMain.handle('wallet:save-imported-token', (_event, token) => saveImportedToken(getWalletSummary().address, token));
ipcMain.handle('wallet:sync-balances', async () => {
  const tokenFixture = (!app.isPackaged && process.env.LBSX_TEST_TOKEN_FIXTURE === '1')
    || (app.isPackaged && process.env.LBSX_TEST_PACKAGED === '1');
  if (tokenFixture) {
    if (process.env.LBSX_TEST_SPV_ERROR === '1') await new Promise(resolve => setTimeout(resolve, 750));
    return {
      address: getWalletSummary().address,
      balance: { confirmed: '500000', unconfirmed: '0' },
      tokens: [{
        tokenId: `${'11'.repeat(32)}_1`, symbol: 'TEST', name: 'Test Token', decimals: 2, balance: '12345',
        ...(app.isPackaged ? { icon: `${'11'.repeat(32)}_0` } : {}),
      }],
      errors: process.env.LBSX_TEST_SPV_ERROR === '1'
        ? { bsv: null, tokens: null, utxos: 'The local SPV header-chain record is invalid.' }
        : { bsv: null, tokens: null },
      syncedAt: new Date().toISOString(),
      source: 'E2E fixture',
    };
  }
  return syncWalletBalances(getWalletSummary().address);
});
ipcMain.handle('token:get-icon', async (_event, token) => {
  if (app.isPackaged && process.env.LBSX_TEST_PACKAGED === '1') {
    const logo = await fs.readFile(path.join(__dirname, '..', 'assets', 'lbsx-wallet-logo.jpeg'));
    return `data:image/jpeg;base64,${logo.toString('base64')}`;
  }
  return getTokenIconData(getWalletSummary().address, token);
});
ipcMain.handle('wallet:send-bsv', (_event, payload) => !app.isPackaged && process.env.LBSX_TEST_TOKEN_FIXTURE === '1'
  ? { txid: '99'.repeat(32), recipient: payload.recipient, amountSats: Math.round(Number(payload.amount) * 100000000), feeSats: 250 }
  : sendBsv(getWalletPrivateKey(), payload));
ipcMain.handle('wallet:mint-bsv21', (_event, payload) => mintBsv21Token(getWalletPrivateKey(), payload));
const tradingFixture = () => ({
  address: '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB', source: 'E2E fixture', syncedAt: new Date().toISOString(),
  scannedTransactions: 1, lookupFailures: 0,
  discoveredOrders: [{ outpoint: `${'33'.repeat(32)}.0`, txid: '33'.repeat(32), tokenId: `${'11'.repeat(32)}_1`, amountBase: '123', priceSats: 2500, sellerAddress: '1TestPeerAddress', sourceOutpoint: `${'22'.repeat(32)}.0` }],
  markets: [{ tokenId: `${'11'.repeat(32)}_1`, symbol: 'TEST', confirmedSettlements: 1, latestBlockHeight: 900000, peerAddresses: ['1TestPeerAddress'] }],
  transactions: [{ txid: '22'.repeat(32), blockHeight: 900000, blockTime: 1760000000, confirmed: true, anchorOutputSats: 1000, tokenIds: [`${'11'.repeat(32)}_1`], tokenOutputs: [{ vout: 0, tokenId: `${'11'.repeat(32)}_1`, amount: '123', symbol: 'TEST', op: 'transfer', valid: true }], peerAddresses: ['1TestPeerAddress'], classification: 'fee-linked-settlement-candidate', evidence: 'E2E fixture' }],
});
ipcMain.handle('trading:sync-discovery', () => !app.isPackaged && process.env.LBSX_TEST_TOKEN_FIXTURE === '1' ? tradingFixture() : syncTradingDiscovery(getWalletSummary().address));
ipcMain.handle('trading:get-discovery-cache', () => !app.isPackaged && process.env.LBSX_TEST_TOKEN_FIXTURE === '1' ? tradingFixture() : getTradingDiscoveryCache(getWalletSummary().address));
ipcMain.handle('trading:get-orderbook', (_event, tokenId) => {
  if (!app.isPackaged && process.env.LBSX_TEST_TOKEN_FIXTURE === '1') {
    const asks = [
      { outpoint: `${'44'.repeat(32)}.0`, tokenId, amountBase: '1200', symbol: 'TEST', decimals: 2, priceSats: 2500, sellerAddress: '1TestPeerAddress', score: 2 },
      { outpoint: `${'88'.repeat(32)}.0`, tokenId, amountBase: '800', symbol: 'TEST', decimals: 2, priceSats: 5000, sellerAddress: getWalletSummary().address, score: 1 },
    ];
    return { tokenId, syncedAt: new Date().toISOString(), asks, myOrders: asks.filter(row => row.sellerAddress === getWalletSummary().address) };
  }
  return getTokenOrderBook(tokenId, getWalletSummary().address);
});
ipcMain.handle('trading:get-token-info', (_event, tokenId) => getTokenMarketInfo(tokenId));
ipcMain.handle('trading:get-sell-quote', (_event, tokenId) => !app.isPackaged && process.env.LBSX_TEST_TOKEN_FIXTURE === '1'
  ? { tokenId, outpoint: `${'11'.repeat(32)}.0`, amountBase: '1200', carrierSats: 1 }
  : getTokenSellQuote(getWalletPrivateKey(), tokenId));
ipcMain.handle('trading:list-token', (_event, payload) => !app.isPackaged && process.env.LBSX_TEST_TOKEN_FIXTURE === '1'
  ? { txid: '55'.repeat(32), outpoint: `${'55'.repeat(32)}.0`, tokenId: payload.tokenId, amountBase: String(payload.amountBase), priceSats: Number(payload.priceSats) }
  : buildAndBroadcastList(getWalletPrivateKey(), payload));
ipcMain.handle('trading:buy-token', (_event, payload) => !app.isPackaged && process.env.LBSX_TEST_TOKEN_FIXTURE === '1'
  ? { txid: '66'.repeat(32), tokenId: payload.tokenId, amountBase: '1200', priceSats: 2500 }
  : buildAndBroadcastBuy(getWalletPrivateKey(), payload));
ipcMain.handle('trading:cancel-token', (_event, payload) => !app.isPackaged && process.env.LBSX_TEST_TOKEN_FIXTURE === '1'
  ? { txid: '77'.repeat(32), tokenId: payload.tokenId, outpoint: payload.outpoint, amountBase: '1200' }
  : buildAndBroadcastCancel(getWalletPrivateKey(), payload));
ipcMain.handle('token:send', (_event, payload) => {
  if (app.isPackaged && process.env.LBSX_TEST_PACKAGED === '1' && process.env.LBSX_TEST_SPV_ERROR === '1') {
    throw new Error('Could not validate the local BSV header chain before spending this token: The local SPV header-chain record is invalid.');
  }
  return sendToken(getWalletPrivateKey(), payload);
});
ipcMain.handle('token:locks', (_event, tokenId) => getTokenLocks(getWalletSummary().address, tokenId));
ipcMain.handle('token:lock', (_event, payload) => createTokenLock(getWalletPrivateKey(), payload));
ipcMain.handle('token:claim', (_event, lockId) => claimTokenLock(getWalletPrivateKey(), lockId));
const peerChatFixture = () => {
  const now = Date.now();
  return {
    address: '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB',
    source: 'E2E fixture',
    syncedAt: new Date(now).toISOString(),
    messages: [
      {
        txid: 'aa'.repeat(32),
        senderAddress: getWalletSummary().address,
        content: 'This public LBSX peer chat uses the encrypted local test fixture.',
        isEncrypted: true,
        timestamp: new Date(now - 9 * 60_000).toISOString(),
        status: 'confirmed',
        blockHeight: 971800,
      },
      {
        txid: 'cc'.repeat(32),
        senderAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
        content: 'A second wallet is available to exercise Peer Chat members and tips.',
        isEncrypted: true,
        timestamp: new Date(now - 8 * 60_000).toISOString(),
        status: 'confirmed',
        blockHeight: 971801,
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        txid: (index + 1).toString(16).padStart(2, '0').repeat(32),
        senderAddress: getWalletSummary().address,
        content: `Locally saved pending Peer Chat test transaction ${index + 1}.`,
        isEncrypted: true,
        timestamp: new Date(now - (6 - index) * 60_000).toISOString(),
        status: 'pending',
        blockHeight: 0,
      })),
    ],
    scannedTransactions: 1,
    lookupFailures: 0,
    errors: [],
  };
};
ipcMain.handle('peer-chat:get', () => app.isPackaged && process.env.LBSX_TEST_PACKAGED === '1'
  ? peerChatFixture()
  : getPeerChatSnapshot(getWalletSummary().address));
ipcMain.handle('peer-chat:sync', () => app.isPackaged && process.env.LBSX_TEST_PACKAGED === '1'
  ? peerChatFixture()
  : syncPeerChat(getWalletSummary().address));
ipcMain.handle('peer-chat:send', (_event, payload) => app.isPackaged && process.env.LBSX_TEST_PACKAGED === '1'
  ? { txid: 'bb'.repeat(32), senderAddress: getWalletSummary().address, content: String(payload?.message || '').trim(), timestamp: new Date().toISOString(), status: 'pending', feeSats: 250 }
  : sendPeerChatMessage(getWalletPrivateKey(), payload));
ipcMain.handle('settings:bananablocks-key-status', () => getBananaBlocksApiKeyStatus());
ipcMain.handle('settings:save-bananablocks-key', (_event, payload) => saveBananaBlocksApiKey(payload));
ipcMain.handle('settings:remove-bananablocks-key', () => removeBananaBlocksApiKey());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', lockVault);
