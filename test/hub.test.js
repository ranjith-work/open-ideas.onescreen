import assert from 'node:assert/strict';
import test from 'node:test';

import * as R from '../server/rooms.js';
import { attachClient, presenceOf } from '../server/hub.js';
import { FakeSocket, tick, waitFor, TINY_PNG } from './helpers/fake-socket.js';

/** Open a room with a host screen and `n` phones already joined. */
async function openRoom(phoneCount = 1) {
  const room = R.createRoom();

  const screen = attachClient(new FakeSocket('screen'));
  await screen.tell({ t: 'hello', code: room.code, role: 'screen', hostToken: room.hostToken });

  const phones = [];
  for (let i = 0; i < phoneCount; i += 1) {
    const phone = attachClient(new FakeSocket(`phone${i}`));
    // eslint-disable-next-line no-await-in-loop
    await phone.tell({ t: 'hello', code: room.code, role: 'phone', name: `Person ${i}` });
    phones.push(phone);
  }

  screen.clear();
  phones.forEach((p) => p.clear());
  return { room, screen, phones, phone: phones[0] };
}

test('a phone joins and is told who it is', async () => {
  const room = R.createRoom();
  const phone = attachClient(new FakeSocket());
  await phone.tell({ t: 'hello', code: room.code, role: 'phone' });

  const joined = phone.last('joined');
  assert.ok(joined, 'phone should receive a joined message');
  assert.equal(joined.room.code, room.code);
  assert.equal(joined.you.role, 'phone');
  assert.equal(joined.you.isHost, false);
  assert.match(joined.you.name, /\w/, 'a nickname is assigned when none is given');
  assert.deepEqual(joined.items, []);
  R.destroyRoom(room);
});

test('joining a room that does not exist says so instead of hanging', async () => {
  const phone = attachClient(new FakeSocket());
  await phone.tell({ t: 'hello', code: 'ZZZZ', role: 'phone' });
  assert.equal(phone.last('nosuchroom')?.code, 'ZZZZ');
  assert.equal(phone.last('joined'), undefined);
});

test('only the holder of the host token becomes host', async () => {
  const room = R.createRoom();

  const realHost = attachClient(new FakeSocket('real'));
  await realHost.tell({ t: 'hello', code: room.code, role: 'screen', hostToken: room.hostToken });
  assert.equal(realHost.last('joined').you.isHost, true);

  const imposter = attachClient(new FakeSocket('imposter'));
  await imposter.tell({ t: 'hello', code: room.code, role: 'screen', hostToken: 'guessed' });
  assert.equal(imposter.last('joined').you.isHost, false);

  const phoneWithToken = attachClient(new FakeSocket('phone'));
  await phoneWithToken.tell({
    t: 'hello',
    code: room.code,
    role: 'phone',
    hostToken: room.hostToken,
  });
  assert.equal(
    phoneWithToken.last('joined').you.isHost,
    false,
    'a phone is never host, even holding the token'
  );

  R.destroyRoom(room);
});

test('text from a phone reaches the screen immediately', async () => {
  const { room, screen, phone } = await openRoom();
  await phone.tell({ t: 'submit', kind: 'text', text: 'hello from the back row' });

  const delivered = screen.last('item');
  assert.ok(delivered, 'the screen should receive the item');
  assert.equal(delivered.item.kind, 'text');
  assert.equal(delivered.item.text, 'hello from the back row');
  assert.equal(delivered.item.by.name, 'Person 0');
  assert.equal(phone.last('sent')?.kind, 'text', 'the sender gets an acknowledgement');
  assert.equal(room.items.length, 1);
  R.destroyRoom(room);
});

test('everyone in the room sees every submission, sender included', async () => {
  const { room, screen, phones } = await openRoom(3);
  await phones[2].tell({ t: 'submit', kind: 'text', text: 'ping' });

  for (const socket of [screen, ...phones]) {
    assert.equal(socket.last('item')?.item.text, 'ping', `${socket.label} missed the item`);
  }
  R.destroyRoom(room);
});

