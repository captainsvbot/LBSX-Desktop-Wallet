// VirusTotal scanning for encrypted mail attachments.
//
// WHY THE HASH IS CHECKED FIRST
//
// Uploading an attachment to VirusTotal means sending it DECRYPTED, in
// plaintext, to a third party. For an app whose whole point is end-to-end
// encryption, that is a significant disclosure and it is permanent -
// VirusTotal retains uploaded files.
//
// So the flow is:
//
//   1. Hash the decrypted attachment locally (SHA-256).
//   2. ASK VirusTotal for that hash. This sends only the hash, never the file.
//   3. If VirusTotal already knows the file, use that report. Nothing was
//      uploaded.
//   4. Only if the file is UNKNOWN does the attachment get uploaded, and the
//      user is told that is about to happen.
//
// A file VirusTotal has already seen is overwhelmingly likely to be one
// somebody else has scanned, so in practice most attachments are checked
// without the file ever leaving the device.
//
// PUBLIC API TERMS
//
// The public API allows 500 requests a day and 4 a minute, and must not be
// used commercially. Scanning a mail attachment contributes a NEW file,
// which is exactly what the public API is for.
//
// The API key is stored in the operating system's secure storage, the same
// way the BananaBlocks key is.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const VT_API = 'https://www.virustotal.com/api/v3';
const SETTINGS_FILE = 'virustotal-api-key.json';
const SETTINGS_VERSION = 1;

// The public API limit. Uploads are rate limited more tightly than lookups.
const MIN_LOOKUP_INTERVAL_MS = 15 * 1000;   // 4 requests a minute
const MIN_UPLOAD_INTERVAL_MS = 15 * 1000;
const DAILY_LOOKUP_LIMIT = 500;
const DAILY_UPLOAD_LIMIT = 500;

// VirusTotal's own limit for a file upload.
const MAX_UPLOAD_BYTES = 650 * 1024 * 1024;

// How long to wait for a newly uploaded file to be analysed.
const ANALYSIS_TIMEOUT_MS = 90 * 1000;
const ANALYSIS_POLL_INTERVAL_MS = 5000;

let cachedApiKey = '';
let lastLookupAt = 0;
let lastUploadAt = 0;
let dailyLookups = 0;
let dailyUploads = 0;
let dailyCounterDate = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Settings (the API key)
// ---------------------------------------------------------------------------

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
      throw new Error('The saved VirusTotal API key settings have an unsupported format.');
    }
    return settings;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: SETTINGS_VERSION, enabled: false, encryptedKey: null };
    if (error instanceof SyntaxError) throw new Error('The saved VirusTotal API key settings are unreadable.');
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

async function getVirusTotalApiKeyStatus() {
  const settings = await readSettings();
  return {
    configured: Boolean(settings.encryptedKey),
    enabled: settings.enabled && Boolean(settings.encryptedKey),
    secureStorageAvailable: secureStorageAvailable(),
    dailyLookups,
    dailyUploads,
    dailyLimit: DAILY_LOOKUP_LIMIT,
  };
}

async function saveVirusTotalApiKey(payload = {}) {
  if (typeof payload.enabled !== 'boolean') throw new Error('Choose whether to enable the VirusTotal API key.');
  if (payload.apiKey != null && typeof payload.apiKey !== 'string') throw new Error('The VirusTotal API key must be text.');
  const enteredKey = String(payload.apiKey || '').trim();
  if (enteredKey.length > 2048 || /[\r\n]/.test(enteredKey)) throw new Error('The VirusTotal API key is invalid.');

  const previous = await readSettings();
  let encryptedKey = previous.encryptedKey;
  if (enteredKey) {
    if (!secureStorageAvailable()) throw new Error('Secure operating-system storage is unavailable; the API key was not saved.');
    encryptedKey = safeStorage.encryptString(enteredKey).toString('base64');
  }
  if (payload.enabled && !encryptedKey) throw new Error('Enter an API key before enabling it.');
  if (payload.enabled && !secureStorageAvailable()) throw new Error('Secure operating-system storage is unavailable; the API key cannot be enabled.');

  await writeSettings({ version: SETTINGS_VERSION, enabled: payload.enabled, encryptedKey });
  cachedApiKey = enteredKey && payload.enabled ? enteredKey : payload.enabled ? null : '';
  return getVirusTotalApiKeyStatus();
}

async function removeVirusTotalApiKey() {
  try {
    await fs.unlink(settingsPath());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  cachedApiKey = '';
  return getVirusTotalApiKeyStatus();
}

async function apiKey() {
  if (cachedApiKey) return cachedApiKey;
  const settings = await readSettings();
  if (!settings.enabled || !settings.encryptedKey) {
    throw new Error('Add a VirusTotal API key in Settings to scan attachments.');
  }
  if (!secureStorageAvailable()) {
    throw new Error('Secure operating-system storage is unavailable; the VirusTotal API key cannot be read.');
  }
  cachedApiKey = safeStorage.decryptString(Buffer.from(settings.encryptedKey, 'base64'));
  return cachedApiKey;
}

// ---------------------------------------------------------------------------
// Quota and pacing
// ---------------------------------------------------------------------------

function rollDailyCounters() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyCounterDate) {
    dailyCounterDate = today;
    dailyLookups = 0;
    dailyUploads = 0;
  }
}

