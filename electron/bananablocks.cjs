const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');

const SETTINGS_VERSION = 1;
const SETTINGS_FILE = 'bananablocks-api-key.json';
let cachedApiKey = null;

function settingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function secureStorageAvailable() {
  try {
    if (!safeStorage?.isEncryptionAvailable()) return false;
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false;
    return true;
  } catch {
    return false;
  }
}

async function readSettings() {
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    if (settings?.version !== SETTINGS_VERSION
      || typeof settings.enabled !== 'boolean'
      || (settings.encryptedKey !== null && typeof settings.encryptedKey !== 'string')) {
      throw new Error('The saved BananaBlocks API key settings have an unsupported format.');
    }
    return settings;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: SETTINGS_VERSION, enabled: false, encryptedKey: null };
    if (error instanceof SyntaxError) throw new Error('The saved BananaBlocks API key settings are unreadable.');
    throw error;
  }
}

async function writeSettings(settings) {
  const target = settingsPath();
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temp, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

async function getBananaBlocksApiKeyStatus() {
  const settings = await readSettings();
  return {
    configured: Boolean(settings.encryptedKey),
    enabled: settings.enabled && Boolean(settings.encryptedKey),
    secureStorageAvailable: secureStorageAvailable(),
  };
}

async function saveBananaBlocksApiKey(payload = {}) {
  if (typeof payload.enabled !== 'boolean') throw new Error('Choose whether to enable the BananaBlocks API key.');
  if (payload.apiKey != null && typeof payload.apiKey !== 'string') throw new Error('The BananaBlocks API key must be text.');
  const enteredKey = String(payload.apiKey || '').trim();
  if (enteredKey.length > 2048 || /[\r\n]/.test(enteredKey)) throw new Error('The BananaBlocks API key is invalid.');

  const previous = await readSettings();
  let encryptedKey = previous.encryptedKey;
  if (enteredKey) {
    if (!secureStorageAvailable()) throw new Error('Secure operating-system storage is unavailable; the API key was not saved.');
    encryptedKey = safeStorage.encryptString(enteredKey).toString('base64');
  }
  if (payload.enabled && !encryptedKey) throw new Error('Enter an API key before enabling it.');
  if (payload.enabled && !secureStorageAvailable()) throw new Error('Secure operating-system storage is unavailable; the API key cannot be enabled.');

  const next = { version: SETTINGS_VERSION, enabled: payload.enabled, encryptedKey };
  await writeSettings(next);
  cachedApiKey = enteredKey && payload.enabled ? enteredKey : payload.enabled ? null : '';
  return getBananaBlocksApiKeyStatus();
}

async function removeBananaBlocksApiKey() {
  try {
    await fs.unlink(settingsPath());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  cachedApiKey = '';
  return getBananaBlocksApiKeyStatus();
}

async function getEnabledApiKey() {
  if (cachedApiKey !== null) return cachedApiKey || null;
  const settings = await readSettings();
  if (!settings.enabled || !settings.encryptedKey) {
    cachedApiKey = '';
    return null;
  }
  if (!secureStorageAvailable()) throw new Error('The saved BananaBlocks API key cannot be decrypted with this operating-system key store.');
  try {
    cachedApiKey = safeStorage.decryptString(Buffer.from(settings.encryptedKey, 'base64'));
    return cachedApiKey;
  } catch (error) {
    throw new Error(`Could not decrypt the saved BananaBlocks API key: ${error.message}`);
  }
}

async function bananaBlocksFetch(input, options = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.protocol === 'https:' && url.hostname.toLowerCase() === 'bananablocks.com') {
    const apiKey = await getEnabledApiKey();
    if (apiKey) {
      const headers = new Headers(options.headers || {});
      headers.set('X-API-Key', apiKey);
      options = { ...options, headers };
    }
  }
  return fetch(input, options);
}

module.exports = {
  bananaBlocksFetch,
  getBananaBlocksApiKeyStatus,
  saveBananaBlocksApiKey,
  removeBananaBlocksApiKey,
};
