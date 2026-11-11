// The attachment save path must keep the file's extension.
//
// Without a matching file-type filter, the OS save dialog can silently drop
// the extension, and the user is left with a file they have to rename by
// hand. The extension is derived from the name and the MIME type, and is
// applied to the chosen path regardless of what the dialog returns.

const EXTENSION_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/html': '.html',
  'text/markdown': '.md',
  'application/json': '.json',
};

const path = require('node:path');

// Sanitises a name for use on disk: no path separators, no characters the
// OS forbids, no directory traversal. Spaces and dots are preserved.
function safeAttachmentName(fileName) {
  const base = path.basename(String(fileName || 'attachment'))
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return base || 'attachment';
}

// The extension to use: the name's own extension if it has one, otherwise
// the one implied by the MIME type.
function attachmentExtension(fileName, mimeType) {
  const nameExtension = path.extname(safeAttachmentName(fileName)).toLowerCase();
  if (nameExtension) return nameExtension;
  return EXTENSION_BY_MIME[String(mimeType || '').toLowerCase()] || '.bin';
}

// The name the save dialog is opened with.
function attachmentDefaultName(fileName, mimeType) {
  const safe = safeAttachmentName(fileName);
  const extension = attachmentExtension(safe, mimeType);
  const base = path.basename(safe, path.extname(safe)) || 'attachment';
  return `${base}${extension}`;
}

// The path actually written to, with the extension guaranteed.
function attachmentFinalPath(chosenPath, fileName, mimeType) {
  const extension = attachmentExtension(fileName, mimeType);
  const target = String(chosenPath || '');
  if (!target) return target;
  return path.extname(target).toLowerCase() === extension.toLowerCase()
    ? target
    : `${target}${extension}`;
}

module.exports = {
  safeAttachmentName,
  attachmentExtension,
  attachmentDefaultName,
  attachmentFinalPath,
  EXTENSION_BY_MIME,
};
