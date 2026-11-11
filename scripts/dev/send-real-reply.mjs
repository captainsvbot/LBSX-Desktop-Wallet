// Types a reply into the running app's compose editor and sends it.
//
// The text is entered through the React-controlled textarea's native setter
// plus an input event, so the component's state actually updates - a plain
// .value assignment is ignored by React.
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 9505;
let socket;
let requestId = 0;
const pending = new Map();

async function waitFor(check, label, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (_) { /* keep waiting */ }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function cdp(method, params = {}) {
  const id = ++requestId;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.text).slice(0, 300) };
  return r.result.value;
}

const BODY = [
  'Yes — 12:30 works for me.',
  '',
  'The new place near the office is exactly the kind of coffee I have been looking for, so I am in.',
  '',
  'One thing to add: I tested the **threaded reply** on this conversation. The reply stays attached to this message, so both sides see one continuous exchange rather than a pile of separate mails.',
  '',
  'See you at 12:30.',
].join('\n');

try {
  const target = await waitFor(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return pages.find(page => page.type === 'page' && page.webSocketDebuggerUrl);
  }, 'the renderer target');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });

  await waitFor(async () => evaluate('!!window.lbsx'), 'the lbsx bridge');

  // The compose overlay must be open.
  const open = await evaluate(`Boolean(document.querySelector('.ml-compose-editor textarea'))`);
  if (!open) throw new Error('The compose overlay is not open.');

  // Type the body through the native setter so React sees the change.
  const typed = await evaluate(`(function () {
    var ta = document.querySelector('.ml-compose-editor textarea');
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(BODY)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    return ta.value.length;
  })()`);
  console.log('typed chars:', typed);
  await delay(700);

  // Confirm React actually took it: the byte counter must have moved.
  const counter = await evaluate(`(function () {
    var el = document.querySelector('.ml-compose-count');
    return el ? el.innerText : 'no counter';
  })()`);
  console.log('byte counter:', counter);

  // Send it. The button is disabled until there is a body, so it must be live.
  const canSend = await evaluate(`(function () {
    var b = document.querySelector('.ml-compose-send');
    return b ? String(b.disabled) : 'no button';
  })()`);
  console.log('send disabled:', canSend);

  const result = await evaluate(`(async function () {
    var b = document.querySelector('.ml-compose-send');
    if (!b) return 'no send button';
    b.click();
    return 'clicked';
  })()`);
  console.log('send:', result);

  // Wait for the broadcast to be acknowledged.
  await delay(6000);
  const after = await evaluate(`(function () {
    return JSON.stringify({
      overlayClosed: !document.querySelector('.ml-compose-overlay'),
      notice: (document.querySelector('.ml-notice') || {}).innerText || '',
      sentCount: (function () {
        var b = [...document.querySelectorAll('.ml-subnav-item')].find(function (x) { return x.innerText.indexOf('Sent') === 0; });
        return b ? b.innerText.replace(/\\n/g, ' ') : '';
      })(),
    });
  })()`);
  console.log('after send:', after);
} catch (error) {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch (_) { /* ignore */ }
}
