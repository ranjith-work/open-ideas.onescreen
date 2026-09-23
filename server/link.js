// Best-effort link unfurling for URL submissions.
//
// Anyone in the room can post a URL, and the server is the thing that fetches
// it. That makes this a server-side request forgery surface, so the fetch is
// deliberately fenced in: http/https only, DNS resolved up front and checked
// against private ranges, short timeout, small read cap, HTML only, and no
// redirects followed to anywhere that fails the same checks.

import dns from 'node:dns/promises';
import net from 'node:net';

const FETCH_TIMEOUT_MS = 3500;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

function ipv4IsPrivate(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipv6IsPrivate(ip) {
  const addr = ip.toLowerCase().split('%')[0];
  if (addr === '::' || addr === '::1') return true;
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique local
  if (addr.startsWith('fe8') || addr.startsWith('fe9')) return true; // link-local
  if (addr.startsWith('fea') || addr.startsWith('feb')) return true;
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPrivate(mapped[1]);
  return false;
}

export function addressIsPrivate(ip) {
  if (net.isIPv4(ip)) return ipv4IsPrivate(ip);
  if (net.isIPv6(ip)) return ipv6IsPrivate(ip);
  return true;
}

/** Resolve a hostname and reject if any answer points somewhere internal. */
export async function hostnameIsPublic(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) return !addressIsPrivate(bare);
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(bare)) return false;

  let answers;
  try {
    answers = await dns.lookup(bare, { all: true, verbatim: true });
  } catch {
    return false;
  }
  if (!answers.length) return false;
  return answers.every((a) => !addressIsPrivate(a.address));
}

export function parseUrl(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  if (url.href.length > 2048) return null;
  return url;
}

function decodeEntities(str) {
  return String(str)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function metaContent(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1]).slice(0, 300);
  }
  return '';
}

async function readCapped(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  while (total < MAX_HTML_BYTES) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** Pull title, description and preview image out of a page's HTML. */
export function extractMeta(html, currentUrl, base) {
  const titleTag = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const out = {
    ...base,
    url: currentUrl.href,
    domain: currentUrl.hostname.replace(/^www\./, ''),
    title:
      metaContent(html, 'og:title') ||
      metaContent(html, 'twitter:title') ||
      (titleTag ? decodeEntities(titleTag[1]).slice(0, 300) : ''),
    description: metaContent(html, 'og:description') || metaContent(html, 'description'),
    image: '',
  };

  const img =
    metaContent(html, 'og:image') ||
    metaContent(html, 'og:image:url') ||
    metaContent(html, 'twitter:image');
  if (img) {
    try {
      const abs = new URL(img, currentUrl);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') out.image = abs.href;
    } catch {
      /* an unparseable preview image is simply no preview image */
    }
  }
  return out;
}

/**
 * Fetch a URL and pull out a title / description / preview image.
 * Always resolves; on any failure it returns the bare-link shape so the tile
 * still renders as a clickable card.
 */
export async function unfurl(rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url) return null;

  let base = {
    url: url.href,
    domain: url.hostname.replace(/^www\./, ''),
    title: '',
    description: '',
    image: '',
  };

  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await hostnameIsPublic(current.hostname))) return base;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res;
      try {
        // eslint-disable-next-line no-await-in-loop
        res = await fetch(current.href, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; OneScreen/1.0; +link-preview)',
            accept: 'text/html,application/xhtml+xml',
            'accept-language': 'en',
          },
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return base;
        let next;
        try {
          next = new URL(loc, current);
        } catch {
          return base;
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') return base;
        current = next;
        // Follow the redirect for display purposes too, but keep the guard.
        base = { ...base, url: next.href, domain: next.hostname.replace(/^www\./, '') };
        continue;
      }

      if (!res.ok) return base;
      const type = res.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml/i.test(type)) return base;

      // eslint-disable-next-line no-await-in-loop
      const html = await readCapped(res);
      return extractMeta(html, current, base);
    }
  } catch {
    return base;
  }
  return base;
}
