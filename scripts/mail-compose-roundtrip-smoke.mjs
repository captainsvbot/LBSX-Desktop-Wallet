// Tests the COMPOSE EDITOR ROUND TRIP.
//
// The compose editor is a contenteditable region: it shows real bold, real
// italics and real lists, and what is SENT is still the marker text that
// travels inside the encrypted envelope.
//
// So the round trip has to hold:
//
//   marker text -> HTML (what the editor shows)
//   HTML       -> marker text (what is sent)
//
// If those two disagree, the message the user composed is not the message
// the recipient reads.
//
// The HTML is built with a tiny DOM shim, because the serializer is written
// against the DOM interface and a real DOM is not available here.
import assert from 'node:assert/strict';
import { mailBodyToHtml } from '../src/mail-format.js';
import { htmlToMailBody } from '../src/mail-compose.js';

console.log('=== COMPOSE EDITOR ROUND TRIP ===');

// ---------------------------------------------------------------------------
// A minimal DOM, enough for the serializer.
// ---------------------------------------------------------------------------
class FakeNode {
  constructor(nodeType, tagName, nodeValue) {
    this.nodeType = nodeType;
    this.tagName = tagName;
    this.nodeValue = nodeValue;
    this.childNodes = [];
  }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue;
    return this.childNodes.map(child => child.textContent).join('');
  }
}

