import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp, externalOrigin, isLoopbackHost } from '../server/app.js';
import * as R from '../server/rooms.js';
import { get, postJson } from './helpers/http.js';

const app = createApp({ port: 4321 });

test('the home page is served', async () => {
  const res = await get(app, '/');
  assert.equal(res.status, 200);
  assert.match(res.text, /OneScreen/);
  assert.match(res.text, /Open a room/);
});

test('the screen and join pages are served for any code shape', async () => {
  for (const url of ['/s/AB2C', '/j/AB2C', '/j']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await get(app, url);
    assert.equal(res.status, 200, `${url} should render`);
    assert.match(res.text, /<!doctype html>/i);
  }
});

test('static assets are served with the right content type', async () => {
  const css = await get(app, '/css/app.css');
  assert.equal(css.status, 200);
  assert.match(String(css.headers['content-type']), /text\/css/);

  const js = await get(app, '/js/screen.js');
  assert.equal(js.status, 200);
  assert.match(String(js.headers['content-type']), /javascript/);
});

test('creating a room returns a code, a host token and a join URL', async () => {
  const res = await postJson(app, '/api/rooms');
  assert.equal(res.status, 200);
  const { code, hostToken, joinUrl, screenUrl } = res.json;

  assert.match(code, /^[A-Z0-9]{4,5}$/);
  assert.ok(hostToken.length >= 24);
  assert.ok(joinUrl.endsWith(`/j/${code}`), `join URL should point at the room: ${joinUrl}`);
  assert.ok(screenUrl.endsWith(`/s/${code}`));
  assert.ok(R.getRoom(code), 'the room should now exist');

  R.destroyRoom(R.getRoom(code));
});

test('two rooms never collide', async () => {
  const codes = new Set();
  for (let i = 0; i < 30; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await postJson(app, '/api/rooms');
    codes.add(res.json.code);
  }
  assert.equal(codes.size, 30);
  for (const code of codes) R.destroyRoom(R.getRoom(code));
});

test('looking up a room never reveals its host token', async () => {
  const created = (await postJson(app, '/api/rooms')).json;
  const res = await get(app, `/api/rooms/${created.code}`);

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.room.code, created.code);
  assert.equal(res.text.includes(created.hostToken), false, 'host token must not leak');

  R.destroyRoom(R.getRoom(created.code));
});

test('a lowercase code in the URL still finds the room', async () => {
  const created = (await postJson(app, '/api/rooms')).json;
  const res = await get(app, `/api/rooms/${created.code.toLowerCase()}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.room.code, created.code);
  R.destroyRoom(R.getRoom(created.code));
});

test('an unknown room returns 404 rather than an empty room', async () => {
  const res = await get(app, '/api/rooms/ZZZZ');
  assert.equal(res.status, 404);
  assert.equal(res.json.error, 'no_such_room');
});

test('the QR endpoint returns a real PNG', async () => {
  const res = await get(app, `/api/qr.png?d=${encodeURIComponent('http://192.168.1.50:4321/j/AB2C')}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.deepEqual(
    Array.from(res.body.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'should start with the PNG magic number'
  );
  assert.ok(res.body.length > 200, 'the image should have actual content');
});

test('the QR endpoint clamps its size and refuses empty input', async () => {
  const empty = await get(app, '/api/qr.png');
  assert.equal(empty.status, 400);

  const huge = await get(app, '/api/qr.png?d=hello&s=999999');
  assert.equal(huge.status, 200, 'an absurd size is clamped, not rejected');

  const tiny = await get(app, '/api/qr.png?d=hello&s=1');
  assert.equal(tiny.status, 200);
});

test('media is served from the room that owns it and nowhere else', async () => {
  const roomA = R.createRoom();
  const roomB = R.createRoom();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const mediaId = R.putMedia(roomA, 'image/png', png);

  const ok = await get(app, `/m/${roomA.code}/${mediaId}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.deepEqual(Array.from(ok.body), Array.from(png));

  const crossRoom = await get(app, `/m/${roomB.code}/${mediaId}`);
  assert.equal(crossRoom.status, 404, 'another room must not be able to read it');

  const missing = await get(app, `/m/${roomA.code}/nope`);
  assert.equal(missing.status, 404);

  R.destroyRoom(roomA);
  R.destroyRoom(roomB);
});

test('media disappears with its room', async () => {
  const room = R.createRoom();
  const mediaId = R.putMedia(room, 'image/png', Buffer.alloc(16));
  const code = room.code;
  R.destroyRoom(room);

  const res = await get(app, `/m/${code}/${mediaId}`);
  assert.equal(res.status, 404);
});

test('path traversal in a media request does not escape the room', async () => {
  const room = R.createRoom();
  for (const suffix of ['..%2f..%2fetc%2fpasswd', '..', '%2e%2e']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await get(app, `/m/${room.code}/${suffix}`);
    assert.equal(res.status, 404, `${suffix} should not resolve`);
  }
  R.destroyRoom(room);
});

test('health reports live counts', async () => {
  const room = R.createRoom();
  R.addItem(room, { id: 'h1', kind: 'text', text: 'hi', at: Date.now() });

  const res = await get(app, '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.rooms >= 1);
  assert.ok(res.json.items >= 1);

  R.destroyRoom(room);
});

test('unknown paths fall back to the home page, not a bare 404', async () => {
  const res = await get(app, '/definitely/not/a/route');
  assert.equal(res.status, 404);
  assert.match(res.text, /OneScreen/);
});

test('responses carry the basic hardening headers', async () => {
  const res = await get(app, '/api/health');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['x-powered-by'], undefined, 'express should not announce itself');
});

test('loopback detection covers the usual spellings', () => {
  for (const host of ['localhost', '127.0.0.1', '::1', '0.0.0.0']) {
    assert.equal(isLoopbackHost(host), true, `${host} is loopback`);
  }
  for (const host of ['192.168.1.5', 'onescreen.example.com', '10.0.0.4']) {
    assert.equal(isLoopbackHost(host), false, `${host} is not loopback`);
  }
});

test('a QR served over loopback points somewhere a phone can actually reach', () => {
  const req = { get: (h) => (h.toLowerCase() === 'host' ? 'localhost:4321' : undefined), protocol: 'http' };
  const origin = externalOrigin(req, 4321);
  assert.ok(origin.startsWith('http://'));
  assert.equal(
    origin.includes('localhost'),
    false,
    'a QR containing localhost would send every phone to its own browser'
  );
  assert.match(origin, /:4321$/, 'the port is preserved');
});

test('a real hostname is left alone', () => {
  const req = {
    get: (h) => (h.toLowerCase() === 'host' ? 'wall.office.example:9000' : undefined),
    protocol: 'http',
  };
  assert.equal(externalOrigin(req, 4321), 'http://wall.office.example:9000');
});

test('a reverse proxy header is honoured', () => {
  const headers = { 'x-forwarded-host': 'onescreen.example.com', 'x-forwarded-proto': 'https' };
  const req = { get: (h) => headers[h.toLowerCase()], protocol: 'http' };
  assert.equal(externalOrigin(req, 4321), 'https://onescreen.example.com');
});
