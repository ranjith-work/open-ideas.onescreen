import assert from 'node:assert/strict';
import test from 'node:test';

import * as R from '../server/rooms.js';

test('room codes avoid glyphs that get misread off a projector', () => {
  for (let i = 0; i < 400; i += 1) {
    assert.match(R.makeCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  }
});

test('createRoom returns a distinct code and host token each time', () => {
  const a = R.createRoom();
  const b = R.createRoom();
  assert.notEqual(a.code, b.code);
  assert.notEqual(a.hostToken, b.hostToken);
  assert.ok(a.hostToken.length >= 24);
  R.destroyRoom(a);
  R.destroyRoom(b);
});

test('getRoom is forgiving about how a code was typed', () => {
  const room = R.createRoom();
  assert.equal(R.getRoom(room.code.toLowerCase())?.code, room.code);
  assert.equal(R.getRoom(` ${room.code} `)?.code, room.code);
  assert.equal(R.getRoom('nope!!'), null);
  R.destroyRoom(room);
});

test('publicRoom never leaks the host token', () => {
  const room = R.createRoom();
  const pub = R.publicRoom(room);
  assert.deepEqual(Object.keys(pub).sort(), ['code', 'createdAt', 'locked', 'prompt']);
  assert.equal(JSON.stringify(pub).includes(room.hostToken), false);
  R.destroyRoom(room);
});

test('the item list is capped and the oldest items fall off', () => {
  const room = R.createRoom();
  for (let i = 0; i < R.MAX_ITEMS + 25; i += 1) {
    R.addItem(room, { id: `i${i}`, kind: 'text', text: String(i), at: Date.now() });
  }
  assert.equal(room.items.length, R.MAX_ITEMS);
  assert.equal(room.items[0].id, 'i25');
  R.destroyRoom(room);
});

test('evicting an item frees the bytes its image was holding', () => {
  const room = R.createRoom();
  const oneMeg = Buffer.alloc(1024 * 1024, 7);
  const mediaId = R.putMedia(room, 'image/png', oneMeg);
  R.addItem(room, { id: 'x1', kind: 'photo', mediaId, at: Date.now() });
  assert.equal(room.bytes, oneMeg.length);

  R.removeItem(room, 'x1');
  assert.equal(room.bytes, 0);
  assert.equal(room.media.has(mediaId), false);
  R.destroyRoom(room);
});

test('a room over its media budget sheds its oldest images', () => {
  const room = R.createRoom();
  const chunk = Buffer.alloc(8 * 1024 * 1024, 3); // 8 MB each
  for (let i = 0; i < 20; i += 1) {
    const mediaId = R.putMedia(room, 'image/jpeg', chunk);
    R.addItem(room, { id: `p${i}`, kind: 'photo', mediaId, at: Date.now() });
  }
  assert.ok(room.bytes <= R.MAX_ROOM_BYTES, `bytes ${room.bytes} should be within budget`);
  assert.ok(room.items.length < 20, 'some items should have been evicted');
  // Media for evicted items must be gone, not merely unreferenced.
  assert.equal(room.media.size, room.items.length);
  R.destroyRoom(room);
});

test('clearRoom drops items and media together', () => {
  const room = R.createRoom();
  const mediaId = R.putMedia(room, 'image/png', Buffer.alloc(2048));
  R.addItem(room, { id: 'a', kind: 'photo', mediaId, at: Date.now() });
  R.clearRoom(room);
  assert.equal(room.items.length, 0);
  assert.equal(room.media.size, 0);
  assert.equal(room.bytes, 0);
  R.destroyRoom(room);
});

test('sweep expires idle empty rooms but keeps ones with people in them', () => {
  const idle = R.createRoom();
  const busy = R.createRoom();
  const occupied = R.createRoom();
  occupied.clients.add({ role: 'phone' });

  idle.lastActive = Date.now() - R.ROOM_TTL_MS - 1000;
  occupied.lastActive = Date.now() - R.ROOM_TTL_MS - 1000;

  const killed = R.sweep();
  assert.ok(killed.includes(idle.code), 'idle room should be swept');
  assert.ok(!killed.includes(busy.code), 'fresh room should survive');
  assert.ok(!killed.includes(occupied.code), 'occupied room should survive');

  R.destroyRoom(busy);
  R.destroyRoom(occupied);
});

test('nicknames and colours are stable and presentable', () => {
  assert.match(R.makeNickname(), /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  assert.equal(R.colorFor('seed-1'), R.colorFor('seed-1'));
  assert.ok(R.AVATAR_COLORS.includes(R.colorFor('anything')));
});