class FakeElement extends FakeNode {
  constructor(tagName, attributes = {}) {
    super(1, tagName, null);
    this.attributes = attributes;
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  append(...children) {
    this.childNodes.push(...children);
  }
}

const text = value => new FakeNode(3, null, value);
const el = (tag, attributes, ...children) => {
  const node = new FakeElement(tag, attributes);
  node.append(...children);
  return node;
};

// Builds an editor element from a simple description.
const editor = (...blocks) => {
  const root = new FakeElement('DIV');
  root.append(...blocks);
  return root;
};

// ---------------------------------------------------------------------------
// 1. A PLAIN paragraph.
// ---------------------------------------------------------------------------
{
  const html = mailBodyToHtml('Hello there');
  assert.ok(html.includes('Hello there'), 'the html must hold the text');
  const back = htmlToMailBody(editor(el('P', {}, text('Hello there'))));
  assert.equal(back, 'Hello there');
  console.log('  a plain paragraph: OK');
}

// ---------------------------------------------------------------------------
// 2. BOLD.
//
// The editor holds <strong> and the sent text must be **bold**.
// ---------------------------------------------------------------------------
{
  const back = htmlToMailBody(editor(el('P', {}, text('This is '), el('STRONG', {}, text('bold')), text(' text'))));
  assert.equal(back, 'This is **bold** text');
  console.log('  bold: OK');
}

// ---------------------------------------------------------------------------
// 3. ITALIC and CODE.
// ---------------------------------------------------------------------------
{
  const back = htmlToMailBody(editor(el('P', {}, el('EM', {}, text('italic')), text(' and '), el('CODE', {}, text('code')))));
  assert.equal(back, '_italic_ and `code`');
  console.log('  italic and code: OK');
}

// ---------------------------------------------------------------------------
// 4. A LINK.
// ---------------------------------------------------------------------------
{
  const back = htmlToMailBody(editor(el('P', {}, text('see '), el('A', { href: 'https://example.com' }, text('docs')))));
  assert.equal(back, 'see [docs](https://example.com)');
  console.log('  a link: OK');
}

// ---------------------------------------------------------------------------
// 5. A BULLET list.
// ---------------------------------------------------------------------------
{
  const back = htmlToMailBody(editor(el('UL', {},
    el('LI', {}, text('one')),
    el('LI', {}, text('two')),
  )));
  assert.equal(back, '- one\n- two');
  console.log('  a bullet list: OK');
}

// ---------------------------------------------------------------------------
// 6. A NUMBERED list.
//
// The number has to COUNT UP - the reader renders the numbers, so they must
// be in the text in order.
// ---------------------------------------------------------------------------
{
  const back = htmlToMailBody(editor(el('OL', {},
    el('LI', {}, text('first')),
    el('LI', {}, text('second')),
    el('LI', {}, text('third')),
  )));
  assert.equal(back, '1. first\n2. second\n3. third');
  console.log('  a numbered list: OK');
}

// ---------------------------------------------------------------------------
// 7. PARAGRAPHS.
// ---------------------------------------------------------------------------
{
  const back = htmlToMailBody(editor(
    el('P', {}, text('first para')),
    el('P', {}, text('second para')),
  ));
  assert.equal(back, 'first para\nsecond para');
  console.log('  paragraphs: OK');
}

// ---------------------------------------------------------------------------
// 8. The FULL round trip.
//
// The text that is SENT must render back to the same text the user saw. This
// is the property that matters: what the user composed is what the recipient
// reads.
// ---------------------------------------------------------------------------
{
  const original = '**Bold** and _italic_ and `code`\n\n- one\n- two\n\n1. first\n2. second';
  const html = mailBodyToHtml(original);

  // Turn the html back into editor DOM.
  // A small HTML parser: it walks the tags and builds the tree.
  const root = new FakeElement('DIV');
  const stack = [root];
  let buffer = '';
  const flush = () => {
    if (!buffer) return;
    stack[stack.length - 1].append(text(buffer));
    buffer = '';
  };
  const tagRe = /<(\/?)([a-z0-9]+)([^>]*?)(\/?)>/gi;
  let match;
  let cursor = 0;
  while ((match = tagRe.exec(html)) !== null) {
    // The text BETWEEN the previous tag and this one is content, and it has
    // to be collected before the tag is handled.
    buffer += html.slice(cursor, match.index);
    cursor = tagRe.lastIndex;
    const [, closing, tagName, attrs, selfClosing] = match;
    if (closing) {
      flush();
      if (stack.length > 1) stack.pop();
      continue;
    }
    flush();
    const attributes = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let attr;
    while ((attr = attrRe.exec(attrs || '')) !== null) attributes[attr[1]] = attr[2];
    if (tagName.toLowerCase() === 'br') {
      stack[stack.length - 1].append(el('BR', {}));
      continue;
    }
    const node = el(tagName.toUpperCase(), attributes);
    stack[stack.length - 1].append(node);
    if (!selfClosing) stack.push(node);
  }
  buffer += html.slice(cursor);
  flush();

  const back = htmlToMailBody(root);
  assert.equal(back, original, `the round trip must be exact:\n  in:  ${JSON.stringify(original)}\n  out: ${JSON.stringify(back)}`);
  console.log('  the full round trip: OK');
}

// ---------------------------------------------------------------------------
// 12. A list NESTED INSIDE A PARAGRAPH.
//
// This is the shape the BROWSER produces: when the user applies a list to a
// paragraph, the browser nests the list inside it - `<p><ul><li>..</li></ul></p>`.
// Treating that list as plain inline text dropped the marker, so a reply sent
// with a bullet arrived with NO bullet at all.
// ---------------------------------------------------------------------------
{
  const back = htmlToMailBody(editor(
    el('P', {}, el('UL', {}, el('LI', {}, text('Build awesome things')))),
  ));
  assert.equal(back, '- Build awesome things');
  console.log('  a list nested inside a paragraph: OK');
}

// ---------------------------------------------------------------------------
// 13. A list nested inside a paragraph, with the browser's own empty
//     paragraphs around it - the exact markup the editor produced.
// ---------------------------------------------------------------------------
{
  const back = htmlToMailBody(editor(
    el('P', {}, el('BR', {})),
    el('P', {}, el('UL', {}, el('LI', {}, text('Build awesome things')))),
  ));
  assert.equal(back, '\n- Build awesome things');
  console.log('  a nested list between paragraphs: OK');
}

// ---------------------------------------------------------------------------
// 14. An ORDERED list nested inside a paragraph keeps its NUMBER.
// ---------------------------------------------------------------------------
{
  const back = htmlToMailBody(editor(
    el('P', {}, el('OL', {}, el('LI', {}, text('first')), el('LI', {}, text('second')))),
  ));
  assert.equal(back, '1. first\n2. second');
  console.log('  a nested numbered list: OK');
}

console.log('');
console.log('PASS: what the user composes is exactly what the recipient reads');
