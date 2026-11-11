// Tests that a link's SCHEME is constrained.
//
// A link's target can come from a REMOTE source - the sender of a received
// mail, or a third-party API response - so the scheme is checked before the
// url reaches the DOM. Only `http` and `https` are allowed.
//
// The main process applies the same rule when it opens a url, but the check
// has to be at the point the href is BUILT as well: a value that is never
// put into the DOM cannot be clicked, and a code scanner cannot tell the
// difference between "the value is checked later" and "the value is never
// checked".
import assert from 'node:assert/strict';
import { isSafeLinkUrl, normalizeLinkUrl, renderMailBody } from '../src/mail-format.js';

console.log('=== LINK SCHEME ===');

// ---------------------------------------------------------------------------
// 1. The schemes that are ALLOWED.
// ---------------------------------------------------------------------------
{
  assert.equal(isSafeLinkUrl('https://example.com'), true);
  assert.equal(isSafeLinkUrl('http://example.com'), true);
  assert.equal(isSafeLinkUrl('https://example.com/path?query=1#hash'), true);
  console.log('  http and https are allowed: OK');
}

// ---------------------------------------------------------------------------
// 2. The schemes that are REFUSED.
// ---------------------------------------------------------------------------
{
  assert.equal(isSafeLinkUrl('javascript:alert(1)'), false);
  assert.equal(isSafeLinkUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeLinkUrl('file:///C:/Windows/System32/cmd.exe'), false);
  assert.equal(isSafeLinkUrl('vbscript:msgbox(1)'), false);
  assert.equal(isSafeLinkUrl(''), false);
  assert.equal(isSafeLinkUrl('not a url'), false);
  console.log('  javascript, data, file and vbscript are refused: OK');
}

// ---------------------------------------------------------------------------
// 3. A scheme that is HIDDEN behind whitespace or a newline must not slip
//    past. This is why the check is done on the PARSED url and not on the
//    string.
// ---------------------------------------------------------------------------
{
  assert.equal(isSafeLinkUrl('java\nscript:alert(1)'), false);
  assert.equal(isSafeLinkUrl('  javascript:alert(1)'), false);
  assert.equal(isSafeLinkUrl('JaVaScRiPt:alert(1)'), false);
  assert.equal(isSafeLinkUrl('java\tscript:alert(1)'), false);
  console.log('  an obfuscated scheme is refused: OK');
}

// ---------------------------------------------------------------------------
// 4. The NORMALISER used by the link dialog. A bare address gets the
//    scheme; anything unsafe comes back empty so the caller refuses it.
// ---------------------------------------------------------------------------
{
  assert.equal(normalizeLinkUrl('example.com'), 'https://example.com');
  assert.equal(normalizeLinkUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(normalizeLinkUrl('http://example.com'), 'http://example.com');
  assert.equal(normalizeLinkUrl('javascript:alert(1)'), '');
  assert.equal(normalizeLinkUrl('  '), '');
  assert.equal(normalizeLinkUrl(''), '');
  console.log('  the normaliser: OK');
}

// ---------------------------------------------------------------------------
// 5. The reader. A link in a RECEIVED mail is rendered only when its scheme
//    is safe - and the PARSER already refuses anything that is not http or
//    https, so a hostile link never becomes a link at all.
// ---------------------------------------------------------------------------
{
  const hostile = renderMailBody('[click me](javascript:alert(1))');
  const parts = hostile.flatMap(block => block.parts || []);
  assert.ok(
    !parts.some(part => part.type === 'link'),
    'a javascript: link in a received mail must not become a link',
  );
  const safe = renderMailBody('[click me](https://example.com)');
  const safeParts = safe.flatMap(block => block.parts || []);
  const link = safeParts.find(part => part.type === 'link');
  assert.ok(link, 'an https link must still be rendered');
  assert.equal(link.href, 'https://example.com');
  console.log('  the reader only renders a safe link: OK');
}

console.log('');
console.log('PASS: a link scheme is constrained before it can reach the DOM');