test('a message that is only emoji is promoted to an emoji tile', async () => {
  const { room, screen, phone } = await openRoom();
  await phone.tell({ t: 'submit', kind: 'text', text: '🎉🎉' });
  assert.equal(screen.last('item').item.kind, 'emoji');
  assert.equal(screen.last('item').item.emoji, '🎉🎉');

  await phone.tell({ t: 'submit', kind: 'text', text: 'nice 🎉' });
  assert.equal(screen.last('item').item.kind, 'text', 'emoji plus words stays text');
  R.destroyRoom(room);
});

test('empty text is rejected with a readable reason', async () => {
  const { room, phone } = await openRoom();
  await phone.tell({ t: 'submit', kind: 'text', text: '    ' });
  assert.match(phone.last('error').msg, /something/i);
  assert.equal(room.items.length, 0);
  R.destroyRoom(room);
});

test('a photo is stored and served from a room-scoped path', async () => {
  const { room, screen, phone } = await openRoom();
  await phone.tell({ t: 'submit', kind: 'photo', data: TINY_PNG, w: 1, h: 1, caption: 'tiny' });

  const item = screen.last('item').item;
  assert.equal(item.kind, 'photo');
  assert.equal(item.caption, 'tiny');
  assert.equal(item.src, `/m/${room.code}/${item.mediaId}`);
  assert.ok(room.media.has(item.mediaId));
  assert.ok(room.bytes > 0);
  R.destroyRoom(room);
});

test('junk that claims to be an image is refused', async () => {
  const { room, phone } = await openRoom();

  await phone.tell({ t: 'submit', kind: 'photo', data: 'not-a-data-url' });
  assert.match(phone.last('error').msg, /image/i);

  await phone.tell({ t: 'submit', kind: 'photo', data: 'data:text/html;base64,PHNjcmlwdD4=' });
  assert.match(phone.last('error').msg, /unsupported/i);

  assert.equal(room.items.length, 0);
  assert.equal(room.media.size, 0);
  R.destroyRoom(room);
});

test('a link goes up bare, then fills in once the preview resolves', async () => {
  const { room, screen, phone } = await openRoom();
  // A .invalid host can never resolve, so the unfurl fails without touching
  // the network and we still get the follow-up update.
  await phone.tell({ t: 'submit', kind: 'url', url: 'example.invalid/deck', note: 'the slides' });

  const first = screen.last('item').item;
  assert.equal(first.kind, 'url');
  assert.equal(first.url, 'https://example.invalid/deck', 'a bare host is upgraded to https');
  assert.equal(first.domain, 'example.invalid');
  assert.equal(first.note, 'the slides');

  const update = await waitFor(() => screen.last('update'));
  assert.ok(update, 'an update should follow the bare tile');
  assert.equal(update.item.id, first.id);
  R.destroyRoom(room);
});

test('a link that is not a link is refused', async () => {
  const { room, phone } = await openRoom();
  await phone.tell({ t: 'submit', kind: 'url', url: 'javascript:alert(1)' });
  assert.match(phone.last('error').msg, /link/i);
  assert.equal(room.items.length, 0);
  R.destroyRoom(room);
});

test('reactions fly across the screen without landing on the wall', async () => {
  const { room, screen, phone } = await openRoom();
  await phone.tell({ t: 'react', emoji: '🔥' });
  assert.equal(screen.last('burst')?.emoji, '🔥');
  assert.equal(room.items.length, 0, 'a reaction is not a tile');

  await phone.tell({ t: 'react', emoji: 'not emoji' });
  assert.equal(screen.all('burst').length, 1, 'text is not a reaction');
  R.destroyRoom(room);
});

