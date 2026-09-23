import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseUrl,
  addressIsPrivate,
  hostnameIsPublic,
  extractMeta,
  unfurl,
} from '../server/link.js';

test('bare hostnames are upgraded to https', () => {
  assert.equal(parseUrl('example.com/thing').href, 'https://example.com/thing');
  assert.equal(parseUrl('http://example.com/').href, 'http://example.com/');
  assert.equal(parseUrl('  https://example.com/x  ').href, 'https://example.com/x');
});

test('anything that is not http or https is refused', () => {
  assert.equal(parseUrl('javascript:alert(1)'), null);
  assert.equal(parseUrl('data:text/html,<script>'), null);
  assert.equal(parseUrl('file:///etc/passwd'), null);
  assert.equal(parseUrl('ftp://example.com'), null);
  assert.equal(parseUrl(''), null);
  assert.equal(parseUrl(null), null);
});

test('absurdly long URLs are refused', () => {
  assert.equal(parseUrl(`https://example.com/${'a'.repeat(3000)}`), null);
});

test('private and reserved addresses are recognised', () => {
  const private_ = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // the cloud metadata endpoint
    '0.0.0.0',
    '100.64.0.1',
    '192.0.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    'not-an-ip',
  ];
  for (const ip of private_) {
    assert.equal(addressIsPrivate(ip), true, `${ip} should be treated as private`);
  }
});

test('ordinary public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(addressIsPrivate(ip), false, `${ip} should be treated as public`);
  }
});

test('internal-looking hostnames are rejected without a DNS lookup', async () => {
  for (const host of [
    'localhost',
    'LOCALHOST',
    'printer.local',
    'wiki.internal',
    'app.localhost',
    '127.0.0.1',
    '[::1]',
    '169.254.169.254',
    '192.168.0.10',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await hostnameIsPublic(host), false, `${host} should not be fetchable`);
  }
});

test('a public IP literal needs no DNS and is allowed', async () => {
  assert.equal(await hostnameIsPublic('8.8.8.8'), true);
});

test('a link to an internal address is never fetched', async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    throw new Error('fetch should not have been attempted');
  };
  try {
    for (const url of [
      'http://127.0.0.1:4321/api/health',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/admin',
      'http://localhost:8080/secret',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await unfurl(url);
      assert.equal(result.title, '', 'no metadata should come back');
    }
    assert.equal(called, 0, 'the server must not make the request at all');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('metadata is pulled from Open Graph tags, then the title tag', () => {
  const base = { url: '', domain: '', title: '', description: '', image: '' };
  const url = new URL('https://www.example.com/post');

  const og = extractMeta(
    `<html><head>
       <title>Fallback title</title>
       <meta property="og:title" content="The real title">
       <meta property="og:description" content="A short summary">
       <meta property="og:image" content="/cover.png">
     </head></html>`,
    url,
    base
  );
  assert.equal(og.title, 'The real title');
  assert.equal(og.description, 'A short summary');
  assert.equal(og.image, 'https://www.example.com/cover.png', 'relative images are absolute-ised');
  assert.equal(og.domain, 'example.com', 'the www prefix is dropped');

  const plain = extractMeta('<html><head><title>Just a title</title></head></html>', url, base);
  assert.equal(plain.title, 'Just a title');
  assert.equal(plain.image, '');
});

test('HTML entities in titles are decoded', () => {
  const base = { url: '', domain: '', title: '', description: '', image: '' };
  const meta = extractMeta(
    '<html><head><title>Tom &amp; Jerry &#8212; &quot;quoted&quot;</title></head></html>',
    new URL('https://example.com/'),
    base
  );
  assert.equal(meta.title, 'Tom & Jerry — "quoted"');
});

test('a javascript: preview image is dropped', () => {
  const base = { url: '', domain: '', title: '', description: '', image: '' };
  const meta = extractMeta(
    '<meta property="og:image" content="javascript:alert(1)">',
    new URL('https://example.com/'),
    base
  );
  assert.equal(meta.image, '');
});

test('unfurl returns null only for things that are not links', async () => {
  assert.equal(await unfurl('not a url at all ???'), null);
  assert.equal(await unfurl('javascript:alert(1)'), null);
  const ok = await unfurl('http://127.0.0.1/');
  assert.equal(typeof ok, 'object', 'a blocked but valid link still returns a card shape');
  assert.equal(ok.domain, '127.0.0.1');
});
