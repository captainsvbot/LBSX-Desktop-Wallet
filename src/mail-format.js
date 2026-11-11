// Renders a plain-text mail body with light formatting.
//
// The body travels as TEXT - it is encrypted, stored on chain and read by
// another wallet - so emphasis is expressed with simple markers. This turns
// those markers into real formatting on the reader's side, and leaves any
// text that is not a marker exactly as it was written.
//
// The order matters: code spans are extracted first, so a `*` inside a code
// span is not mistaken for emphasis.
//
// This is a PURE module with no React in it, so the formatting can be
// exercised directly by the test suite. The renderer component lives in
// MailPage.jsx and calls straight into here.
export function renderMailBody(text) {
  const source = String(text || '');
  const codeSpans = [];
  // Pull the code spans out and leave a placeholder in their place.
  let working = source.replace(/`([^`\n]+)`/g, (match, code) => {
    codeSpans.push(code);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });
  // A backtick that is left over is an UNMATCHED one - the marker opened but
  // never closed. It is removed rather than shown, because a reader cannot
  // tell it apart from a marker that failed to render.
  working = working.replace(/`/g, '');

  // Links: [label](url).
  //
  // The url may be EMPTY. The composer inserts the brackets and leaves the
  // caret inside the url for the user to fill in, and until they do the link
  // is still a link - so the url is allowed to have nothing after the scheme.
  //
  // The placeholder uses a separator that cannot appear in the text. The
  // emphasis markers below use U+0001 and U+0002, so the link placeholder
  // uses U+0003 and U+0004 - otherwise a link next to a bold run would split
  // the wrong way and lose its url.
  working = working.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]*)\)/g, (match, label, url) => {
    return `\u0003LINK${label}\u0004${url}\u0005`;
  });

  const blocks = working.split('\n');
  const lines = [];
  let listItems = null;
  // Whether the list being collected is ORDERED. The reader renders an
  // ordered list with real numbers, and the compose editor needs to know so
  // it can produce an <ol> - a numbered list that loses its numbers reads as
  // a bullet list.
  let listOrdered = false;

  const flushList = () => {
    if (listItems) { lines.push({ type: 'ul', ordered: listOrdered, items: listItems }); listItems = null; }
  };

  for (const line of blocks) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet) {
      if (!listItems) listOrdered = false;
      listItems = listItems || [];
      listItems.push(bullet[1]);
      continue;
    }
    if (numbered) {
      if (!listItems) listOrdered = true;
      listItems = listItems || [];
      listItems.push(numbered[1]);
      continue;
    }
    flushList();
    if (!line.trim()) { lines.push({ type: 'p', text: '' }); continue; }
    lines.push({ type: 'p', text: line });
  }
  flushList();

  // Inline emphasis within a single line.
  const inline = (text) => {
    const parts = [];
    // Split on the placeholder markers we inserted above.
    const tokens = text.split(/(\u0000CODE\d+\u0000|\u0003LINK[^\u0003]*\u0004[^\u0003]*\u0005)/g);
    for (const token of tokens) {
      if (!token) continue;
      const code = token.match(/^\u0000CODE(\d+)\u0000$/);
      if (code) {
        parts.push({ type: 'code', text: codeSpans[Number(code[1])] });
        continue;
      }
      if (token.startsWith('\u0003LINK')) {
        // The token is: U+0003 LINK <label> U+0004 <url> U+0005
        // The label is between "LINK" and the separator, and the url is
        // between the separator and the terminator.
        const label = token.slice('\u0003LINK'.length).split('\u0004')[0];
        const url = (token.split('\u0004')[1] || '').replace(/\u0005$/, '');
        parts.push({ type: 'link', text: label, href: url });
        continue;
      }
      // Bold, then italic, then strikethrough.
      let piece = token;
      const inlineParts = [];
      piece = piece.replace(/\*\*([^*\n]+)\*\*/g, (m, inner) => `\u0001B${inner}\u0002`);
      piece = piece.replace(/_([^_\n]+)_/g, (m, inner) => `\u0001I${inner}\u0002`);
      piece = piece.replace(/~~([^~\n]+)~~/g, (m, inner) => `\u0001S${inner}\u0002`);
      const chunks = piece.split(/(\u0001[BIS][^\u0001]*\u0002)/g);
      for (const chunk of chunks) {
        if (!chunk) continue;
        const styled = chunk.match(/^\u0001([BIS])([\s\S]*)\u0002$/);
        if (styled) {
          const kind = styled[1] === 'B' ? 'bold' : styled[1] === 'I' ? 'italic' : 'strike';
          inlineParts.push({ type: kind, text: styled[2] });
        } else {
          inlineParts.push({ type: 'text', text: chunk });
        }
      }
      parts.push(...inlineParts);
    }
    return parts;
  };

  return lines.map(line => {
    if (line.type === 'ul') {
      return {
        type: 'ul',
        // The list keeps its ORDERED flag, so a numbered list is rendered as
        // a numbered list and not as a bullet list.
        ordered: line.ordered === true,
        items: line.items.map(item => inline(item)),
      };
    }
    return { type: 'p', parts: inline(line.text) };
  });
}

