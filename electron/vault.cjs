const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const bip39 = require('bip39');
const bsvModule = require('bsv');

const bsv = bsvModule.default || bsvModule;
const KDF_N = 1 << 15;
const KDF_R = 8;
const KDF_P = 1;
const DERIVATION_PATH = "m/44'/236'/0'/0/0";
let unlockedMnemonic = null;

function vaultPath() {
  return path.join(app.getPath('userData'), 'wallet-vault.json');
}

function deriveEncryptionKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, {
      N: KDF_N,
      r: KDF_R,
      p: KDF_P,
      maxmem: 64 * 1024 * 1024,
    }, (error, key) => error ? reject(error) : resolve(key));
  });
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('Use a local vault password with at least 12 characters.');
  }
}

function normalizePhrase(phrase) {
  return String(phrase || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function derivePublicWallet(mnemonic) {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = bsv.HDPrivateKey.fromSeed(seed);
  const child = root.deriveChild(DERIVATION_PATH).privateKey;
  return {
    address: child.toAddress().toString(),
    publicKey: child.toPublicKey().toHex(),
    derivationPath: DERIVATION_PATH,
  };
}

function hasVault() {
  return fs.existsSync(vaultPath());
}

function canUseDeviceEncryption() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  // Electron's Linux basic_text backend is explicitly not encrypted by an OS key store.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
  return true;
}

async function encryptVault(mnemonic, password) {
  validatePassword(password);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveEncryptionKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()]);
  const envelope = {
    version: 2,
    mode: 'password',
    kdf: 'scrypt',
    kdfN: KDF_N,
    kdfR: KDF_R,
    kdfP: KDF_P,
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  key.fill(0);
  return envelope;
}

function encryptVaultForDevice(mnemonic) {
  if (!canUseDeviceEncryption()) {
    throw new Error('Passwordless protection is unavailable on this computer. Choose a vault password instead.');
  }
  return {
    version: 2,
    mode: 'device',
    cipher: 'electron-safeStorage',
    ciphertext: safeStorage.encryptString(mnemonic).toString('base64'),
  };
}

async function decryptVault(envelope, password) {
  validatePassword(password);
  if (!((envelope?.version === 1 && envelope?.kdf === 'scrypt' && envelope?.cipher === 'aes-256-gcm')
    || (envelope?.version === 2 && envelope?.mode === 'password' && envelope?.kdf === 'scrypt' && envelope?.cipher === 'aes-256-gcm'))) {
    throw new Error('This wallet vault format is not supported.');
  }
  const key = await deriveEncryptionKey(password, Buffer.from(envelope.salt, 'base64'));
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (_) {
    throw new Error('Could not unlock the vault. Check the password.');
  } finally {
    key.fill(0);
  }
}

function decryptDeviceVault(envelope) {
  if (envelope?.version !== 2 || envelope?.mode !== 'device' || envelope?.cipher !== 'electron-safeStorage') {
    throw new Error('This passwordless vault format is not supported.');
  }
  if (!canUseDeviceEncryption()) {
    throw new Error('This computer cannot access the OS encryption key. Reopen on the original device or restore from your recovery phrase.');
  }
  try {
    return safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
  } catch (error) {
    throw new Error(`Could not open this device-protected wallet: ${error?.message || 'OS decryption failed'}`);
  }
}

async function getVaultStatus() {
  if (!hasVault()) return { exists: false, requiresPassword: false, deviceProtectionAvailable: canUseDeviceEncryption() };
  const envelope = JSON.parse(await fs.promises.readFile(vaultPath(), 'utf8'));
  if (envelope?.mode === 'device') {
    unlockedMnemonic = decryptDeviceVault(envelope);
    return {
      exists: true,
      requiresPassword: false,
      mode: 'device',
      wallet: { ...derivePublicWallet(unlockedMnemonic), vaultMode: 'device' },
      deviceProtectionAvailable: canUseDeviceEncryption(),
    };
  }
  return {
    exists: true,
    requiresPassword: true,
    mode: 'password',
    deviceProtectionAvailable: canUseDeviceEncryption(),
  };
}

async function writeVault(envelope) {
  const target = vaultPath();
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(temp, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.promises.rename(temp, target);
}

async function importVault(payload = {}) {
  if (hasVault()) throw new Error('A wallet vault already exists. Unlock it before importing a replacement.');
  const mnemonic = normalizePhrase(payload.mnemonic);
  const password = String(payload.password || '');
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('That recovery phrase is not a valid BIP39 phrase.');
  const wallet = derivePublicWallet(mnemonic);
  const envelope = password
    ? await encryptVault(mnemonic, password)
    : encryptVaultForDevice(mnemonic);
  await writeVault(envelope);
  unlockedMnemonic = mnemonic;
  return { wallet: { ...wallet, vaultMode: password ? 'password' : 'device' }, exists: true, requiresPassword: !!password, mode: password ? 'password' : 'device' };
}

async function unlockVault(payload = {}) {
  if (!hasVault()) throw new Error('No local wallet exists yet. Import a recovery phrase first.');
  const envelope = JSON.parse(await fs.promises.readFile(vaultPath(), 'utf8'));
  const mnemonic = envelope?.mode === 'device'
    ? decryptDeviceVault(envelope)
    : await decryptVault(envelope, payload.password);
  unlockedMnemonic = mnemonic;
  return { wallet: { ...derivePublicWallet(mnemonic), vaultMode: envelope?.mode === 'device' ? 'device' : 'password' }, unlocked: true, requiresPassword: envelope?.mode !== 'device', mode: envelope?.mode || 'password' };
}

function lockVault() {
  unlockedMnemonic = null;
}

async function deleteVault() {
  if (!hasVault()) throw new Error('There is no local wallet to delete.');
  await fs.promises.rm(vaultPath(), { force: true });
  unlockedMnemonic = null;
  return { deleted: true };
}

function getWalletSummary() {
  if (!unlockedMnemonic) throw new Error('Wallet is locked.');
  return derivePublicWallet(unlockedMnemonic);
}

function getWalletPrivateKey() {
  if (!unlockedMnemonic) throw new Error('Wallet is locked.');
  const seed = bip39.mnemonicToSeedSync(unlockedMnemonic);
  return bsv.HDPrivateKey.fromSeed(seed).deriveChild(DERIVATION_PATH).privateKey;
}

function getWalletDataEncryptionKey() {
  if (!unlockedMnemonic) throw new Error('Wallet is locked.');
  const seed = bip39.mnemonicToSeedSync(unlockedMnemonic);
  try {
    return Buffer.from(crypto.hkdfSync(
      'sha256',
      seed,
      Buffer.from('LBSX Desktop Wallet local data v1'),
      Buffer.from('wallet-data encryption'),
      32,
    ));
  } finally {
    seed.fill(0);
  }
}

module.exports = {
  hasVault,
  getVaultStatus,
  importVault,
  unlockVault,
  lockVault,
  deleteVault,
  getWalletSummary,
  getWalletPrivateKey,
  getWalletDataEncryptionKey,
};
