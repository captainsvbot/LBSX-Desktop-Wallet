// Converts the COMPOSE editor's HTML back into the plain-text markers that
// travel inside the encrypted mail envelope.
//
// The compose editor is a contenteditable region: it shows real bold, real
// italics and real lists, so the user never sees a raw `**`. What is sent is
// still the marker text, because that is what the reader's wallet renders and
// what must survive being encrypted and stored on chain.
//
// This is the INVERSE of `mailBodyToHtml` in mail-format.js. Those two
// functions must agree, so they are tested together.

const INLINE_WRAPPERS = {
  STRONG: '**',
  B: '**',
  EM: '_',
  I: '_',
  STRIKE: '~~',
  S: '~~',
  DEL: '~~',
  CODE: '`',
};

// A CODE BLOCK. The browser's "format block as pre" wraps the text in a
// <pre>, and the whole block is the code - so the marker goes around the
// block's text, not around each line of it.
function isCodeBlock(tag) {
  return tag === 'PRE';
}

// Serializes the inline content of a block element.
//
// The walk is recursive, so a bold run inside an italic run keeps both
// markers. The text is taken verbatim - the editor's own text is the truth.
function serializeInline(node) {
  if (node.nodeType === 3) return node.nodeValue || '';
  if (node.nodeType !== 1) return '';

  const tag = node.tagName;

  // A link keeps its target, so the reader gets a working link.
  if (tag === 'A') {
    let label = '';
    for (const child of node.childNodes) label += serializeInline(child);
    const href = node.getAttribute('href') || '';
    if (!label) return '';
    return `[${label}](${href})`;
  }

  const marker = INLINE_WRAPPERS[tag];
  if (marker) {
    // The INNER text is the element's own children - not the element itself,
    // which would recurse forever.
    let inner = '';
    for (const child of node.childNodes) inner += serializeInline(child);
    if (!inner) return '';
    return `${marker}${inner}${marker}`;
  }

  // A line break inside a block is a line break in the text.
  if (tag === 'BR') return '\n';

  let out = '';
  for (const child of node.childNodes) out += serializeInline(child);
  return out;
}

// The block elements the editor produces. A div is a paragraph in
// contenteditable, so it is treated as one.
const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE']);

function blockText(element) {
  // A LI is handled by the caller, because it carries a list marker.
  let out = '';
  for (const child of element.childNodes) {
    // A LIST nested inside a block keeps its markers. The browser nests a
    // list inside the paragraph it was made in - `<p><ul><li>...</li></ul></p>`
    // - and treating that list as plain inline text dropped the markers, so
    // the reply arrived with no bullet at all.
    if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) {
      out += serializeList(child);
      continue;
    }
    if (child.nodeType === 1 && BLOCK_TAGS.has(child.tagName)) {
      out += `${serializeInline(child)}\n`;
      continue;
    }
    out += serializeInline(child);
  }
  return out;
}

// Serializes a list - and a list nested inside a list - into marker lines.
function serializeList(list) {
  const lines = [];
  let index = 0;
  for (const item of list.childNodes) {
    if (item.nodeType !== 1 || item.tagName !== 'LI') continue;
    index += 1;
    const marker = list.tagName === 'OL' ? `${index}. ` : '- ';
    const text = blockText(item).replace(/\n+$/, '');
    for (const line of text.split('\n')) {
      lines.push(`${marker}${line}`);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// The CHARACTER OFFSETS of a range within an element's text.
//
// A range's `startOffset` is relative to the TEXT NODE it sits in, not to
// the element as a whole. The editor can hold several text nodes - one per
// paragraph, plus one per formatted run - so the offset has to be counted
// across ALL of them to be usable.
export function globalOffsetsFromRange(element, range) {
  if (!element || !range) return null;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let start = null;
  let end = null;
  let node;
  while ((node = walker.nextNode())) {
    const length = node.nodeValue.length;
    if (start === null && node === range.startContainer) {
      start = offset + range.startOffset;
    }
    if (node === range.endContainer) {
      end = offset + range.endOffset;
      break;
    }
    offset += length;
  }
  if (start === null || end === null) return null;
  return { start, end, text: range.toString() };
}

// Rebuilds a range from CHARACTER OFFSETS within an element's text.
//
// The offsets are measured over the element's text content. A saved DOM
// range cannot be used across a re-render, because the range's boundary
// nodes are detached by the time the user acts on it - which is what made a
// link get inserted at the end of the message instead of replacing the
// selected text. The offsets survive.
export function rangeFromOffsets(element, selection) {
  const range = document.createRange();
  if (!element || !selection) {
    range.selectNodeContents(element);
    range.collapse(false);
    return range;
  }
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode = null;
  let startOffset = 0;
  let endNode = null;
  let endOffset = 0;
  let node;
  while ((node = walker.nextNode())) {
    const length = node.nodeValue.length;
    if (startNode === null && offset + length >= selection.start) {
      startNode = node;
      startOffset = Math.max(0, selection.start - offset);
    }
    if (endNode === null && offset + length >= selection.end) {
      endNode = node;
      endOffset = Math.max(0, selection.end - offset);
      break;
    }
    offset += length;
  }
  if (!startNode || !endNode) {
    range.selectNodeContents(element);
    range.collapse(false);
    return range;
  }
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

// Converts the editor element into the marker text.
//
// The element is passed in rather than created here, so this module stays
// free of a DOM dependency and can be exercised in a test.
export function htmlToMailBody(element) {
  if (!element) return '';

  const lines = [];

  // Walks the editor's top-level blocks.
  const walk = (node, listPrefix) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) {
        // A stray text node at the top level is its own line.
        if (child.nodeType === 3 && (child.nodeValue || '').trim()) {
          lines.push(child.nodeValue);
        }
        continue;
      }
      const tag = child.tagName;
      if (tag === 'UL' || tag === 'OL') {
        const list = serializeList(child);
        if (list) lines.push(list.replace(/\n+$/, ''));
        continue;
      }
      if (isCodeBlock(tag)) {
        // A CODE BLOCK. The whole block is the code, so the marker wraps the
        // block's text once - not each line of it, and not the block's own
        // inner formatting.
        const code = blockText(child).replace(/\n+$/, '');
        if (code) lines.push('`' + code + '`');
        continue;
      }
      if (BLOCK_TAGS.has(tag)) {
        // A paragraph that holds only a <br> is a BLANK line, so it pushes an
        // empty line rather than a line that ends in a newline - otherwise
        // every blank line in the message would become two.
        const text = blockText(child).replace(/\n+$/, '');
        if (listPrefix) {
          lines.push(`${listPrefix}${text}`);
        } else {
          lines.push(text);
        }
        continue;
      }
      // Anything else is inline content, so it is its own line.
      const inline = serializeInline(child);
      if (inline.trim()) lines.push(inline);
    }
  };

  walk(element, '');

  // The trailing empty line the editor always keeps is not part of the text.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}
