// In-memory, ephemeral room store. Nothing is persisted to disk; when the
// process exits, every room and every uploaded byte goes with it. That is the
// product promise, not an oversight.

import crypto from 'node:crypto';

// Ambiguous glyphs removed so a code read off a projector is never misheard.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const MAX_ITEMS = 300;
export const MAX_ROOM_BYTES = 120 * 1024 * 1024; // 120 MB of media per room
export const MAX_MEDIA_BYTES = 6 * 1024 * 1024; // 6 MB per single upload
export const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // rooms evaporate after 6h idle
export const MAX_TEXT_LEN = 600;
export const MAX_NAME_LEN = 24;

export const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const ADJECTIVES = [
  'Amber', 'Brisk', 'Clever', 'Dapper', 'Eager', 'Fuzzy', 'Glad', 'Hazy',
  'Jolly', 'Keen', 'Lucky', 'Mellow', 'Nimble', 'Plucky', 'Quiet', 'Rapid',
  'Sunny', 'Tidy', 'Upbeat', 'Vivid', 'Witty', 'Zesty',
];

const ANIMALS = [
  'Otter', 'Falcon', 'Cactus', 'Walrus', 'Lynx', 'Heron', 'Bison', 'Moth',
  'Koi', 'Tapir', 'Gecko', 'Puffin', 'Yak', 'Marmot', 'Crane', 'Ibex',
  'Panda', 'Raven', 'Seal', 'Toucan', 'Viper', 'Wombat',
];

// Printer's inks rather than screen colours: each one is dark enough to read
// as a pin head on pale paper, and distinct from its neighbours at a distance.
export const AVATAR_COLORS = [
  '#b91c1c', '#c2410c', '#b45309', '#4d7c0f', '#15803d', '#0f766e',
  '#0369a1', '#1d4ed8', '#4338ca', '#7e22ce', '#a21caf', '#be123c',
];

const rooms = new Map();

function randomInt(max) {
  return crypto.randomInt(0, max);
}

function pick(list) {
  return list[randomInt(list.length)];
}

export function makeCode(len = 4) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export function makeId(bytes = 9) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function makeNickname() {
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

export function colorFor(seed) {
  const hash = crypto.createHash('sha1').update(String(seed)).digest();
  return AVATAR_COLORS[hash[0] % AVATAR_COLORS.length];
}

export function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

export function createRoom() {
  let code = makeCode();
  let guard = 0;
  while (rooms.has(code)) {
    guard += 1;
    code = makeCode(guard > 40 ? 5 : 4);
  }

  const room = {
    code,
    hostToken: crypto.randomBytes(24).toString('base64url'),
    createdAt: Date.now(),
    lastActive: Date.now(),
    prompt: '',
    locked: false,
    items: [],
    media: new Map(), // mediaId -> { mime, buf }
    bytes: 0,
    clients: new Set(), // live WebSocket connections
  };

  rooms.set(code, room);
  return room;
}

export function getRoom(code) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return null;
  return room;
}

export function touch(room) {
  room.lastActive = Date.now();
}

/** Public shape of a room, safe to hand to any connected client. */
export function publicRoom(room) {
  return {
    code: room.code,
    prompt: room.prompt,
    locked: room.locked,
    createdAt: room.createdAt,
  };
}

function dropMediaFor(item, room) {
  if (!item || !item.mediaId) return;
  const media = room.media.get(item.mediaId);
  if (!media) return;
  room.bytes -= media.buf.length;
  room.media.delete(item.mediaId);
  if (room.bytes < 0) room.bytes = 0;
}

/**
 * Store an image for a room. Returns the media id.
 * Oldest media is evicted (along with its item) if the room is over budget.
 */
export function putMedia(room, mime, buf) {
  const id = makeId(8);
  room.media.set(id, { mime, buf });
  room.bytes += buf.length;
  return id;
}

/** Evict oldest items until the room fits its media budget. Returns removed ids. */
export function enforceBudget(room) {
  const removed = [];
  while (room.bytes > MAX_ROOM_BYTES && room.items.length > 1) {
    const oldest = room.items.shift();
    dropMediaFor(oldest, room);
    removed.push(oldest.id);
  }
  while (room.items.length > MAX_ITEMS) {
    const oldest = room.items.shift();
    dropMediaFor(oldest, room);
    removed.push(oldest.id);
  }
  return removed;
}

export function addItem(room, item) {
  room.items.push(item);
  touch(room);
  return enforceBudget(room);
}

export function removeItem(room, id) {
  const idx = room.items.findIndex((it) => it.id === id);
  if (idx === -1) return false;
  const [item] = room.items.splice(idx, 1);
  dropMediaFor(item, room);
  touch(room);
  return true;
}

export function clearRoom(room) {
  room.items = [];
  room.media.clear();
  room.bytes = 0;
  touch(room);
}

export function destroyRoom(room) {
  clearRoom(room);
  rooms.delete(room.code);
}

export function roomCount() {
  return rooms.size;
}

export function stats() {
  let items = 0;
  let bytes = 0;
  let clients = 0;
  for (const room of rooms.values()) {
    items += room.items.length;
    bytes += room.bytes;
    clients += room.clients.size;
  }
  return { rooms: rooms.size, items, bytes, clients };
}

/** Delete rooms that nobody has touched in a long time. */
export function sweep(now = Date.now()) {
  const killed = [];
  for (const room of rooms.values()) {
    const idle = now - room.lastActive;
    if (idle > ROOM_TTL_MS && room.clients.size === 0) {
      destroyRoom(room);
      killed.push(room.code);
    }
  }
  return killed;
}
