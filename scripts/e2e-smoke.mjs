import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const electronBinary = require('electron');
const viteEntry = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const testPassword = 'e2e-only-password-789';
const devPort = Number(process.env.LBSX_E2E_PORT || 5173);
const debugPort = Number(process.env.LBSX_E2E_DEBUG_PORT || 9338);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), `lbsx-wallet-e2e-${process.pid}-`));
let vite;
let electron;
let socket;
let nextId = 0;
const pending = new Map();

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function waitFor(check, label, timeoutMs = 20000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForVite() {
  return waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${devPort}/`)).ok; } catch { return false; }
  }, 'Vite');
}

async function connectDevTools() {
  const page = await waitFor(async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return targets.find(item => item.type === 'page' && item.url.includes(`127.0.0.1:${devPort}`));
    } catch { return null; }
  }, 'Electron app page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') console.error('Renderer exception:', JSON.stringify(message.params.exceptionDetails));
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') console.error('Renderer log:', JSON.stringify(message.params.entry));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.send(JSON.stringify({ id: ++nextId, method: 'Runtime.enable' }));
  socket.send(JSON.stringify({ id: ++nextId, method: 'Log.enable' }));
  return page;
}

async function evaluate(expression) {
  const id = ++nextId;
  const resultPromise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const response = await resultPromise;
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Renderer evaluation failed');
  return response.result.value;
}

async function fill(selector, value, prototypeName = 'HTMLInputElement') {
  const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing input ${selector}'); const set = Object.getOwnPropertyDescriptor(${prototypeName}.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
  await evaluate(expression);
}

async function click(selector) {
  const clicked = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing button ${selector}'); el.click(); return true; })()`);
  assert(clicked, `Could not click ${selector}`);
}

async function bodyHas(text) {
  return evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
}

async function startElectron(profile) {
  electron = spawn(electronBinary, [root, `--remote-debugging-port=${debugPort}`], {
    cwd: root,
    env: { ...process.env, LBSX_TEST_USER_DATA_DIR: profile, LBSX_TEST_TOKEN_FIXTURE: '1' },
    stdio: 'ignore',
  });
  electron.on('error', error => console.error('Electron launch error:', error.message));
  await connectDevTools();
}

async function stopElectron() {
  if (!electron?.pid) return;
  if (socket?.readyState === WebSocket.OPEN) {
    const id = ++nextId;
    const closed = new Promise(resolve => {
      const timer = setTimeout(resolve, 6000);
      pending.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: resolve });
    });
    socket.send(JSON.stringify({ id, method: 'Page.close' }));
    await Promise.race([closed, new Promise(resolve => electron.once('exit', resolve))]);
  }
  try { socket?.close(); } catch {}
  socket = null;
  if (process.platform === 'win32') {
    if (electron.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(electron.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    }
  } else {
    if (electron.exitCode === null) electron.kill('SIGTERM');
  }
  await Promise.race([new Promise(resolve => electron.once('exit', resolve)), delay(3000)]);
  electron = null;
}

