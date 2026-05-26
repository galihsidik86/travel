// Smoke test for 5vv — isInlineImageMime helper.
//
// Pure-function check: PNG/JPEG/WEBP are renderable in <img>; PDF/HEIC/HEIF
// are not (Chrome/Firefox don't ship HEIC decoders, and PDFs need <embed>).
import { isInlineImageMime } from '../src/lib/docStorage.js';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

console.log('\n[5vv smoke]');
assert(isInlineImageMime('image/jpeg') === true,  'image/jpeg renderable');
assert(isInlineImageMime('image/png')  === true,  'image/png renderable');
assert(isInlineImageMime('image/webp') === true,  'image/webp renderable');
assert(isInlineImageMime('image/heic') === false, 'image/heic NOT inline (Chrome/Firefox lack decoder)');
assert(isInlineImageMime('image/heif') === false, 'image/heif NOT inline');
assert(isInlineImageMime('application/pdf') === false, 'application/pdf NOT inline');
assert(isInlineImageMime('') === false, 'empty mime NOT inline');
assert(isInlineImageMime(null) === false, 'null mime NOT inline');
assert(isInlineImageMime(undefined) === false, 'undefined mime NOT inline');
console.log('\n[5vv smoke] PASS\n');
