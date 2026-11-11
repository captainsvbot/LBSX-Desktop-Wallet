// Guards the attachment SAVE path.
//
// Without a matching file-type filter, the OS save dialog can silently drop
// the extension, so the user ends up with a file they have to rename by hand.
// The extension must be derived from the name and the MIME type, and applied
// to the chosen path regardless of what the dialog returns.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  safeAttachmentName,
  attachmentExtension,
  attachmentDefaultName,
  attachmentFinalPath,
} = require('../electron/attachment-file-name.cjs');

console.log('=== ATTACHMENT SAVE PATH ===');

// --- the extension survives a name that has one ---
assert.equal(attachmentExtension('email v2.png', 'image/png'), '.png');
assert.equal(attachmentExtension('photo.jpg', 'image/jpeg'), '.jpg');
assert.equal(attachmentExtension('contract.PDF', 'application/pdf'), '.pdf');

// --- the extension comes from the MIME type when the name has none ---
assert.equal(attachmentExtension('screenshot', 'image/png'), '.png');
assert.equal(attachmentExtension('document', 'application/pdf'), '.pdf');
assert.equal(attachmentExtension('data', 'application/json'), '.json');

// --- an unknown type falls back to a binary extension ---
assert.equal(attachmentExtension('blob', 'application/octet-stream'), '.bin');
assert.equal(attachmentExtension('blob', ''), '.bin');

// --- the dialog default name always carries the extension ---
assert.equal(attachmentDefaultName('email v2.png', 'image/png'), 'email v2.png');
assert.equal(attachmentDefaultName('screenshot', 'image/png'), 'screenshot.png');
assert.equal(attachmentDefaultName('email v2.png', 'image/png'), 'email v2.png');

// --- spaces in the name are preserved, so the file reads naturally ---
assert.equal(safeAttachmentName('email v2.png'), 'email v2.png');
assert.equal(safeAttachmentName('my report.pdf'), 'my report.pdf');

// --- path traversal and OS-forbidden characters are neutralised ---
assert.equal(safeAttachmentName('../../etc/passwd'), 'passwd');
assert.equal(safeAttachmentName('a/b/c.png'), 'c.png');
assert.equal(safeAttachmentName('bad:name?.png'), 'bad_name_.png');
assert.equal(safeAttachmentName('..'), 'attachment', 'a bare .. must not survive');
assert.equal(safeAttachmentName('.hidden.png'), 'hidden.png', 'a leading dot is stripped');
assert.equal(safeAttachmentName(''), 'attachment');
assert.ok(!safeAttachmentName('x'.repeat(300)).includes('x'.repeat(200)), 'the name is length limited');

// --- the extension is guaranteed on the final path ---
// This is the exact case that lost the extension: the dialog returned a path
// with no extension.
assert.equal(
  attachmentFinalPath('C:/Users/Elton/Desktop/1email_v2', 'email v2.png', 'image/png'),
  'C:/Users/Elton/Desktop/1email_v2.png',
  'the extension must be added when the dialog dropped it',
);
// A path that already has the right extension is left alone.
assert.equal(
  attachmentFinalPath('C:/Users/Elton/Desktop/email v2.png', 'email v2.png', 'image/png'),
  'C:/Users/Elton/Desktop/email v2.png',
  'a path that already has the extension must not be changed',
);
// A path with a DIFFERENT extension is corrected.
assert.equal(
  attachmentFinalPath('C:/Users/Elton/Desktop/thing.txt', 'email v2.png', 'image/png'),
  'C:/Users/Elton/Desktop/thing.txt.png',
  'a wrong extension must be corrected',
);

console.log('  extension derived from the name and MIME type: OK');
console.log('  the extension is guaranteed on the saved path: OK');
console.log('  spaces preserved, traversal blocked: OK');

console.log('');
console.log('PASS: a saved attachment always keeps its file extension');
