// Input validation for anything a phone sends us.
//
// Everyone in the room is anonymous by design, so nothing arriving over the
// socket is trusted: sizes are capped, control characters are stripped, and
// image payloads are checked before a single byte is allocated.

import { MAX_TEXT_LEN, MAX_MEDIA_BYTES, ALLOWED_IMAGE_MIME } from './rooms.js';

export const EMOJI_RE = /\p{Extended_Pictographic}/u;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g;

export function cleanText(input, max = MAX_TEXT_LEN) {
  return String(input ?? '')
    .replace(CONTROL_CHARS, '')
    .slice(0, max)
    .trim();
}

/** True when a string is emoji and nothing else — those get the big treatment. */
export function isEmojiOnly(text) {
  const stripped = String(text || '').replace(/\s/g, '');
  if (!stripped || stripped.length > 12) return false;
  if (!EMOJI_RE.test(stripped)) return false;
  return !/[\p{L}\p{N}]/u.test(stripped);
}

/**
 * Parse a `data:` URL into a validated image buffer.
 * Returns `{ mime, buf }` or `{ error }` — never throws.
 */
export function decodeImage(dataUrl) {
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) return { error: 'That did not arrive as an image.' };

  const mime = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIME.has(mime)) return { error: 'Unsupported image type.' };

  // base64 is 4/3 the size of what it encodes; reject before allocating.
  const payload = match[2];
  if (payload.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 1024) {
    return { error: 'That image is too big.' };
  }

  let buf;
  try {
    buf = Buffer.from(payload, 'base64');
  } catch {
    return { error: 'That image was corrupt.' };
  }
  if (!buf.length) return { error: 'That image was empty.' };
  if (buf.length > MAX_MEDIA_BYTES) return { error: 'That image is too big.' };
  return { mime, buf };
}

export function clampDimension(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(8000, Math.round(n));
}

/**
 * Token bucket, one per connection. Refills at `rate` tokens a second up to
 * `size`, so a burst is fine but a flood is not.
 */
export function makeBucket({ size = 6, rate = 0.8 } = {}) {
  let tokens = size;
  let stamp = Date.now();
  return function take(cost = 1, now = Date.now()) {
    // Clamped: a clock that jumps backwards must not starve the bucket and
    // lock somebody out of the room until the clock catches up.
    const elapsed = Math.max(0, (now - stamp) / 1000);
    tokens = Math.min(size, tokens + elapsed * rate);
    stamp = now;
    if (tokens < cost) return false;
    tokens -= cost;
    return true;
  };
}