test('a flood from one phone is throttled', async () => {
  const { room, phone } = await openRoom();
  for (let i = 0; i < 12; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await phone.tell({ t: 'submit', kind: 'text', text: `spam ${i}` });
  }
  assert.ok(room.items.length <= 7, `expected throttling, got ${room.items.length} items`);
  assert.ok(phone.all('error').length > 0, 'the spammer should be told to slow down');
  R.destroyRoom(room);
});

test('throttling one phone does not throttle the others', async () => {
  const { room, phones } = await openRoom(2);
  for (let i = 0; i < 12; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await phones[0].tell({ t: 'submit', kind: 'text', text: `spam ${i}` });
  }
  phones[1].clear();
  await phones[1].tell({ t: 'submit', kind: 'text', text: 'polite' });
  assert.equal(phones[1].last('sent')?.kind, 'text');
  R.destroyRoom(room);
});

test('the host can clear the wall and everyone sees it empty', async () => {
  const { room, screen, phone } = await openRoom();
  await phone.tell({ t: 'submit', kind: 'text', text: 'one' });
  screen.clear();
  phone.clear();

  await screen.tell({ t: 'host', action: 'clear' });
  assert.ok(screen.last('cleared'));
  assert.ok(phone.last('cleared'));
  assert.equal(room.items.length, 0);
  R.destroyRoom(room);
});

test('the host can delete a single tile', async () => {
  const { room, screen, phone } = await openRoom();
  await phone.tell({ t: 'submit', kind: 'text', text: 'regrettable' });
  const id = screen.last('item').item.id;
  screen.clear();

  await screen.tell({ t: 'host', action: 'delete', id });
  assert.equal(screen.last('removed')?.id, id);
  assert.equal(room.items.length, 0);
  R.destroyRoom(room);
});

test('a phone cannot use host controls', async () => {
  const { room, screen, phone } = await openRoom();
  await phone.tell({ t: 'submit', kind: 'text', text: 'keep me' });

  await phone.tell({ t: 'host', action: 'clear' });
  assert.match(phone.last('error').msg, /host/i);

  await phone.tell({ t: 'host', action: 'lock', value: true });
  assert.equal(room.locked, false);

  await phone.tell({ t: 'host', action: 'prompt', value: 'hijacked' });
  assert.equal(room.prompt, '');

  assert.equal(room.items.length, 1, 'nothing was destroyed');
  assert.equal(screen.all('cleared').length, 0);
  R.destroyRoom(room);
});

test('locking stops phones but not the host', async () => {
  const { room, screen, phone } = await openRoom();
  await screen.tell({ t: 'host', action: 'lock', value: true });
  assert.equal(phone.last('room')?.room.locked, true, 'phones are told about the lock');

  phone.clear();
  await phone.tell({ t: 'submit', kind: 'text', text: 'sneaky' });
  assert.match(phone.last('error').msg, /locked/i);
  assert.equal(room.items.length, 0);

  await screen.tell({ t: 'submit', kind: 'text', text: 'host override' });
  assert.equal(room.items.length, 1);

  await screen.tell({ t: 'host', action: 'lock', value: false });
  phone.clear();
  await phone.tell({ t: 'submit', kind: 'text', text: 'allowed now' });
  assert.equal(room.items.length, 2);
  R.destroyRoom(room);
});

test('the host prompt is pushed to every phone', async () => {
  const { room, phone } = await openRoom();
  await phone.tell({ t: 'submit', kind: 'text', text: 'warm the bucket' });
  phone.clear();

  const screen = Array.from(room.clients).find((c) => c.role === 'screen');
  await screen.tell({ t: 'host', action: 'prompt', value: 'One word for today' });
  assert.equal(phone.last('room').room.prompt, 'One word for today');
  R.destroyRoom(room);
});

