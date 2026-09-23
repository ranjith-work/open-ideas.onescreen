// The hub: everything that happens on a live socket.
//
// Deliberately written against a minimal socket shape — `on`, `send`,
// `readyState`, `terminate` — rather than against the `ws` library, so the
// whole room protocol can be exercised with fake sockets in tests.

import * as R from './rooms.js';
import { unfurl, parseUrl } from './link.js';
import {
  EMOJI_RE,
  cleanText,
  isEmojiOnly,
  decodeImage,
  clampDimension,
  makeBucket,
} from './validate.js';

const OPEN = 1;

export function send(ws, obj) {
  if (!ws || ws.readyState !== OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

export function broadcast(room, obj, except = null) {
  const payload = JSON.stringify(obj);
  for (const client of room.clients) {
    if (client === except) continue;
    if (client.readyState !== OPEN) continue;
    try {
      client.send(payload);
    } catch {
      /* a socket that dies mid-send is cleaned up by its own close handler */
    }
  }
}

export function presenceOf(room) {
  let phones = 0;
  let screens = 0;
  for (const client of room.clients) {
    if (client.role === 'phone') phones += 1;
    else if (client.role === 'screen') screens += 1;
  }
  return { phones, screens };
}

function fail(ws, msg) {
  send(ws, { t: 'error', msg });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleHello(ws, msg) {
  const room = R.getRoom(msg.code);
  if (!room) {
    send(ws, { t: 'nosuchroom', code: R.normalizeCode(msg.code) });
    return;
  }

  // A client that says hello twice (a reconnect racing an old socket, or a
  // hop to another room) must not be left counted in two places.
  if (ws.room && ws.room !== room) {
    const previous = ws.room;
    previous.clients.delete(ws);
    broadcast(previous, { t: 'presence', ...presenceOf(previous) });
  }

  ws.role = msg.role === 'screen' ? 'screen' : 'phone';
  ws.room = room;
  ws.isHost = ws.role === 'screen' && typeof msg.hostToken === 'string' && msg.hostToken === room.hostToken;
  ws.userId = R.makeId(6);
  ws.name = cleanText(msg.name, R.MAX_NAME_LEN) || R.makeNickname();
  ws.color = R.colorFor(ws.userId);

  room.clients.add(ws);
  R.touch(room);

  send(ws, {
    t: 'joined',
    you: { id: ws.userId, name: ws.name, color: ws.color, isHost: ws.isHost, role: ws.role },
    room: R.publicRoom(room),
    items: room.items,
    ...presenceOf(room),
  });
  broadcast(room, { t: 'presence', ...presenceOf(room) });
}

/**
 * Build an item from a submission. Pure: returns `{ item }` or `{ error }` and
 * only touches the room to store media.
 */
export function buildItem(ws, msg, room) {
  const base = {
    id: R.makeId(),
    at: Date.now(),
    by: { id: ws.userId, name: ws.name, color: ws.color },
  };

  switch (msg.kind) {
    case 'text': {
      const text = cleanText(msg.text);
      if (!text) return { error: 'Type something first.' };
      return {
        item: isEmojiOnly(text)
          ? { ...base, kind: 'emoji', emoji: text.replace(/\s/g, '') }
          : { ...base, kind: 'text', text },
      };
    }

    case 'emoji': {
      const emoji = cleanText(msg.emoji, 16).replace(/\s/g, '');
      if (!emoji || !EMOJI_RE.test(emoji)) return { error: 'That is not an emoji.' };
      return { item: { ...base, kind: 'emoji', emoji } };
    }

    case 'url': {
      const url = parseUrl(msg.url);
      if (!url) return { error: 'That link does not look right.' };
      return {
        item: {
          ...base,
          kind: 'url',
          url: url.href,
          domain: url.hostname.replace(/^www\./, ''),
          title: '',
          description: '',
          image: '',
          note: cleanText(msg.note, 140),
        },
      };
    }

    case 'photo':
    case 'drawing': {
      const decoded = decodeImage(msg.data);
      if (decoded.error) return { error: decoded.error };
      if (room.bytes + decoded.buf.length > R.MAX_ROOM_BYTES * 2) {
        return { error: 'This room is out of room for images.' };
      }
      const mediaId = R.putMedia(room, decoded.mime, decoded.buf);
      return {
        item: {
          ...base,
          kind: msg.kind,
          mediaId,
          src: `/m/${room.code}/${mediaId}`,
          w: clampDimension(msg.w),
          h: clampDimension(msg.h),
          caption: cleanText(msg.caption, 140),
        },
      };
    }

    default:
      return { error: 'Unknown submission type.' };
  }
}

export async function handleSubmit(ws, msg) {
  const room = ws.room;
  if (!room) return fail(ws, 'Join a room first.');
  if (room.locked && !ws.isHost) return fail(ws, 'The host has locked this wall.');
  if (!ws.take(1)) return fail(ws, 'Easy there — one at a time.');

  const built = buildItem(ws, msg, room);
  if (built.error) return fail(ws, built.error);
  const item = built.item;

  const evicted = R.addItem(room, item);
  broadcast(room, { t: 'item', item });
  for (const id of evicted) broadcast(room, { t: 'removed', id });
  send(ws, { t: 'sent', id: item.id, kind: item.kind });

  // Link previews resolve after the tile is already up, so the room never
  // waits on somebody else's slow website.
  if (item.kind === 'url') {
    const meta = await unfurl(item.url).catch(() => null);
    if (!meta) return undefined;
    if (!room.items.some((it) => it.id === item.id)) return undefined; // deleted meanwhile
    item.title = meta.title;
    item.description = meta.description;
    item.image = meta.image;
    item.domain = meta.domain || item.domain;
    broadcast(room, { t: 'update', item });
  }
  return undefined;
}

export function handleHost(ws, msg) {
  const room = ws.room;
  if (!room) return fail(ws, 'Join a room first.');
  if (!ws.isHost) return fail(ws, 'Only the host screen can do that.');
  R.touch(room);

  switch (msg.action) {
    case 'clear':
      R.clearRoom(room);
      broadcast(room, { t: 'cleared' });
      break;

    case 'delete':
      if (R.removeItem(room, String(msg.id || ''))) {
        broadcast(room, { t: 'removed', id: String(msg.id) });
      }
      break;

    case 'lock':
      room.locked = Boolean(msg.value);
      broadcast(room, { t: 'room', room: R.publicRoom(room) });
      break;

    case 'prompt':
      room.prompt = cleanText(msg.value, 140);
      broadcast(room, { t: 'room', room: R.publicRoom(room) });
      break;

    case 'spotlight': {
      const item = room.items.find((it) => it.id === String(msg.id || ''));
      if (item) broadcast(room, { t: 'spotlight', item });
      break;
    }

    default:
      fail(ws, 'Unknown host action.');
  }
  return undefined;
}

export function handleReact(ws, msg) {
  const room = ws.room;
  if (!room) return;
  if (room.locked && !ws.isHost) return;
  if (!ws.take(0.34)) return; // reactions are cheap, but not free
  const emoji = cleanText(msg.emoji, 8).replace(/\s/g, '');
  if (!emoji || !EMOJI_RE.test(emoji)) return;
  R.touch(room);
  broadcast(room, { t: 'burst', emoji, from: ws.name });
}

export function handleRename(ws, msg) {
  if (!ws.room) return;
  ws.name = cleanText(msg.name, R.MAX_NAME_LEN) || ws.name;
  send(ws, { t: 'you', you: { id: ws.userId, name: ws.name, color: ws.color } });
}

export async function dispatch(ws, msg) {
  switch (msg.t) {
    case 'hello':
      handleHello(ws, msg);
      break;
    case 'submit':
      await handleSubmit(ws, msg);
      break;
    case 'host':
      handleHost(ws, msg);
      break;
    case 'react':
      handleReact(ws, msg);
      break;
    case 'rename':
      handleRename(ws, msg);
      break;
    case 'ping':
      send(ws, { t: 'pong' });
      break;
    default:
      fail(ws, 'Unknown message.');
  }
}

/** Wire a freshly connected socket into the hub. */
export function attachClient(ws) {
  ws.isAlive = true;
  ws.room = null;
  ws.role = null;
  ws.isHost = false;
  ws.take = makeBucket();

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return fail(ws, 'Bad message.');
    }
    if (!msg || typeof msg !== 'object') return fail(ws, 'Bad message.');
    try {
      await dispatch(ws, msg);
    } catch (err) {
      console.error('[hub] handler failed:', err);
      fail(ws, 'Something went wrong handling that.');
    }
    return undefined;
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.clients.delete(ws);
    R.touch(room);
    broadcast(room, { t: 'presence', ...presenceOf(room) });
  });

  ws.on('error', () => {
    try {
      ws.terminate?.();
    } catch {
      /* already gone */
    }
  });

  return ws;
}
