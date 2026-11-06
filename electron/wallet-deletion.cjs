const fs = require('node:fs/promises');
const path = require('node:path');
const { deleteVault, getWalletSummary } = require('./vault.cjs');
const { deleteWalletData } = require('./wallet-data.cjs');

/**
 * Removes the wallet connected to this computer: the encrypted vault that holds
 * the recovery phrase, the encrypted local wallet data for the active address,
 * and the legacy token-lock file used by older builds.
 */
async function deleteConnectedWallet(userDataPath) {
  const address = getWalletSummary().address;
  await deleteWalletData(address);
  await fs.rm(path.join(userDataPath, 'token-locks.json'), { force: true });
  const result = await deleteVault();
  return { ...result, address };
}

module.exports = { deleteConnectedWallet };
