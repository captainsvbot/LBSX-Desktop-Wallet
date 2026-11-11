// Guards the removal of the inline attachment preview.
//
// A received file used to be rendered in an <img> tag inside the wallet. A
// sender could in principle use that rendering surface to attack the reader,
// and an SVG (which can carry script) is especially risky.
//
// The preview is now gone: attachments are SCANNED, not rendered. The only
// actions are [Virus Scan] and [Save].
//
// This test asserts the rendering surface cannot come back.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);

const pageSource = await readFile(new URL('../src/MailPage.jsx', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../src/MailPage.css', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const attachmentsSource = await readFile(new URL('../electron/mail-attachments.cjs', import.meta.url), 'utf8');

// The CODE, with the COMMENTS removed.
//
// A test that greps the raw source matches the word inside a comment too -
// and a comment that explains WHY a dangerous construct was removed is
// exactly the sort of thing that should be allowed to exist. The security
// assertions below are about CODE, so the comments are stripped first.
function stripComments(source) {
  return String(source)
    // Block comments.
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Line comments. The `//` inside a string - a url, for one - is not a
    // comment, so the match requires a character before it that cannot end
    // a string literal or a path.
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const pageCode = stripComments(pageSource);
const cssCode = stripComments(cssSource);
const mainCode = stripComments(mainSource);

console.log('=== NO INLINE ATTACHMENT RENDERING ===');

// --- 1. the renderer must not render an attachment as an image ---
assert.doesNotMatch(
  pageSource,
  /ml-attach-preview/,
  'the attachment preview must not exist',
);
assert.doesNotMatch(
  pageSource,
  /<img\s+src=\{preview\.url\}/,
  'an attachment must never be rendered in an img tag',
);
assert.doesNotMatch(
  pageSource,
  /createObjectURL/,
  'the renderer must not build a blob URL for an attachment',
);
assert.doesNotMatch(
  pageCode,
  /dangerouslySetInnerHTML|srcdoc|<iframe/,
  'no HTML injection surface may be introduced',
);

// --- 2. the actions must be Scan and Save ---
assert.match(
  pageSource,
  /Virus Scan/,
  'the scan action must be present',
);
assert.match(
  pageSource,
  /saveMailAttachment/,
  'the save action must be present',
);
assert.doesNotMatch(
  pageSource,
  />\s*Open\s*</,
  'the Open action must be gone',
);

// --- 3. the CSS must not carry preview styles ---
assert.doesNotMatch(
  cssSource,
  /\.ml-attach-preview/,
  'the preview styles must be removed',
);

// --- 4. the main process must decide what may be rendered ---
// The renderer is not trusted to make that decision: the main process
// determines the type from the decrypted bytes.
assert.match(
  mainSource,
  /renderInline:\s*result\.renderInline === true/,
  'the main process must pass its render decision to the renderer',
);
assert.match(
  attachmentsSource,
  /function canRenderInline/,
  'a helper that decides what may be rendered inline must exist',
);
assert.match(
  attachmentsSource,
  /INLINE_PREVIEW_MIME_TYPES/,
  'the allowed inline types must be an explicit allow-list',
);

// --- 5. the allow-list must exclude SVG ---
const allowList = attachmentsSource.match(/INLINE_PREVIEW_MIME_TYPES = new Set\(\[([\s\S]*?)\]\)/);
assert.ok(allowList, 'the allow-list must be findable');
assert.ok(
  !/svg/i.test(allowList[1]),
  'SVG must not be in the inline allow-list - it can carry script',
);
assert.ok(
  /image\/png/.test(allowList[1]),
  'PNG must be in the inline allow-list',
);

// --- 6. the renderer must not make its own rendering decision ---
// Since the preview is gone entirely, the renderer never renders an
// attachment at all. It must not contain any branch that decides to show
// file content.
assert.doesNotMatch(
  pageSource,
  /result\.renderInline/,
  'the renderer must not make a rendering decision at all',
);
assert.doesNotMatch(
  pageSource,
  /new Blob\(/,
  'the renderer must not build a blob from attachment bytes',
);

console.log('  no inline image rendering of attachments: OK');
console.log('  no HTML injection surface: OK');
console.log('  the actions are Scan and Save: OK');
console.log('  the render decision is made in the main process from the bytes: OK');
console.log('  SVG is excluded from the inline allow-list: OK');

console.log('');
console.log('PASS: attachments are scanned, never rendered inside the wallet');
