import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanText,
  isEmojiOnly,
  decodeImage,
  clampDimension,
  makeBucket,
} from '../server/validate.js';
import { MAX_TEXT_LEN, MAX_MEDIA_BYTES } from '../server/rooms.js';
import { TINY_PNG } from './helpers/fake-socket.js';

test('cleanText trims, caps length and survives odd input', () => {
  assert.equal(cleanText('  hello  '), 'hello');
  assert.equal(cleanText('x'.repeat(MAX_TEXT_LEN + 500)).length, MAX_TEXT_LEN);
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(12345), '12345');
  assert.equal(cleanText({}), '[object Object]');
});

test('cleanText strips control characters but keeps newlines and emoji', () => {
  assert.equal(cleanText('a\u0000b\u0001c'), 'abc');
  assert.equal(cleanText('line one\nline two'), 'line one\nline two');
  assert.equal(cleanText('tab\there'), 'tab\there');
  assert.equal(cleanText('safe\u007fsplit'), 'safesplit');
  assert.equal(cleanText('party 🎉'), 'party 🎉');
});

test('cleanText leaves markup as inert text', () => {
  // The client sets textContent, never innerHTML, so angle brackets are safe
  // to keep — stripping them would mangle legitimate messages about code.
  assert.equal(cleanText('<script>alert(1)</script>'), '<script>alert(1)</script>');
  assert.equal(cleanText('a < b && c > d'), 'a < b && c > d');
});

test('emoji-only detection', () => {
  for (const good of ['🎉', '🎉🎉', '❤️', '🔥🔥🔥', '👍🏽']) {
    assert.equal(isEmojiOnly(good), true, `${good} should count as emoji only`);
  }
  for (const bad of ['', 'hello', 'nice 🎉', '123', '🎉'.repeat(20), '   ']) {
    assert.equal(isEmojiOnly(bad), false, `"${bad}" should not count as emoji only`);
  }
});

test('decodeImage accepts the formats phones actually produce', () => {
  const png = decodeImage(TINY_PNG);
  assert.equal(png.error, undefined);
  assert.equal(png.mime, 'image/png');
  assert.ok(png.buf.length > 0);

  const jpeg = decodeImage('data:image/jpeg;base64,/9j/4AAQSkZJRg==');
  assert.equal(jpeg.error, undefined);
  assert.equal(jpeg.mime, 'image/jpeg');
});

test('decodeImage refuses anything that is not a permitted image', () => {
  assert.match(decodeImage('').error, /image/i);
  assert.match(decodeImage('hello').error, /image/i);
  assert.match(decodeImage('https://example.com/a.png').error, /image/i);
  assert.match(decodeImage('data:text/html;base64,PGh0bWw+').error, /unsupported/i);
  assert.match(decodeImage('data:image/svg+xml;base64,PHN2Zz4=').error, /unsupported/i);
  assert.match(decodeImage('data:image/png;base64,').error, /image/i);
});

test('decodeImage rejects an oversized payload before allocating it', () => {
  const huge = `data:image/png;base64,${'A'.repeat(MAX_MEDIA_BYTES * 2)}`;
  const result = decodeImage(huge);
  assert.match(result.error, /too big/i);
  assert.equal(result.buf, undefined);
});

test('dimensions are clamped to something sane', () => {
  assert.equal(clampDimension(1920), 1920);
  assert.equal(clampDimension('800'), 800);
  assert.equal(clampDimension(99999), 8000);
  assert.equal(clampDimension(0), null);
  assert.equal(clampDimension(-5), null);
  assert.equal(clampDimension('wide'), null);
  assert.equal(clampDimension(undefined), null);
  assert.equal(clampDimension(Infinity), null);
});

test('the token bucket allows a burst then throttles', () => {
  const take = makeBucket({ size: 6, rate: 0.8 });
  const now = 1_000_000;
  let allowed = 0;
  for (let i = 0; i < 20; i += 1) if (take(1, now)) allowed += 1;
  assert.equal(allowed, 6, 'the burst size is honoured exactly once');
  assert.equal(take(1, now), false);
});

test('the token bucket refills over time', () => {
  const take = makeBucket({ size: 6, rate: 0.8 });
  const start = 2_000_000;
  while (take(1, start)) {
    /* drain */
  }
  assert.equal(take(1, start + 500), false, 'half a second is not enough');
  assert.equal(take(1, start + 1500), true, 'a second and a half refills one token');
});

test('the token bucket never overfills while idle', () => {
  const take = makeBucket({ size: 6, rate: 0.8 });
  const start = 3_000_000;
  take(1, start);
  const later = start + 60 * 60 * 1000; // an hour of silence
  let allowed = 0;
  for (let i = 0; i < 20; i += 1) if (take(1, later)) allowed += 1;
  assert.equal(allowed, 6, 'idling does not bank unlimited submissions');
});

test('cheap actions cost a fraction of a token', () => {
  const take = makeBucket({ size: 6, rate: 0.8 });
  const now = 4_000_000;
  let reactions = 0;
  while (take(0.34, now)) reactions += 1;
  assert.ok(reactions >= 17, `reactions should be cheap, got ${reactions}`);
});
