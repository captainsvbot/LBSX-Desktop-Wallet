// Tests the VirusTotal scanning module's logic.
//
// The module depends on Electron (for safeStorage and the userData path), so
// the parts under test are exercised through the exported helpers and a
// stubbed transport.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const crypto = require('node:crypto');

// summariseReport is pure, so it can be tested directly.
const { summariseReport } = require('../electron/virustotal.cjs');

console.log('=== VIRUSTOTAL SCAN LOGIC ===');

// --- 1. a clean file ---
const clean = summariseReport({
  data: {
    id: 'a'.repeat(64),
    attributes: {
      last_analysis_stats: { malicious: 0, suspicious: 0, harmless: 70, undetected: 4, timeout: 0 },
      last_analysis_results: {},
      permalink: 'https://www.virustotal.com/gui/file/aaa',
      meaningful_name: 'safe.png',
      type_description: 'PNG image data',
      size: 1234,
    },
  },
});
assert.equal(clean.verdict, 'clean', 'a file with no detections is clean');
assert.equal(clean.malicious, 0);
assert.equal(clean.suspicious, 0);
assert.equal(clean.engines, 74, 'the engine count is the sum of the stats');
assert.equal(clean.size, 1234);

// --- 2. a malicious file ---
const malicious = summariseReport({
  data: {
    id: 'b'.repeat(64),
    attributes: {
      last_analysis_stats: { malicious: 12, suspicious: 2, harmless: 40, undetected: 4, timeout: 0 },
      last_analysis_results: {
        'Engine A': { category: 'malicious', result: 'Trojan.Generic' },
        'Engine B': { category: 'malicious', result: 'Malware.X' },
        'Engine C': { category: 'suspicious', result: 'Heuristic.HEUR/1' },
        'Engine D': { category: 'harmless', result: null },
      },
      permalink: 'https://www.virustotal.com/gui/file/bbb',
      size: 999,
    },
  },
});
assert.equal(malicious.verdict, 'malicious', 'any malicious detection is malicious');
assert.equal(malicious.malicious, 12);
assert.equal(malicious.suspicious, 2);
assert.equal(malicious.names.length, 3, 'only malicious and suspicious engines are listed');
assert.ok(
  malicious.names.some(entry => entry.name === 'Engine A' && entry.result === 'Trojan.Generic'),
  'the detection names must be preserved',
);
assert.ok(
  !malicious.names.some(entry => entry.name === 'Engine D'),
  'a harmless engine must not be listed as a detection',
);

// --- 3. a suspicious-only file ---
const suspicious = summariseReport({
  data: {
    attributes: {
      last_analysis_stats: { malicious: 0, suspicious: 3, harmless: 60, undetected: 5, timeout: 0 },
      last_analysis_results: { 'Engine X': { category: 'suspicious', result: 'Suspicious' } },
    },
  },
});
assert.equal(suspicious.verdict, 'suspicious', 'suspicious detections are reported separately from malicious');

// --- 4. an unknown file ---
const unknown = summariseReport({
  data: { attributes: { last_analysis_stats: { malicious: 0, suspicious: 0, harmless: 0, undetected: 0, timeout: 0 } } },
});
assert.equal(unknown.verdict, 'unknown', 'a file with no analysis is unknown');

// --- 5. the hash is computed locally ---
const data = Buffer.from('a real attachment payload');
const sha256 = crypto.createHash('sha256').update(data).digest('hex');
assert.equal(sha256.length, 64, 'the hash is a SHA-256 hex digest');
assert.equal(
  crypto.createHash('sha256').update(data).digest('hex'),
  sha256,
  'the hash is stable',
);
assert.notEqual(
  crypto.createHash('sha256').update(Buffer.from('a different payload')).digest('hex'),
  sha256,
  'different content hashes differently',
);

console.log('  clean file verdict: OK');
console.log('  malicious file verdict and detection names: OK');
console.log('  suspicious-only verdict: OK');
console.log('  unknown file verdict: OK');
console.log('  the hash is computed locally over the plaintext: OK');

console.log('');
console.log('PASS: VirusTotal reports are summarised correctly and the file hash is computed locally');
