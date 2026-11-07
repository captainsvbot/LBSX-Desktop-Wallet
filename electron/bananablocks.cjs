const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');

const SETTINGS_VERSION = 1;
const SETTINGS_FILE = 'bananablocks-api-key.json';
let cachedApiKey = null;

// BananaBlocks enforces a shared request budget per client (80 requests per
// rolling 60 second window by default). Every caller in this app talks to the
// same API, so the budget is tracked once here: responses report the current
// limit and the remaining allowance, and callers wait for the window to roll
// over instead of spending their request on a guaranteed HTTP 429.
const RATE_LIMIT_WINDOW_MS = 60_000;
let rateLimitWindowMs = RATE_LIMIT_WINDOW_MS;
const rateLimit = { limit: null, remaining: null, windowStart: 0, blockedUntil: 0 };

function noteRateLimit(response) {
  const now = Date.now();
  const limit = Number(response?.headers?.get?.('x-ratelimit-limit'));
  const remaining = Number(response?.headers?.get?.('x-ratelimit-remaining'));
  if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining)) {
    if (rateLimit.limit !== limit || rateLimit.remaining === null || remaining > rateLimit.remaining) {
      // The allowance went back up, so the window rolled over. Work out when it
      // started by assuming the allowance is spent evenly across the window.
      rateLimit.windowStart = now - (limit - remaining) * (rateLimitWindowMs / limit);
    }
    rateLimit.limit = limit;
    rateLimit.remaining = remaining;
  }
  if (response?.status === 429) {
    rateLimit.remaining = 0;
    rateLimit.blockedUntil = Math.max(rateLimit.blockedUntil, rateLimit.windowStart + rateLimitWindowMs, now + 1000);
  }
  if (rateLimit.blockedUntil && rateLimit.blockedUntil <= now) rateLimit.blockedUntil = 0;
}

// Called before a request is issued so the wait happens outside any per
// request timeout the caller may have started.
async function waitForRateLimitBudget() {
  const now = Date.now();
  if (rateLimit.remaining === null || rateLimit.remaining > 0) return;
  const until = Math.max(rateLimit.blockedUntil, rateLimit.windowStart + rateLimitWindowMs);
  const waitMs = until - now;
  if (waitMs <= 0) return;
  await new Promise(resolve => setTimeout(resolve, waitMs + 250));
}

function getRateLimitStatus() {
  return { limit: rateLimit.limit, remaining: rateLimit.remaining, blockedUntil: rateLimit.blockedUntil };
}

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
  const response = await fetch(input, options);
  noteRateLimit(response);
  return response;
}

module.exports = {
  bananaBlocksFetch,
  waitForRateLimitBudget,
  getRateLimitStatus,
  getBananaBlocksApiKeyStatus,
  saveBananaBlocksApiKey,
  removeBananaBlocksApiKey,
  _test: {
    resetRateLimit() {
      rateLimit.limit = null;
      rateLimit.remaining = null;
      rateLimit.windowStart = 0;
      rateLimit.blockedUntil = 0;
    },
    setRateLimitWindowMs(value) {
      if (!Number.isFinite(value) || value < 0) throw new Error('Test rate limit window must be a non-negative number.');
      rateLimitWindowMs = value;
    },
  },
};