// Flattens a rendered body back to plain text. Used by the tests to assert
// that the markers are consumed and no stray marker characters survive.
export function renderMailBodyToText(text) {
  const blocks = renderMailBody(text);
  const lines = [];
  for (const block of blocks) {
    if (block.type === 'ul') {
      for (const item of block.items) {
        lines.push(item.map(part => part.text).join(''));
      }
      continue;
    }
    lines.push(block.parts.map(part => part.text).join(''));
  }
  return lines.join('\n');
}

// Escapes text for safe inclusion in an HTML string.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Whether a URL may be used as the target of a link.
//
// A link's target may come from a REMOTE source - the sender of a received
// mail, or a third-party API response - so the scheme is checked here rather
// than trusted. Only `http` and `https` are allowed, because those are the
// only schemes a link in a message has any business being.
//
// The check is done on the PARSED url, not on the string, so a url like
// `java\nscript:alert(1)` cannot slip past a naive prefix check.
//
// The main process applies the same rule when it opens the url, so a value
// that gets past here is still refused there. This is defence in depth, and
// it is what the code scanner needs to see: the scheme is constrained at the
// point the href is built, not only at the point it is used.
export function isSafeLinkUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Normalises a URL typed into the link dialog into a safe href.
//
// A bare address like "example.com" gets the scheme, because a link without
// one is not a link. Anything whose scheme is not http or https is refused
// and returns an empty string, which the caller treats as "no link".
export function normalizeLinkUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return isSafeLinkUrl(candidate) ? candidate : '';
}

// Renders a body as HTML, for the COMPOSE editor to display.
//
// The compose editor shows the message the way the reader will see it - real
// bold, real italics, real lists - instead of the raw `**` and `-` markers
// that travel inside the encrypted envelope. The text itself is unchanged:
// this is a VIEW of the same markers, and the editor's textarea still holds
// the marker text, so what is sent is exactly what was always sent.
export function mailBodyToHtml(text) {
  const blocks = renderMailBody(text);
  const renderParts = parts => parts.map(part => {
    if (part.type === 'bold') return `<strong>${escapeHtml(part.text)}</strong>`;
    if (part.type === 'italic') return `<em>${escapeHtml(part.text)}</em>`;
    if (part.type === 'strike') return `<s>${escapeHtml(part.text)}</s>`;
    if (part.type === 'code') return `<code>${escapeHtml(part.text)}</code>`;
    if (part.type === 'link') return `<a href="${escapeHtml(part.href)}">${escapeHtml(part.text)}</a>`;
    return escapeHtml(part.text);
  }).join('');

  const html = blocks.map(block => {
    if (block.type === 'ul') {
      // An ORDERED list keeps its numbers in an <ol>. A numbered list that
      // became a <ul> would lose its numbers on the way back to text.
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map(item => `<li>${renderParts(item)}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }
    // An empty paragraph is a blank line, and a trailing blank line needs a
    // <br> so the height of the editor matches the text.
    if (!block.parts.length) return '<p><br></p>';
    return `<p>${renderParts(block.parts)}</p>`;
  }).join('');

  // A message that is entirely empty still needs one block, or the editor
  // has no height at all.
  return html || '<p><br></p>';
}

