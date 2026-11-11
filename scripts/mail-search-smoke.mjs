import assert from 'node:assert/strict';
import { searchMessages, sortMessages, groupByDay } from '../src/mail-search.js';

const sender = '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE';
const recipient = '1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut';
const other = '16CppiXJHnhh9kh1UburhnRdPabKwaqsVP';

function message(overrides = {}) {
  return {
    messageId: 'a'.repeat(64),
    direction: 'received',
    senderAddress: sender,
    recipientAddress: recipient,
    subject: 'Contract signing',
    body: 'Meet at 0900 and bring the signed contract.',
    timestamp: '2026-11-09T12:00:00.000Z',
    readAt: null,
    status: 'confirmed',
    ...overrides,
  };
}

const messages = [
  message({ messageId: '1'.repeat(64), subject: 'Contract signing', timestamp: '2026-11-09T12:00:00.000Z', body: 'Meet at 0900 and bring the signed contract.' }),
  message({ messageId: '2'.repeat(64), subject: 'Invoice for October', timestamp: '2026-11-01T09:30:00.000Z', body: 'Invoice attached, please review the line items.', readAt: '2026-11-02T00:00:00.000Z' }),
  message({ messageId: '3'.repeat(64), subject: 'Old thread', timestamp: '2026-08-14T18:00:00.000Z', body: 'This is an older conversation about the contract.', senderAddress: other, readAt: '2026-08-15T00:00:00.000Z' }),
];

// --- plain text search ---
assert.equal(searchMessages(messages, 'invoice', 'inbox').length, 1, 'plain text matches the subject');
assert.equal(searchMessages(messages, 'contract', 'inbox').length, 2, 'plain text matches subject and body');
assert.equal(searchMessages(messages, 'nothing here', 'inbox').length, 0, 'a non-matching term returns nothing');
assert.equal(searchMessages(messages, '', 'inbox').length, 3, 'an empty query returns everything');

// --- operators ---
assert.equal(searchMessages(messages, `from:${other}`, 'inbox').length, 1, 'from: filters by sender');
assert.equal(searchMessages(messages, `to:${recipient}`, 'inbox').length, 3, 'to: filters by recipient');
assert.equal(searchMessages(messages, 'subject:invoice', 'inbox').length, 1, 'subject: filters by subject');
assert.equal(searchMessages(messages, 'subject:"old thread"', 'inbox').length, 1, 'quoted subject: works');
assert.equal(searchMessages(messages, 'is:unread', 'inbox').length, 1, 'is:unread finds unread mail');
assert.equal(searchMessages(messages, 'is:read', 'inbox').length, 2, 'is:read finds read mail');
assert.equal(searchMessages(messages, 'after:2026-10-01', 'inbox').length, 2, 'after: filters by date');
assert.equal(searchMessages(messages, 'before:2026-10-01', 'inbox').length, 1, 'before: filters by date');
assert.equal(searchMessages(messages, 'has:attachment', 'inbox').length, 0, 'mail has no attachments, so has: matches nothing');

// --- combined operators ---
assert.equal(searchMessages(messages, 'contract after:2026-10-01', 'inbox').length, 1, 'operators combine');
assert.equal(searchMessages(messages, 'from:someone contract', 'inbox').length, 0, 'a wrong from: excludes the match');

// --- sorting ---
const newest = sortMessages(messages, 'newest');
assert.equal(newest[0].timestamp, '2026-11-09T12:00:00.000Z', 'newest first puts the latest message first');
const oldest = sortMessages(messages, 'oldest');
assert.equal(oldest[0].timestamp, '2026-08-14T18:00:00.000Z', 'oldest first puts the earliest message first');
const bySender = sortMessages(messages, 'sender');
assert.equal(bySender[0].senderAddress, other, 'by sender sorts alphabetically');
// sorting must not mutate the input
assert.equal(messages[0].timestamp, '2026-11-09T12:00:00.000Z', 'sorting must not mutate the source array');

// --- day grouping ---
const groups = groupByDay(messages);
assert.ok(groups.length >= 3, 'messages on different days land in different groups');
assert.equal(groups[0].messages.length, 1, 'each of these messages is on its own day');
assert.ok(typeof groups[0].label === 'string' && groups[0].label.length, 'groups carry a label');

// two messages on the same day group together
const sameDay = [
  message({ messageId: '4'.repeat(64), timestamp: '2026-11-09T08:00:00.000Z' }),
  message({ messageId: '5'.repeat(64), timestamp: '2026-11-09T20:00:00.000Z' }),
];
const sameDayGroups = groupByDay(sameDay);
assert.equal(sameDayGroups.length, 1, 'two messages on the same day share one group');
assert.equal(sameDayGroups[0].messages.length, 2, 'both messages are in that group');

console.log('PASS: mail search operators, sorting and day grouping all behave correctly');