async function importPhraseWithDeviceProtection(profile) {
  await startElectron(profile);
  try { await waitFor(() => bodyHas('Import your wallet'), 'first-run import screen'); }
  catch (error) {
    console.error('Page diagnostics:', await evaluate(`JSON.stringify({ url: location.href, title: document.title, body: document.body?.innerText, bodyHtml: document.body?.innerHTML, scriptTypes: [...document.scripts].map(s => [s.src, s.type]), bridge: typeof window.lbsx, bridgeMethods: Object.keys(window.lbsx || {}) })`));
    throw error;
  }
  assert(await bodyHas('Recovery phrase'), 'First screen should ask for an existing recovery phrase');
  assert(await evaluate(`document.body.innerText.includes('Set a vault password')`), 'Password option should be available');
  await fill('textarea', phrase, 'HTMLTextAreaElement');
  await click('form button[type="submit"]');
  await waitFor(() => bodyHas('Good to see you.'), 'device-protected wallet dashboard');
  const address = await evaluate(`document.querySelector('.wallet-address code')?.textContent`);
  assert(address && address.length > 10, 'Imported wallet address should be visible');
  const envelopeText = await readFile(path.join(profile, 'wallet-vault.json'), 'utf8');
  assert(!envelopeText.includes('abandon'), 'Recovery phrase must not be stored as plaintext');
  const status = await evaluate('window.lbsx.vaultStatus()');
  assert(status.requiresPassword === false && status.wallet?.address, 'Passwordless vault should open using device protection');
  console.log('PASS: first-run import, OS-encrypted storage, no plaintext seed');

  await click('.primary-nav .nav-item:nth-child(2)');
  await click('.page-heading .secondary-button');
  await waitFor(() => bodyHas('TEST'), 'fixture token on Assets page');
  assert(await bodyHas('Send') && await bodyHas('Receive') && await bodyHas('Locker'), 'Each token must show Send, Receive, and Locker actions');
  await click('.token-actions button:nth-child(1)');
  await waitFor(() => bodyHas('Send TEST'), 'token send dialog');
  assert(await bodyHas('Review transfer'), 'Token send must stop at a review step before signing/broadcasting');
  await click('.token-modal-head .icon-button');
  await click('.token-actions button:nth-child(2)');
  await waitFor(() => bodyHas('Receive TEST'), 'token receive dialog');
  await waitFor(() => evaluate(`!!document.querySelector('.qr-frame img')`), 'token receive QR image');
  const fullAddress = await evaluate('document.querySelector(".receive-token-content .full-address")?.textContent');
  assert(await bodyHas(fullAddress), 'Receive dialog must show the full public BSV address');
  await click('.token-modal-head .icon-button');
  await click('.token-actions button:nth-child(3)');
  await waitFor(() => bodyHas('TEST Locker'), 'token locker dialog');
  assert(await bodyHas('local lock schedule') && await bodyHas('Lock tokens into release tranches'), 'Locker dialog should show schedule and local tranche management');
  console.log('PASS: per-token Send, Receive QR/address, and Locker dialogs render safely');

  await evaluate(`Array.from(document.querySelectorAll('.nav-item')).find(button => button.innerText.includes('Trading'))?.click()`);
  await waitFor(() => bodyHas('ON-CHAIN BOOK'), 'on-chain trading order book');
  try { await waitFor(() => bodyHas('0.00002500'), 'fixture BSV-21 ask'); }
  catch (error) {
    console.error('Trading page diagnostics:', await evaluate(`JSON.stringify({ body: document.body?.innerText, selectedMarket: document.querySelector('[aria-label="Select token market"]')?.value, bridge: Object.keys(window.lbsx || {}) })`));
    throw error;
  }
  assert(await bodyHas('TEST / BSV') && await bodyHas('LIVE ORDER BOOK') && await bodyHas('My listings'), 'Trading page should show the selected BSV-21 market, order book, and owner listings');
  assert(await bodyHas('ADMIN WALLET DISCOVERY') && await bodyHas('LIVE ON CHAIN'), 'Trading page should show validated peer listings from the admin-wallet discovery feed');
  assert(await bodyHas('0.00500000 BSV') && await bodyHas('123.45 TEST'), 'Trading page should show synced confirmed BSV and token balances');
  await click('.market-buy-button');
  await waitFor(() => evaluate(`!!document.querySelector('.market-confirm-modal')`), 'buy review step');
  const buyReviewDetails = await evaluate(`document.querySelector('.market-confirm-modal')?.innerText || ''`);
  assert(buyReviewDetails.toLowerCase().includes('payment to seller') && buyReviewDetails.toLowerCase().includes('buy and receive bsv-21 token'), `Buy review should show payment and token delivery details: ${buyReviewDetails}`);
  await click('.market-confirm-modal .secondary-button');
  await click('.market-side-toggle button:nth-child(2)');
  await waitFor(() => bodyHas('Spendable token UTXO'), 'sell token quote');
  await fill('input[aria-label="Token amount to sell"]', '3.5');
  await fill('input[placeholder="0.00010000"]', '0.00005000');
  await click('.market-order-form .primary-button');
  await waitFor(() => evaluate(`!!document.querySelector('.market-confirm-modal')`), 'sell review step');
  assert(await bodyHas('On-chain OrdLock v2') && await bodyHas('List on chain'), 'Sell review must disclose the OrdLock transaction and explicit broadcast action');
  assert(await bodyHas('3.5 TEST') && await bodyHas('8.5 TEST'), 'Sell review must show the selected token amount and returned remainder');
  await click('.market-confirm-modal .primary-button');
  try { await waitFor(() => bodyHas('Sell listing broadcast:'), 'fixture sell broadcast response'); }
  catch (error) { console.error('Sell fixture diagnostics:', await evaluate(`document.body?.innerText`)); throw error; }
  await click('.market-cancel-button');
  await waitFor(() => evaluate(`!!document.querySelector('.market-confirm-modal')`), 'cancel review step');
  assert(await bodyHas('return token to this wallet'), 'Cancel review must show the token recovery destination');
  await click('.market-confirm-modal .primary-button');
  await waitFor(() => bodyHas('Cancellation broadcast:'), 'fixture cancellation response');
  console.log('PASS: Trading order book, buy/sell review flow, and owner-only listing cancellation render and complete with test fixtures');

  await evaluate(`Array.from(document.querySelectorAll('.nav-item')).find(button => button.innerText.includes('Send'))?.click()`);
  await waitFor(() => bodyHas('Send BSV'), 'functional BSV send page');
  await fill('input[placeholder="Paste a BSV mainnet address"]', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT');
  await fill('input[placeholder="0.00000000"]', '0.00010000');
  await fill('textarea[placeholder="Optional note stored publicly on-chain"]', 'desktop wallet e2e', 'HTMLTextAreaElement');
  await click('button[type="submit"]');
  await waitFor(() => bodyHas('Broadcast BSV'), 'BSV send review');
  assert(await bodyHas('0.0001 BSV') && await bodyHas('1BoatSLRHtKNngkdXEeobR76b53LETtpyT'), 'BSV review must show exact amount and recipient');
  await click('.send-review .primary-button');
  await waitFor(() => bodyHas('Broadcast accepted'), 'BSV send fixture broadcast');
  assert(await bodyHas('99'.repeat(32)), 'BSV send result must show the returned transaction id');
  console.log('PASS: BSV send form validates, reviews recipient/amount/note, and reports broadcast result');

  await click('.lock-button');
  await waitFor(() => bodyHas('protected by this computer'), 'manual lock screen');
  await click('form button[type="submit"]');
  await waitFor(() => bodyHas('Good to see you.'), 'manual passwordless open');
  await stopElectron();
  await startElectron(profile);
  try { await waitFor(() => bodyHas('Good to see you.'), 'automatic device-protected startup'); }
  catch (error) {
    console.error('Restart diagnostics:', await evaluate(`JSON.stringify({ body: document.body?.innerText, bridge: typeof window.lbsx })`));
    try { console.error('Vault status after restart:', JSON.stringify(await evaluate('window.lbsx.vaultStatus()'))); } catch (statusError) { console.error('Vault status error:', statusError.message); }
    throw error;
  }
  console.log('PASS: manual open and restart auto-unlock');
  await stopElectron();
}

async function importPhraseWithPassword(profile) {
  await startElectron(profile);
  await waitFor(() => bodyHas('Import your wallet'), 'password profile first-run screen');
  await fill('textarea', phrase, 'HTMLTextAreaElement');
  await click('.protection-option:nth-child(2)');
  await fill('input[placeholder="At least 12 characters"]', testPassword);
  await fill('input[placeholder="Re-enter your password"]', testPassword);
  await click('form button[type="submit"]');
  await waitFor(() => bodyHas('Good to see you.'), 'password-protected dashboard');
  const envelopeText = await readFile(path.join(profile, 'wallet-vault.json'), 'utf8');
  assert(!envelopeText.includes('abandon'), 'Password-protected vault must not store plaintext seed');
  console.log('PASS: password-protected import and encrypted storage');
  await stopElectron();

  await startElectron(profile);
  await waitFor(() => bodyHas('Welcome back'), 'password prompt after restart');
  await fill('input[placeholder="Enter your password"]', 'incorrect-password-123');
  await click('form button[type="submit"]');
  await waitFor(() => bodyHas('Check the password'), 'wrong-password rejection');
  await fill('input[placeholder="Enter your password"]', testPassword);
  await click('form button[type="submit"]');
  await waitFor(() => bodyHas('Good to see you.'), 'successful password unlock');
  console.log('PASS: restart prompts for password, rejects incorrect password, accepts correct password');
  await stopElectron();
}

try {
  vite = spawn(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', String(devPort)], { cwd: root, stdio: 'ignore' });
  await waitForVite();
  const deviceProfile = path.join(tempRoot, 'device');
  const passwordProfile = path.join(tempRoot, 'password');
  await importPhraseWithDeviceProtection(deviceProfile);
  await importPhraseWithPassword(passwordProfile);
  console.log('E2E smoke passed for both vault modes.');
} finally {
  await stopElectron();
  if (vite?.pid) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    } else vite.kill('SIGTERM');
  }
  const safeTempRoot = path.resolve(tempRoot);
  const requiredPrefix = path.resolve(os.tmpdir(), `lbsx-wallet-e2e-${process.pid}-`);
  if (safeTempRoot.startsWith(requiredPrefix)) await rm(safeTempRoot, { recursive: true, force: true });
}
