const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs/promises');
const {
  scanAttachment,
  getVirusTotalApiKeyStatus,
  saveVirusTotalApiKey,
  removeVirusTotalApiKey,
} = require('./virustotal.cjs');
const {
  safeAttachmentName,
  attachmentExtension,
  attachmentDefaultName,
  attachmentFinalPath,
} = require('./attachment-file-name.cjs');
const path = require('node:path');
const { getVaultStatus, importVault, unlockVault, lockVault, getWalletSummary, getWalletPrivateKey, getWalletPublicKey } = require('./vault.cjs');
const { syncWalletBalances, syncWalletActivity, checkPendingTransactionStatuses } = require('./chain.cjs');
const { sendBsv, estimateBsvSendFee, sendPeerChatMessage, sendToken, mintBsv21Token, createTokenLock, claimTokenLock, getTokenLocks, migrateLegacyTokenLocks, getTokenIconData } = require('./token-wallet.cjs');
const { syncPeerChat, getPeerChatSnapshot } = require('./peer-chat.cjs');
const { syncTradingDiscovery, getTradingDiscoveryCache } = require('./trading.cjs');
const { getTokenOrderBook, getTokenMarketInfo, getTokenSellQuote, buildAndBroadcastList, buildAndBroadcastBuy, buildAndBroadcastCancel } = require('./market.cjs');
const { getBananaBlocksApiKeyStatus, saveBananaBlocksApiKey, removeBananaBlocksApiKey } = require('./bananablocks.cjs');
const { getWalletActivitySnapshot, saveImportedToken, getWalletUtxoStore, markMailRead } = require('./wallet-data.cjs');
const {
  sendMail,
  syncMail,
  listContacts,
  saveContact,
  removeContact,
  buildOwnContactCard,
  fetchAndDecryptAttachment,
  getMailbox,
  markSenderAsSpam,
  unmarkSenderAsSpam,
  deleteMessage,
  setMessagePinned,
  setContactTrusted,
  saveDraft,
  listDrafts,
  deleteDraft,
  estimateMailCost,
} = require('./mail.cjs');
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
      // The spellchecker is what gives the right-click menu its suggestions.
      // It is ON by default in Chromium, but it is stated explicitly so it
      // cannot be turned off by a future default change.
      spellcheck: true,
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL(`http://127.0.0.1:${process.env.LBSX_E2E_PORT || 5173}`);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  // A LINK IN A MAIL opens in the user's BROWSER, not in the app.
  //
  // Every link in a received message is attacker-controlled - the sender
  // chose the address - so the URL is checked before anything is opened.
  // Only http and https are allowed, because those are the only schemes a
  // link in a message has any business being. Anything else - `file:`,
  // `javascript:`, a custom scheme - is refused.
  //
  // The app itself never navigates: `will-navigate` below blocks the window
  // from being taken over by a link, so a click can never replace the wallet
  // with a web page.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isSafeExternalUrl(url)) {
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // A link that is clicked in the same tab - which is what a plain
  // `target="_self"` anchor does - is opened in the browser too, and the
  // window is prevented from navigating away from the app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedDevUrl = !app.isPackaged && url.startsWith('http://127.0.0.1:5173/');
    const allowedPackagedUrl = app.isPackaged && url.startsWith('file://');
    if (allowedDevUrl || allowedPackagedUrl) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });
  // The right-click context menu, built per-click so the enabled/disabled
  // state of each action matches the focused field and the selection.
  mainWindow.webContents.on('context-menu', (event, params) => {
    event.preventDefault();
    buildContextMenu(mainWindow, params).popup({ window: mainWindow });
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
ipcMain.handle('wallet:sync-activity', () => syncWalletActivity(getWalletSummary().address, {
  onProgress: (payload) => {
    try { mainWindow?.webContents.send('wallet:activity-progress', payload); }
    catch { /* progress reporting must never break a sync */ }
  },
}));
ipcMain.handle('wallet:check-pending-statuses', async () => {
  const address = getWalletSummary().address;
  if (app.isPackaged && process.env.LBSX_TEST_PACKAGED === '1') {
    return { ...(await getWalletActivitySnapshot(address)), checkedTransactions: 0 };
  }
  return checkPendingTransactionStatuses(address);
});
ipcMain.handle('wallet:get-imported-tokens', async () => (await getWalletActivitySnapshot(getWalletSummary().address)).importedTokens);
ipcMain.handle('wallet:save-imported-token', (_event, token) => saveImportedToken(getWalletSummary().address, token));
ipcMain.handle('wallet:utxo-store', (_event, payload) => getWalletUtxoStore(getWalletSummary().address, payload || {}));
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
ipcMain.handle('wallet:estimate-bsv-send', (_event, payload) => !app.isPackaged && process.env.LBSX_TEST_TOKEN_FIXTURE === '1'
  ? { feeSats: 250, serviceFeeSats: 10000, amountSats: Math.round(Number(payload.amount) * 100000000), sizeBytes: 250 }
  : estimateBsvSendFee(getWalletPrivateKey(), payload));
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
  : syncPeerChat(getWalletSummary().address, {
    onProgress: (payload) => {
      try { mainWindow?.webContents.send('wallet:peer-chat-progress', payload); }
      catch { /* progress reporting must never break a sync */ }
    },
  }));
ipcMain.handle('peer-chat:send', (_event, payload) => app.isPackaged && process.env.LBSX_TEST_PACKAGED === '1'
  ? { txid: 'bb'.repeat(32), senderAddress: getWalletSummary().address, content: String(payload?.message || '').trim(), timestamp: new Date().toISOString(), status: 'pending', feeSats: 250 }
  : sendPeerChatMessage(getWalletPrivateKey(), payload));
ipcMain.handle('mail:get', () => syncMail(getWalletSummary().address, { privateKey: getWalletPrivateKey() }));
ipcMain.handle('mail:sync', () => syncMail(getWalletSummary().address, { privateKey: getWalletPrivateKey() }));
ipcMain.handle('mail:send', (_event, payload) => sendMail(getWalletPrivateKey(), payload));

// Fetches one encrypted attachment, decrypts it in the main process, and
// returns the bytes. The renderer never sees the key material.
ipcMain.handle('mail:get-attachment', async (_event, payload) => {
  const result = await fetchAndDecryptAttachment({
    privateKey: getWalletPrivateKey(),
    txid: payload?.txid,
    vout: payload?.vout,
    senderAddress: payload?.senderAddress,
    recipientAddress: payload?.recipientAddress,
    messageId: payload?.messageId,
    fileName: payload?.fileName,
    mimeType: payload?.mimeType,
    byteLength: payload?.byteLength,
  });
  // Return the bytes as a plain ArrayBuffer so the renderer can build a blob
  // URL for an image or write the file to disk.
  return {
    fileName: result.fileName,
    mimeType: result.mimeType,
    declaredMimeType: result.declaredMimeType,
    // The renderer must only preview when the main process says it is safe.
    // The main process determined the type from the decrypted bytes.
    renderInline: result.renderInline === true,
    byteLength: result.byteLength,
    data: result.data.buffer.slice(
      result.data.byteOffset,
      result.data.byteOffset + result.data.byteLength,
    ),
  };
});

// Saves a decrypted attachment to disk. The path is chosen by the user in a
// native dialog, so the renderer never picks a path itself.
ipcMain.handle('mail:save-attachment', async (_event, payload) => {
  const result = await fetchAndDecryptAttachment({
    privateKey: getWalletPrivateKey(),
    txid: payload?.txid,
    vout: payload?.vout,
    senderAddress: payload?.senderAddress,
    recipientAddress: payload?.recipientAddress,
    messageId: payload?.messageId,
    fileName: payload?.fileName,
    mimeType: payload?.mimeType,
    byteLength: payload?.byteLength,
  });
  // The file name is sanitised of anything that could escape a directory,
  // and the extension is derived from the name and the MIME type. Without a
  // matching filter the OS save dialog can silently drop the extension,
  // leaving a file the user then has to rename by hand.
  const mimeType = String(payload?.mimeType || result.mimeType || '').toLowerCase();
  const safeName = safeAttachmentName(payload?.fileName);
  const extension = attachmentExtension(safeName, mimeType);
  const defaultName = attachmentDefaultName(safeName, mimeType);

  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultName,
    title: 'Save attachment',
    filters: [
      {
        name: extension === '.jpg' ? 'JPEG image' : `${extension.slice(1).toUpperCase()} file`,
        extensions: [extension.slice(1)],
      },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (canceled || !filePath) return { saved: false };

  // Guarantee the extension survives, whatever the dialog did.
  const finalPath = attachmentFinalPath(filePath, safeName, mimeType);

  await fs.writeFile(finalPath, result.data);
  return { saved: true, filePath: finalPath, byteLength: result.byteLength };
});
// Scans an attachment with VirusTotal.
//
// The attachment is decrypted in the main process and its SHA-256 is looked
// up FIRST, so a file VirusTotal already knows costs nothing and the file
// itself never leaves the device. Only an unknown file is uploaded, and only
// when the user has consented.
ipcMain.handle('mail:scan-attachment', async (_event, payload) => {
  const result = await fetchAndDecryptAttachment({
    privateKey: getWalletPrivateKey(),
    txid: payload?.txid,
    vout: payload?.vout,
    senderAddress: payload?.senderAddress,
    recipientAddress: payload?.recipientAddress,
    messageId: payload?.messageId,
    fileName: payload?.fileName,
    mimeType: payload?.mimeType,
    byteLength: payload?.byteLength,
  });
  const scan = await scanAttachment({
    data: result.data,
    fileName: result.fileName,
    allowUpload: payload?.allowUpload === true,
  });
  return { ...scan, fileName: result.fileName, byteLength: result.byteLength };
});

// Checks whether VirusTotal already knows the file, WITHOUT uploading it.
ipcMain.handle('mail:check-attachment', async (_event, payload) => {
  const result = await fetchAndDecryptAttachment({
    privateKey: getWalletPrivateKey(),
    txid: payload?.txid,
    vout: payload?.vout,
    senderAddress: payload?.senderAddress,
    recipientAddress: payload?.recipientAddress,
    messageId: payload?.messageId,
    fileName: payload?.fileName,
    mimeType: payload?.mimeType,
    byteLength: payload?.byteLength,
  });
  const scan = await scanAttachment({
    data: result.data,
    fileName: result.fileName,
    allowUpload: false,
  });
  return { ...scan, fileName: result.fileName, byteLength: result.byteLength };
});

ipcMain.handle('mail:contacts', () => listContacts(getWalletSummary().address));
ipcMain.handle('mail:save-contact', (_event, payload) => saveContact(getWalletSummary().address, payload));
ipcMain.handle('mail:remove-contact', (_event, contactAddress) => removeContact(getWalletSummary().address, contactAddress));
ipcMain.handle('mail:mark-read', async (_event, payload) => {
  const messageId = String(payload?.messageId || '').trim().toLowerCase();
  const read = payload?.read !== false;
  await markMailRead(getWalletSummary().address, messageId, read);
  return { messageId, read };
});

// ---------------------------------------------------------------------------
// Mail deletion and spam
// ---------------------------------------------------------------------------

// Deletes a message from the local mailbox record. The message stays on
// chain - this only removes it from this wallet's mailbox.
ipcMain.handle('mail:delete', (_event, payload) => deleteMessage(
  getWalletSummary().address,
  String(payload?.messageId || '').trim().toLowerCase(),
));

// Flags the sender's public key as spam. Every future message from that key
// is filed under Spam instead of the inbox.
ipcMain.handle('mail:mark-spam', (_event, payload) => markSenderAsSpam(
  getWalletSummary().address,
  {
    publicKeyHex: payload?.publicKeyHex,
    senderAddress: payload?.senderAddress,
    label: payload?.label,
  },
));

// Removes the spam flag, restoring every message from that sender to the inbox.
ipcMain.handle('mail:unmark-spam', (_event, payload) => unmarkSenderAsSpam(
  getWalletSummary().address,
  String(payload?.publicKeyHex || '').trim().toLowerCase(),
));

// The mailbox without a chain sync: the stored messages plus their spam
// classification.
ipcMain.handle('mail:mailbox', () => getMailbox(getWalletSummary().address));

// Pins or unpins a message. The pin is local: it keeps the message at the
// top of its list on this device.
ipcMain.handle('mail:pin', (_event, payload) => setMessagePinned(
  getWalletSummary().address,
  String(payload?.messageId || '').trim().toLowerCase(),
  payload?.pinned !== false,
));

// Marks or unmarks a contact as trusted. The trust is the user's own local
// vouch for the contact - it changes nothing on chain.
ipcMain.handle('mail:trust-contact', (_event, payload) => setContactTrusted(
  getWalletSummary().address,
  String(payload?.publicKeyHex || '').trim().toLowerCase(),
  payload?.trusted !== false,
));
ipcMain.handle('mail:own-card', () => {
  const wallet = getWalletSummary();
  const publicKey = getWalletPublicKey();
  return buildOwnContactCard(wallet.address, publicKey.point.toBuffer().toString('hex'));
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

// A draft is unsent mail saved on this device. It is LOCAL ONLY - it is
// stored in the encrypted wallet data and is never broadcast.
ipcMain.handle('mail:drafts', () => listDrafts(getWalletSummary().address));
ipcMain.handle('mail:save-draft', (_event, payload) => saveDraft(getWalletSummary().address, payload || {}));
ipcMain.handle('mail:delete-draft', (_event, draftId) => deleteDraft(
  getWalletSummary().address,
  String(draftId || '').trim().toLowerCase(),
));

// Estimates what a mail will cost, in satoshis. The renderer asks the main
// process for this so the number it shows is the SAME arithmetic the send
// path uses - the estimate can never drift from the real charge.
ipcMain.handle('mail:estimate-cost', (_event, payload) => estimateMailCost({
  anchorSats: payload?.anchorSats,
  attachmentBytes: Number(payload?.attachmentBytes || 0),
}));

ipcMain.handle('settings:bananablocks-key-status', () => getBananaBlocksApiKeyStatus());
ipcMain.handle('settings:virustotal-key-status', () => getVirusTotalApiKeyStatus());
ipcMain.handle('settings:save-virustotal-key', (_event, payload) => saveVirusTotalApiKey(payload));
ipcMain.handle('settings:remove-virustotal-key', () => removeVirusTotalApiKey());
ipcMain.handle('settings:save-bananablocks-key', (_event, payload) => saveBananaBlocksApiKey(payload));
ipcMain.handle('settings:remove-bananablocks-key', () => removeBananaBlocksApiKey());

// Whether a URL from a mail body may be opened in the user's browser.
//
// A link in a received message is chosen by the SENDER, so the url is
// attacker-controlled. Only http and https are opened, because those are
// the only schemes a link in a message has any business being. `file:`,
// `javascript:` and every custom scheme are refused.
//
// The check is done on the PARSED url, not on the string, so a url like
// `java\nscript:alert(1)` or ` https://x` cannot slip past a naive prefix
// check by being formatted oddly.
function isSafeExternalUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// The RIGHT-CLICK CONTEXT MENU.
//
// Electron ships no context menu by default, so a right-click did nothing at
// all - no paste, no spellcheck, no copy. This builds the standard editing
// menu for the focused element, plus the SPELLCHECK suggestions.
//
// The spellcheck part is the reason this is not just the plain edit menu:
// Electron exposes the browser's spellchecker as `context.params
// .spellInfo`, which carries the misspelled word and its suggestions. The
// suggestions are offered as a submenu so the user can correct a word without
// leaving the field.
//
// The menu is built per-click, because the available roles depend on what is
// selected: paste is only offered when there is editable content, and redo
// only when there is something to redo.
function buildContextMenu(win, params) {
  const isEditable = Boolean(params.isEditable);
  const selection = params.selectionText ? String(params.selectionText) : '';

  const template = [];

  // The SPELLCHECK suggestions, when the browser reports a misspelling.
  const spell = params.spellInfo;
  if (spell && spell.misspelledWord && Array.isArray(spell.suggestions) && spell.suggestions.length) {
    template.push({
      label: spell.misspelledWord,
      submenu: spell.suggestions.slice(0, 10).map(suggestion => ({
        label: suggestion,
        click: () => win.webContents.replaceMisspelling(suggestion),
      })),
    });
    template.push({ type: 'separator' });
  }

  template.push({
    label: 'Undo',
    accelerator: 'CmdOrCtrl+Z',
    enabled: params.editFlags?.canUndo || false,
    click: () => win.webContents.undo(),
  });
  template.push({
    label: 'Redo',
    accelerator: 'CmdOrCtrl+Shift+Z',
    enabled: params.editFlags?.canRedo || false,
    click: () => win.webContents.redo(),
  });
  template.push({ type: 'separator' });
  template.push({
    label: 'Cut',
    accelerator: 'CmdOrCtrl+X',
    enabled: isEditable && selection.length > 0,
    click: () => win.webContents.cut(),
  });
  template.push({
    label: 'Copy',
    accelerator: 'CmdOrCtrl+C',
    enabled: selection.length > 0,
    click: () => win.webContents.copy(),
  });
  template.push({
    label: 'Paste',
    accelerator: 'CmdOrCtrl+V',
    enabled: isEditable,
    click: () => win.webContents.paste(),
  });
  template.push({
    label: 'Paste and Match Style',
    enabled: isEditable,
    click: () => win.webContents.pasteAndMatchStyle(),
  });
  template.push({
    label: 'Select All',
    accelerator: 'CmdOrCtrl+A',
    enabled: isEditable,
    click: () => win.webContents.selectAll(),
  });

  // A separator and the standard word lookups, when the browser has them.
  if (params.isEditable && params.isPassword === false && selection.length > 0) {
    template.push({ type: 'separator' });
    template.push({
      label: 'Check Spelling…',
      click: () => win.webContents.showInputBox
        ? win.webContents.showInputBox({ title: 'Check spelling' })
        : undefined,
    });
  }

  return Menu.buildFromTemplate(template);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', lockVault);
