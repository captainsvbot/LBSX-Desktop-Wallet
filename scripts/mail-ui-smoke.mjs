import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const executable = process.env.LBSX_PACKAGED_EXE
  ? path.resolve(process.env.LBSX_PACKAGED_EXE)
  : path.join(projectRoot, packageJson.build?.directories?.output || 'release-windows', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), `lbsx-mail-smoke-${process.pid}-`));
const profile = path.join(tempRoot, 'profile');
const debugPort = 9377;
let app;
let socket;
let requestId = 0;
const pending = new Map();

async function waitFor(check, label, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (_) {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function cdpCommand(method, params = {}) {
  const id = ++requestId;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}

async function evaluate(expression) {
  const response = await cdpCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Renderer threw an exception');
  return response.result.value;
}

try {
  app = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
    stdio: 'ignore',
    env: { ...process.env, LBSX_TEST_PACKAGED: '1', LBSX_TEST_USER_DATA_DIR: profile },
  });
  const target = await waitFor(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return pages.find(page => page.type === 'page' && page.url.startsWith('file://'));
    } catch (_) { return null; }
  }, 'the packaged app window');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  await cdpCommand('Runtime.enable');

  // The app opens on the import screen because the test profile has no vault.
  // Import a throwaway wallet through the same path a user would use, then
  // navigate to the Email tab.
  await waitFor(async () => evaluate('document.body && document.body.innerText.length > 0'), 'the renderer to boot');

  const gate = await evaluate("document.querySelector('.gate-form') ? 'import' : 'other'");
  if (gate === 'import') {
    await evaluate(`(() => {
      const textarea = document.querySelector('.gate-form textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await delay(300);
    await evaluate("document.querySelector('.gate-form button[type=submit], .gate-submit').click()");
    await waitFor(
      async () => evaluate("!!document.querySelector('.sidebar')"),
      'the app shell to appear after the import',
      60000,
    );
    await delay(1200);
  }

  // --- the nav contains an Email entry ---
  const navLabels = await evaluate("Array.from(document.querySelectorAll('.nav-item span')).map(n => n.textContent)");
  assert.ok(Array.isArray(navLabels), 'the sidebar nav must render');
  assert.ok(navLabels.includes('Email'), `the sidebar must contain an Email tab, saw: ${JSON.stringify(navLabels)}`);

  // --- click through to the Email page and confirm it renders ---
  await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
  await delay(900);

  const emailState = await evaluate(`(() => {
    const heading = document.querySelector('.ml-page-title h1');
    return {
      heading: heading ? heading.textContent : null,
      badge: document.querySelector('.ml-encrypted-badge')?.textContent || null,
      tabs: Array.from(document.querySelectorAll('.ml-tabs button')).map(b => b.textContent.trim()),
      infoButton: !!document.querySelector('.ml-info-button'),
      compose: !!document.querySelector('.ml-primary-button'),
      errors: Array.from(document.querySelectorAll('.ml-error')).map(e => e.textContent),
    };
  })()`);

  assert.equal(emailState.heading, 'Email', 'the Email page must render its heading');
  assert.ok(/End-to-end encrypted/i.test(emailState.badge || ''), 'the Email page must show the encrypted badge');
  assert.ok(emailState.tabs.some(t => /Inbox/.test(t)), 'the Email page must have an Inbox tab');
  assert.ok(emailState.tabs.some(t => /Sent/.test(t)), 'the Email page must have a Sent tab');
  assert.ok(emailState.infoButton, 'the Email page must have the disclosure button');
  assert.deepEqual(emailState.errors, [], 'the Email page must not render errors on load');

  // --- the disclosure panel states the honest limits ---
  await evaluate("document.querySelector('.ml-info-button').click()");
  await delay(400);
  const disclosure = await evaluate("document.querySelector('.ml-info-panel')?.innerText || ''");
  assert.ok(/message body is private/i.test(disclosure), 'the disclosure must state the body is private');
  assert.ok(/metadata is public/i.test(disclosure), 'the disclosure must state the metadata is public');
  assert.ok(/forward secrecy/i.test(disclosure), 'the disclosure must state there is no forward secrecy');

  // --- the contacts panel renders ---
  const contactsPresent = await evaluate("!!document.querySelector('.ml-contacts-panel')");
  assert.ok(contactsPresent, 'the Email page must render the contacts panel');

  console.log('PASS: the Email tab renders in the packaged app with inbox/sent tabs, the encrypted badge, and the honest disclosure panel');
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
