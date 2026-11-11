// Mail search, sorting and day grouping.
//
// These live in their own module rather than inside the React page so they can
// be unit tested without a DOM, and so the renderer and any future tooling
// share exactly one implementation.
//
// The search supports Gmail-style operators:
//
//   from:<address>      to:<address>       subject:<text>
//   body:<text>         before:<date>       after:<date>
//   is:unread           is:read
//   has:attachment      (mail carries no attachments, so this matches nothing)
//
// Anything else is treated as plain text and matched against the sender,
// recipient, subject and body.

export const SNIPPET_LENGTH = 140;

export function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function formatDayLabel(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Unknown date';
  const today = startOfDay(new Date());
  const day = startOfDay(date);
  const days = Math.round((today - day) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString([], { month: 'long', day: 'numeric' });
  }
  return date.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
}

// Gmail-style row timestamp: a time for today, a weekday for this week, a
// day and month otherwise.
export function formatRowTime(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const today = startOfDay(new Date());
  const day = startOfDay(date);
  const days = Math.round((today - day) / 86400000);
  if (days === 0) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  }
  return date.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}

export function buildSnippet(body, subject) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (subject && text.toLowerCase().startsWith(subject.toLowerCase())) {
    return text.slice(subject.length).trim().slice(0, SNIPPET_LENGTH);
  }
  return text.slice(0, SNIPPET_LENGTH);
}

// Splits a query into tokens, keeping quoted phrases intact.
export function parseQuery(query) {
  const tokens = [];
  const pattern = /(\w+):("[^"]*"|\S*)|("[^"]*")|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(query || ''))) !== null) {
    if (match[1]) {
      tokens.push({ operator: match[1].toLowerCase(), value: (match[2] || '').replace(/^"|"$/g, '') });
    } else if (match[3]) {
      tokens.push({ operator: null, value: match[3].replace(/^"|"$/g, '') });
    } else if (match[4]) {
      tokens.push({ operator: null, value: match[4] });
    }
  }
  return tokens;
}

export function searchMessages(messages, query) {
  const text = String(query || '').trim();
  if (!text) return messages;
  const tokens = parseQuery(text);
  if (!tokens.length) return messages;

  return messages.filter(message => {
    for (const token of tokens) {
      const value = String(token.value || '').toLowerCase();
      if (!value && !token.operator) continue;
      switch (token.operator) {
        case 'from':
          if (!String(message.senderAddress || '').toLowerCase().includes(value)) return false;
          break;
        case 'to':
          if (!String(message.recipientAddress || '').toLowerCase().includes(value)) return false;
          break;
        case 'subject':
          if (!String(message.subject || '').toLowerCase().includes(value)) return false;
          break;
        case 'body':
          if (!String(message.body || '').toLowerCase().includes(value)) return false;
          break;
        case 'before': {
          const when = Date.parse(value);
          if (!Number.isFinite(when) || new Date(message.timestamp) >= new Date(when)) return false;
          break;
        }
        case 'after': {
          const when = Date.parse(value);
          if (!Number.isFinite(when) || new Date(message.timestamp) <= new Date(when)) return false;
          break;
        }
        case 'is':
          if (value === 'unread' && message.readAt) return false;
          if (value === 'read' && !message.readAt) return false;
          if (!['unread', 'read'].includes(value)) return false;
          break;
        case 'has':
          // Mail carries no attachments, so any has: filter matches nothing.
          return false;
        default: {
          const haystack = `${message.senderAddress || ''} ${message.recipientAddress || ''} ${message.subject || ''} ${message.body || ''}`.toLowerCase();
          if (!haystack.includes(value)) return false;
        }
      }
    }
    return true;
  });
}

export function sortMessages(messages, sort = 'newest') {
  const copy = [...messages];
  if (sort === 'oldest') {
    return copy.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  }
  if (sort === 'sender') {
    return copy.sort((a, b) => {
      const left = String(a.direction === 'sent' ? a.recipientAddress : a.senderAddress).toLowerCase();
      const right = String(b.direction === 'sent' ? b.recipientAddress : b.senderAddress).toLowerCase();
      return left.localeCompare(right) || String(b.timestamp).localeCompare(String(a.timestamp));
    });
  }
  return copy.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

export function groupByDay(messages) {
  const buckets = [];
  for (const message of messages) {
    const label = formatDayLabel(message.timestamp);
    const last = buckets[buckets.length - 1];
    if (last && last.label === label) last.messages.push(message);
    else buckets.push({ label, messages: [message] });
  }
  return buckets;
}

// Groups messages into CONVERSATION THREADS.
//
// A thread is identified by its root message id - the id of the FIRST message
// in the conversation. Every message in that conversation carries the same
// root, whether it was sent or received, so both sides of a conversation
// group the same messages together.
//
// Within a thread the messages are ordered OLDEST FIRST: the first message is
// where the conversation started and the newest is the latest response.
// The thread itself is placed in the list by its NEWEST message, so a thread
// with a fresh reply moves to the top.
export function groupThreads(messages) {
  const byRoot = new Map();
  for (const message of messages) {
    const root = String(message?.threadRootId || message?.messageId || '').toLowerCase();
    if (!root) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(message);
  }
  const threads = [];
  for (const [root, rows] of byRoot) {
    const ordered = rows.slice().sort((a, b) => {
      const timeDelta = String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
      if (timeDelta !== 0) return timeDelta;
      // Two messages in the same millisecond still need a stable order.
      return String(a.messageId).localeCompare(String(b.messageId));
    });
    const first = ordered[0];
    const latest = ordered[ordered.length - 1];
    threads.push({
      threadRootId: root,
      messages: ordered,
      messageCount: ordered.length,
      // The thread is shown with the FIRST message's subject and sender, so
      // the list reads as a conversation rather than as a pile of replies.
      subject: first.subject,
      senderAddress: first.senderAddress,
      recipientAddress: first.recipientAddress,
      direction: first.direction,
      timestamp: latest.timestamp,
      latestTimestamp: latest.timestamp,
      unreadCount: ordered.filter(row => !row.readAt).length,
    });
  }
  // Newest thread first, matching the "newest first" sort of the message list.
  threads.sort((a, b) => String(b.latestTimestamp || '').localeCompare(String(a.latestTimestamp || '')));
  return threads;
}