async function waitForSlot(kind) {
  rollDailyCounters();
  if (kind === 'upload' && dailyUploads >= DAILY_UPLOAD_LIMIT) {
    throw new Error('The daily VirusTotal upload limit has been reached.');
  }
  if (kind === 'lookup' && dailyLookups >= DAILY_LOOKUP_LIMIT) {
    throw new Error('The daily VirusTotal request limit has been reached.');
  }
  const last = kind === 'upload' ? lastUploadAt : lastLookupAt;
  const interval = kind === 'upload' ? MIN_UPLOAD_INTERVAL_MS : MIN_LOOKUP_INTERVAL_MS;
  const wait = interval - (Date.now() - last);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  if (kind === 'upload') {
    lastUploadAt = Date.now();
    dailyUploads += 1;
  } else {
    lastLookupAt = Date.now();
    dailyLookups += 1;
  }
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function vtFetch(pathname, options = {}) {
  const key = await apiKey();
  const response = await fetch(`${VT_API}${pathname}`, {
    ...options,
    headers: {
      'x-apikey': key,
      accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  if (response.status === 429) {
    throw new Error('VirusTotal rate limit reached. Try again in a minute.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('The VirusTotal API key was rejected.');
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`VirusTotal returned an error (HTTP ${response.status}).`);
  }
  return response.json();
}

// Reads a report and turns it into something the UI can show.
function summariseReport(report) {
  const stats = report?.data?.attributes?.last_analysis_stats || {};
  const total = Number(stats.malicious || 0)
    + Number(stats.suspicious || 0)
    + Number(stats.harmless || 0)
    + Number(stats.undetected || 0)
    + Number(stats.timeout || 0);
  const malicious = Number(stats.malicious || 0);
  const suspicious = Number(stats.suspicious || 0);
  const engines = total || Number(report?.data?.attributes?.last_analysis_results ? Object.keys(report.data.attributes.last_analysis_results).length : 0);

  let verdict = 'unknown';
  if (malicious > 0) verdict = 'malicious';
  else if (suspicious > 0) verdict = 'suspicious';
  else if (engines > 0) verdict = 'clean';

  return {
    sha256: report?.data?.id || '',
    verdict,
    malicious,
    suspicious,
    harmless: Number(stats.harmless || 0),
    undetected: Number(stats.undetected || 0),
    engines,
    names: Object.entries(report?.data?.attributes?.last_analysis_results || {})
      .filter(([, result]) => result?.category === 'malicious' || result?.category === 'suspicious')
      .map(([name, result]) => ({ name, result: result.result || 'malicious' })),
    permalink: report?.data?.attributes?.permalink || '',
    meaningfulName: report?.data?.attributes?.meaningful_name || '',
    typeDescription: report?.data?.attributes?.type_description || '',
    size: Number(report?.data?.attributes?.size || 0),
  };
}

// Looks a file up by its hash. Sends ONLY the hash - never the file.
async function lookupByHash(sha256) {
  await waitForSlot('lookup');
  const report = await vtFetch(`/files/${encodeURIComponent(sha256)}`);
  if (!report) return null;
  return summariseReport(report);
}

// Uploads a file for analysis. This sends the DECRYPTED bytes to VirusTotal.
async function uploadFile(data, fileName) {
  if (!Buffer.isBuffer(data) || !data.length) throw new Error('There is nothing to scan.');
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new Error('VirusTotal accepts files up to 650 MB.');
  }
  await waitForSlot('upload');
  const form = new FormData();
  form.append('file', new Blob([data]), fileName || 'attachment');
  const report = await vtFetch('/files', { method: 'POST', body: form });
  return report?.data?.id || '';
}

// Polls for the analysis to complete.
async function waitForAnalysis(sha256) {
  const end = Date.now() + ANALYSIS_TIMEOUT_MS;
  while (Date.now() < end) {
    const report = await lookupByHash(sha256);
    if (report && report.engines > 0) return report;
    await new Promise(resolve => setTimeout(resolve, ANALYSIS_POLL_INTERVAL_MS));
  }
  return null;
}

// The full flow for one attachment.
//
// `allowUpload` is false when the user has not consented to sending the file
// to a third party. In that case only the hash lookup happens.
async function scanAttachment({ data, fileName, allowUpload = true }) {
  if (!Buffer.isBuffer(data) || !data.length) throw new Error('There is nothing to scan.');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');

  // 1. Hash-only lookup first. The file itself never leaves the device here.
  const known = await lookupByHash(sha256);
  if (known) {
    return {
      ...known,
      sha256,
      uploaded: false,
      // The file was already known to VirusTotal, so nothing was sent.
      alreadyKnown: true,
    };
  }

  // 2. Unknown file. Uploading is the only way to get it analysed.
  if (!allowUpload) {
    return {
      sha256,
      verdict: 'unknown',
      malicious: 0,
      suspicious: 0,
      harmless: 0,
      undetected: 0,
      engines: 0,
      names: [],
      permalink: '',
      meaningfulName: '',
      typeDescription: '',
      size: data.length,
      uploaded: false,
      alreadyKnown: false,
      needsUpload: true,
    };
  }

  // 3. Upload and wait for the analysis.
  const analysisId = await uploadFile(data, fileName);
  const report = await waitForAnalysis(analysisId || sha256);
  if (!report) {
    return {
      sha256,
      verdict: 'unknown',
      malicious: 0,
      suspicious: 0,
      harmless: 0,
      undetected: 0,
      engines: 0,
      names: [],
      permalink: '',
      meaningfulName: '',
      typeDescription: '',
      size: data.length,
      uploaded: true,
      alreadyKnown: false,
      pending: true,
    };
  }
  return { ...report, sha256, uploaded: true, alreadyKnown: false };
}

module.exports = {
  scanAttachment,
  lookupByHash,
  summariseReport,
  getVirusTotalApiKeyStatus,
  saveVirusTotalApiKey,
  removeVirusTotalApiKey,
  _test: { summariseReport, sha256Of: data => crypto.createHash('sha256').update(data).digest('hex') },
};
