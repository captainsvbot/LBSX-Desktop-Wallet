const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lbsx', Object.freeze({
  copyText: (text) => ipcRenderer.invoke('app:copy-text', text),
  openExplorer: (reference) => ipcRenderer.invoke('app:open-explorer', reference),
  vaultStatus: () => ipcRenderer.invoke('vault:status'),
  importSeedPhrase: (payload) => ipcRenderer.invoke('vault:import', payload),
  unlock: (payload) => ipcRenderer.invoke('vault:unlock', payload),
  lock: () => ipcRenderer.invoke('vault:lock'),
  deleteWallet: () => ipcRenderer.invoke('vault:delete'),
  walletSummary: () => ipcRenderer.invoke('wallet:summary'),
  syncBalances: () => ipcRenderer.invoke('wallet:sync-balances'),
  onSpvProgress: (callback) => {
    if (typeof callback !== 'function') throw new Error('An SPV progress callback is required.');
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('wallet:spv-progress', listener);
    return () => ipcRenderer.removeListener('wallet:spv-progress', listener);
  },
  onActivityProgress: (callback) => {
    if (typeof callback !== 'function') throw new Error('An activity progress callback is required.');
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('wallet:activity-progress', listener);
    return () => ipcRenderer.removeListener('wallet:activity-progress', listener);
  },
  onPeerChatProgress: (callback) => {
    if (typeof callback !== 'function') throw new Error('A peer chat progress callback is required.');
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('wallet:peer-chat-progress', listener);
    return () => ipcRenderer.removeListener('wallet:peer-chat-progress', listener);
  },
  getWalletActivity: () => ipcRenderer.invoke('wallet:get-activity'),
  syncWalletActivity: () => ipcRenderer.invoke('wallet:sync-activity'),
  checkPendingTransactionStatuses: () => ipcRenderer.invoke('wallet:check-pending-statuses'),
  getImportedTokens: () => ipcRenderer.invoke('wallet:get-imported-tokens'),
  getUtxoStore: (payload) => ipcRenderer.invoke('wallet:utxo-store', payload),
  saveImportedToken: (token) => ipcRenderer.invoke('wallet:save-imported-token', token),
  getTokenIcon: (token) => ipcRenderer.invoke('token:get-icon', token),
  sendBsv: (payload) => ipcRenderer.invoke('wallet:send-bsv', payload),
  estimateBsvSend: (payload) => ipcRenderer.invoke('wallet:estimate-bsv-send', payload),
  mintBsv21Token: (payload) => ipcRenderer.invoke('wallet:mint-bsv21', payload),
  syncTradingDiscovery: () => ipcRenderer.invoke('trading:sync-discovery'),
  getTradingDiscoveryCache: () => ipcRenderer.invoke('trading:get-discovery-cache'),
  getPeerChatSnapshot: () => ipcRenderer.invoke('peer-chat:get'),
  syncPeerChat: () => ipcRenderer.invoke('peer-chat:sync'),
  sendPeerChatMessage: (payload) => ipcRenderer.invoke('peer-chat:send', payload),
  getTokenOrderBook: (tokenId) => ipcRenderer.invoke('trading:get-orderbook', tokenId),
  getTokenMarketInfo: (tokenId) => ipcRenderer.invoke('trading:get-token-info', tokenId),
  getTokenSellQuote: (tokenId) => ipcRenderer.invoke('trading:get-sell-quote', tokenId),
  listTokenForSale: (payload) => ipcRenderer.invoke('trading:list-token', payload),
  buyTokenListing: (payload) => ipcRenderer.invoke('trading:buy-token', payload),
  cancelTokenListing: (payload) => ipcRenderer.invoke('trading:cancel-token', payload),
  sendToken: (payload) => ipcRenderer.invoke('token:send', payload),
  getTokenLocks: (tokenId) => ipcRenderer.invoke('token:locks', tokenId),
  lockTokens: (payload) => ipcRenderer.invoke('token:lock', payload),
  claimTokenLock: (lockId) => ipcRenderer.invoke('token:claim', lockId),
  getBananaBlocksApiKeyStatus: () => ipcRenderer.invoke('settings:bananablocks-key-status'),
  saveBananaBlocksApiKey: (payload) => ipcRenderer.invoke('settings:save-bananablocks-key', payload),
  removeBananaBlocksApiKey: () => ipcRenderer.invoke('settings:remove-bananablocks-key'),
}));
