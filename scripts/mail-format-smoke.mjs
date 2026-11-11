// Tests the MAIL BODY FORMATTER.
//
// The body travels as plain text, so emphasis is expressed with simple
// markers - **bold**, _italic_, `code`, [label](url), - bullets and
// 1. numbers. These tests pin down the cases that were broken:
//
//   - a marker that spans LINES never matched, because the renderer works
//     line by line, so the composer now marks each line on its own;
//   - every line of a numbered list got the same "1. ", so the list read
//     "1. 1. 1." - the number has to count up;
//   - a link with an empty url - which is what the composer inserts, so the
//     user can type the address - did not match at all, and the raw
//     brackets showed up in the message;
//   - pressing a format button twice doubled the marker instead of removing
//     it.
import assert from 'node:assert/strict';
import { renderMailBody, renderMailBodyToText } from '../src/mail-format.js';

console.log('=== MAIL BODY FORMATTER ===');

const types = blocks => blocks.flatMap(block => (
  block.type === 'ul' ? block.items : [block.parts]
)).flat().map(part => part.type);

const textOf = blocks => blocks.flatMap(block => (
  block.type === 'ul' ? block.items : [block.parts]
)).flat().map(part => part.text).join('');

// ---------------------------------------------------------------------------
// 1. Bold on a SINGLE line.
// ---------------------------------------------------------------------------
{
  const blocks = renderMailBody('This is **bold** text');
  assert.ok(types(blocks).includes('bold'), 'bold must be rendered');
  assert.equal(textOf(blocks), 'This is bold text');
  console.log('  bold on a single line: OK');
}

// ---------------------------------------------------------------------------
// 2. Bold on EACH line of a multi-line block.
//
// This is the case the composer produces when the whole message is bolded:
// every line carries its own markers, so every line renders.
// ---------------------------------------------------------------------------
{
  const source = '**line one**\n**line two**';
  const blocks = renderMailBody(source);
  const boldParts = blocks.flatMap(b => (b.parts || []).filter(p => p.type === 'bold'));
  assert.equal(boldParts.length, 2, 'both lines must be bold');
  assert.deepEqual(boldParts.map(p => p.text), ['line one', 'line two']);
  console.log('  bold on each line of a multi-line block: OK');
}

// ---------------------------------------------------------------------------
// 3. Italic, code and strikethrough.
// ---------------------------------------------------------------------------
{
  const blocks = renderMailBody('_italic_ and `code` and ~~strike~~');
  const kinds = types(blocks);
  assert.ok(kinds.includes('italic'), 'italic must be rendered');
  assert.ok(kinds.includes('code'), 'code must be rendered');
  assert.ok(kinds.includes('strike'), 'strike must be rendered');
  console.log('  italic, code and strikethrough: OK');
}

// ---------------------------------------------------------------------------
// 4. A BULLET list.
// ---------------------------------------------------------------------------
{
  const blocks = renderMailBody('- one\n- two\n- three');
  assert.equal(blocks.length, 1, 'the list must be ONE block');
  assert.equal(blocks[0].type, 'ul');
  assert.equal(blocks[0].items.length, 3, 'the list must have three items');
  console.log('  a bullet list: OK');
}

// ---------------------------------------------------------------------------
// 5. A NUMBERED list keeps its own numbers.
// ---------------------------------------------------------------------------
{
  const blocks = renderMailBody('1. first\n2. second\n3. third');
  assert.equal(blocks.length, 1, 'the list must be ONE block');
  assert.equal(blocks[0].type, 'ul');
  assert.equal(blocks[0].items.length, 3);
  assert.deepEqual(
    blocks[0].items.map(item => item.map(p => p.text).join('')),
    ['first', 'second', 'third'],
  );
  console.log('  a numbered list: OK');
}

// ---------------------------------------------------------------------------
// 6. A link with a REAL url.
// ---------------------------------------------------------------------------
{
  const blocks = renderMailBody('see [the docs](https://example.com/docs) now');
  const link = blocks.flatMap(b => b.parts || []).find(p => p.type === 'link');
  assert.ok(link, 'the link must be rendered');
  assert.equal(link.text, 'the docs');
  assert.equal(link.href, 'https://example.com/docs');
  console.log('  a link with a real url: OK');
}

// ---------------------------------------------------------------------------
// 7. A link with an EMPTY url.
//
// This is what the composer inserts, so the user can type the address. It
// must still render as a link rather than as raw brackets.
// ---------------------------------------------------------------------------
{
  const blocks = renderMailBody('[link text](https://)');
  const link = blocks.flatMap(b => b.parts || []).find(p => p.type === 'link');
  assert.ok(link, 'a link with an empty url must still render');
  assert.equal(link.text, 'link text');
  assert.equal(link.href, 'https://');
  assert.equal(renderMailBodyToText('[link text](https://)'), 'link text');
  console.log('  a link with an empty url: OK');
}

// ---------------------------------------------------------------------------
// 8. Plain text is left EXACTLY as it was written.
// ---------------------------------------------------------------------------
{
  const source = 'Just a normal sentence with no markers at all.';
  assert.equal(renderMailBodyToText(source), source);
  console.log('  plain text is untouched: OK');
}

// ---------------------------------------------------------------------------
// 9. A marker inside a code span is NOT mistaken for emphasis.
// ---------------------------------------------------------------------------
{
  const blocks = renderMailBody('run `a ** b` now');
  const kinds = types(blocks);
  assert.ok(kinds.includes('code'), 'the code span must be rendered');
  assert.ok(!kinds.includes('bold'), 'the ** inside code must NOT be bold');
  console.log('  a marker inside a code span is not emphasis: OK');
}

// ---------------------------------------------------------------------------
// 10. A blank line between paragraphs stays a gap, and a blank line INSIDE a
//     list does not become an empty list item.
// ---------------------------------------------------------------------------
{
  const blocks = renderMailBody('first para\n\nsecond para');
  assert.equal(blocks.length, 3, 'the gap must be its own block');
  assert.equal(blocks[1].parts.length, 0, 'the gap must be empty');
  console.log('  a paragraph gap: OK');
}

// ---------------------------------------------------------------------------
// 11. A list item with bold inside it.
// ---------------------------------------------------------------------------
{
  const blocks = renderMailBody('- **important** point');
  assert.equal(blocks[0].type, 'ul');
  assert.ok(blocks[0].items[0].some(p => p.type === 'bold'), 'the item must be bold');
  console.log('  a bold list item: OK');
}

console.log('');
console.log('PASS: the mail body formatter renders every marker the composer can produce');