test('a late joiner receives the wall as it already stands', async () => {
  const { room, phone } = await openRoom();
  await phone.tell({ t: 'submit', kind: 'text', text: 'first' });

  const latecomer = attachClient(new FakeSocket('late'));
  await latecomer.tell({ t: 'hello', code: room.code, role: 'screen' });

  const joined = latecomer.last('joined');
  assert.equal(joined.items.length, 1);
  assert.equal(joined.items[0].text, 'first');
  R.destroyRoom(room);
});

test('presence counts phones and screens separately and updates on leave', async () => {
  const { room, screen, phones } = await openRoom(3);
  assert.deepEqual(presenceOf(room), { phones: 3, screens: 1 });

  screen.clear();
  phones[0].close();
  await tick();

  assert.deepEqual(presenceOf(room), { phones: 2, screens: 1 });
  assert.equal(screen.last('presence').phones, 2);
  R.destroyRoom(room);
});

test('renaming updates the name on later submissions', async () => {
  const { room, screen, phone } = await openRoom();
  await phone.tell({ t: 'rename', name: 'Priya' });
  assert.equal(phone.last('you').you.name, 'Priya');

  await phone.tell({ t: 'submit', kind: 'text', text: 'after the rename' });
  assert.equal(screen.last('item').item.by.name, 'Priya');
  R.destroyRoom(room);
});

test('submitting before joining is refused rather than crashing', async () => {
  const stray = attachClient(new FakeSocket('stray'));
  await stray.tell({ t: 'submit', kind: 'text', text: 'nowhere' });
  assert.match(stray.last('error').msg, /join a room/i);
});

test('malformed traffic never takes the hub down', async () => {
  const { room, phone } = await openRoom();
  phone.emit('message', 'not json at all');
  phone.emit('message', 'null');
  phone.emit('message', '[]');
  await phone.tell({ t: 'nonsense' });
  await phone.tell({ t: 'submit', kind: 'sculpture' });
  await tick();

  assert.ok(phone.all('error').length >= 3);
  assert.equal(room.items.length, 0);

  // Still healthy afterwards.
  await phone.tell({ t: 'submit', kind: 'text', text: 'still works' });
  assert.equal(room.items.length, 1);
  R.destroyRoom(room);
});

test('control characters are stripped and long text is capped', async () => {
  const { room, screen, phone } = await openRoom();
  await phone.tell({ t: 'submit', kind: 'text', text: 'clean\u0000 \u0007up' });
  assert.equal(screen.last('item').item.text, 'clean up');

  await phone.tell({ t: 'submit', kind: 'text', text: 'x'.repeat(5000) });
  assert.equal(screen.last('item').item.text.length, R.MAX_TEXT_LEN);
  R.destroyRoom(room);
});

test('a dead socket does not block delivery to the live ones', async () => {
  const { room, screen, phones } = await openRoom(2);
  phones[0].readyState = 3; // died without firing close, as sockets do
  await phones[1].tell({ t: 'submit', kind: 'text', text: 'carry on' });

  assert.equal(screen.last('item').item.text, 'carry on');
  assert.equal(phones[0].all('item').length, 0, 'nothing was written to the dead socket');
  R.destroyRoom(room);
});

test('a phone that hops to another room is not counted in both', async () => {
  const first = R.createRoom();
  const second = R.createRoom();

  const phone = attachClient(new FakeSocket('wanderer'));
  await phone.tell({ t: 'hello', code: first.code, role: 'phone' });
  assert.deepEqual(presenceOf(first), { phones: 1, screens: 0 });

  await phone.tell({ t: 'hello', code: second.code, role: 'phone' });
  assert.deepEqual(presenceOf(first), { phones: 0, screens: 0 }, 'left the first room');
  assert.deepEqual(presenceOf(second), { phones: 1, screens: 0 }, 'joined the second');

  await phone.tell({ t: 'submit', kind: 'text', text: 'over here now' });
  assert.equal(first.items.length, 0);
  assert.equal(second.items.length, 1);

  R.destroyRoom(first);
  R.destroyRoom(second);
});
