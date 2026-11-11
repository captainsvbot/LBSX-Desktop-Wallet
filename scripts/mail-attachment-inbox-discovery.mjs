// Regression test for a bug that made attachments appear in SENT but not in
// INBOX.
//
// The receive path rebuilds messages from the wallet's activity rows. The
// projection that built those rows carried ONLY details.mailPayload and
// silently dropped details.mailAttachments, so a received mail arrived with
// no attachment refs and showed no attachments in the detail view.
//
// The sent path stores attachmentRefs directly in the snapshot, which is why
// sent mail showed attachments and received mail did not.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const walletDataSource = require('node:fs').readFileSync(
  new URL('../electron/wallet-data.cjs', import.meta.url), 'utf8',
);
const chainSource = require('node:fs').readFileSync(
  new URL('../electron/chain.cjs', import.meta.url), 'utf8',
);
const mailSource = require('node:fs').readFileSync(
  new URL('../electron/mail.cjs', import.meta.url), 'utf8',
);

console.log('=== RECEIVED-MAIL ATTACHMENT DISCOVERY ===');

// --- 1. the activity row must carry the attachment refs through ---
assert.match(
  walletDataSource,
  /mailAttachments:\s*row\.details\.mailAttachments\s*\|\|\s*\[\]/,
  'the activity row projection must carry details.mailAttachments through',
);

// The projection must NOT build a details object that drops the attachments.
const start = walletDataSource.indexOf('activityRows:');
assert.ok(start > 0, 'the activityRows projection must be findable');
const projection = walletDataSource.slice(start, start + 700);
assert.ok(
  /mailAttachments/.test(projection),
  'the activityRows projection must include mailAttachments',
);

// --- 2. the chain activity must attach the refs in the first place ---
assert.match(
  chainSource,
  /details\.mailAttachments\s*=\s*attachmentRefs/,
  'the chain activity must set details.mailAttachments',
);
assert.match(
  chainSource,
  /findAttachmentOutputs\(\{\s*outputs\s*\},\s*mailPayload\.messageId\)/,
  'the chain activity must discover the attachment outputs',
);

// --- 3. the receive path must use those refs ---
assert.match(
  mailSource,
  /const attachmentRefs = activity\?\.details\?\.mailAttachments \|\| \[\]/,
  'syncMail must read the attachment refs from the activity row',
);
assert.match(
  mailSource,
  /attachmentRefs,\s*\n\s*\}\);\s*\n\s*messages\.set\(payload\.messageId, decrypted\)/,
  'the decrypted message must be stored with the attachment refs',
);

// --- 4. the sender path must still store them directly ---
assert.match(
  mailSource,
  /attachmentCount:\s*attachmentOutputs\.length/,
  'the sent snapshot must record the attachment count',
);
assert.match(
  mailSource,
  /attachmentRefs:\s*attachmentOutputs\.map/,
  'the sent snapshot must record the attachment refs',
);

// --- 5. the message schema must keep them ---
assert.match(
  walletDataSource,
  /attachmentCount:\s*attachmentRefs\.length/,
  'the stored message must keep the attachment count',
);
assert.match(
  walletDataSource,
  /attachmentRefs,\s*\n\s*subject,/,
  'the stored message must keep the attachment refs',
);

console.log('  activity row carries mailAttachments: OK');
console.log('  chain activity sets details.mailAttachments: OK');
console.log('  syncMail reads the refs from the activity row: OK');
console.log('  sent path stores the refs directly: OK');
console.log('  message schema keeps them: OK');

// --- 6. a cached activity row without the field must be refreshed ---
assert.match(
  chainSource,
  /needsMailAttachmentRefresh\(existing\)/,
  'the cached-row reuse must check whether the attachment list needs a refresh',
);
assert.match(
  chainSource,
  /function needsMailAttachmentRefresh\(existing\)/,
  'the refresh helper must exist',
);
assert.match(
  chainSource,
  /!Array\.isArray\(existing\.details\.mailAttachments\)/,
  'a mail row without an attachment list must be treated as stale',
);

console.log('  stale cached rows are refreshed: OK');

console.log('');
console.log('PASS: a received mail carries its attachment refs, so attachments show in the inbox as well as in sent');
