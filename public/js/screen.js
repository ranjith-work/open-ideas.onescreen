import { $, el, clockTime, codeFromPath, makeToast, hostTokenFor } from './util.js';
import { connect } from './bus.js';
import { saveBoardPdf } from './board-pdf.js';

const CODE = codeFromPath();

const screenEl = $('#screen');
const wall = $('#wall');
const emptyEl = $('#empty');
const promptText = $('#promptText');
const lockPill = $('#lockPill');
const qrImg = $('#qrImg');
const joinUrlEl = $('#joinUrl');
const codeBig = $('#codeBig');
const phoneCount = $('#phoneCount');
const itemCount = $('#itemCount');
const connEl = $('#conn');
const hostbar = $('#hostbar');
const spotlight = $('#spotlight');
const spotlightInner = $('#spotlightInner');
const bursts = $('#bursts');
const toast = makeToast($('#toast'));

const items = new Map(); // id -> item, in arrival order
let isHost = false;
let locked = false;
let columns = [];
let ready = false; // true once the first batch is on the board

codeBig.textContent = CODE || '····';

// ---------------------------------------------------------------------------
// Paper character
//
// Every tile is a piece of paper somebody pinned up, so none of them hang
// perfectly straight. The angle is derived from the item id rather than
// random, so a tile keeps its angle through a re-layout instead of twitching.
// ---------------------------------------------------------------------------

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const TILT_RANGE = 1.7; // degrees either side of straight

function tiltFor(id) {
  return (((hash(id) % 2001) / 1000) * TILT_RANGE - TILT_RANGE).toFixed(2);
}

// One paper colour per person, so a room can see at a glance who is talking.
const TINTS = 7;

function tintFor(authorId) {
  return `var(--tint-${(hash(authorId || 'anon') % TINTS) + 1})`;
}

// Photos and link cards bring their own colour; they sit on plain paper so
// nothing fights the picture.
const PLAIN_PAPER = new Set(['photo', 'drawing', 'url']);

// ---------------------------------------------------------------------------
// Room bootstrap: the QR needs the join URL before it can be drawn.
// ---------------------------------------------------------------------------

(async function bootstrap() {
  try {
    const res = await fetch(`/api/rooms/${CODE}`);
    if (!res.ok) {
      showDead(`Room ${CODE} is not open.`);
      return;
    }
    const { joinUrl } = await res.json();
    qrImg.src = `/api/qr.png?s=640&d=${encodeURIComponent(joinUrl)}`;
    joinUrlEl.textContent = joinUrl.replace(/^https?:\/\//, '');
  } catch {
    showDead('Cannot reach the OneScreen server.');
  }
})();

function showDead(message) {
  emptyEl.hidden = false;
  $('.empty-title', emptyEl).textContent = message;
  $('.empty-sub', emptyEl).textContent = 'Open a new room from the home page.';
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function tileFoot(item) {
  return el('div', { class: 'tile-foot' }, [
    el('span', { class: 'tile-who', text: item.by?.name || 'Someone' }),
    el('span', { class: 'tile-time', text: clockTime(item.at) }),
  ]);
}

function imageNode(item) {
  const img = el('img', { class: 'tile-img', src: item.src, alt: item.caption || '' });
  if (item.w && item.h) img.style.aspectRatio = `${item.w} / ${item.h}`;
  // A late-loading image changes column heights, so re-measure once it lands.
  img.addEventListener('load', () => trimOverflow(), { once: true });
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
}

function renderTile(item, { spotlit = false } = {}) {
  const tile = el('article', { class: `tile kind-${item.kind}`, 'data-id': item.id });
  tile.style.setProperty('--tilt', `${tiltFor(item.id)}deg`);
  tile.style.setProperty('--pin', item.by?.color || 'var(--ink-3)');
  if (!PLAIN_PAPER.has(item.kind)) tile.style.setProperty('--tint', tintFor(item.by?.id));

  tile.append(el('span', { class: 'pin' }));

  switch (item.kind) {
    case 'text':
      tile.append(
        el('div', { class: 'tile-body' }, [el('p', { class: 'tile-text', text: item.text })])
      );
      break;

    case 'emoji':
      tile.append(el('div', { class: 'tile-emoji', text: item.emoji }));
      break;

    case 'photo':
    case 'drawing':
      tile.append(imageNode(item));
      if (item.caption) tile.append(el('p', { class: 'tile-caption', text: item.caption }));
      break;

    case 'url': {
      const inner = [];
      if (item.image) {
        inner.push(
          el('img', {
            class: 'tile-link-img',
            src: item.image,
            alt: '',
            referrerpolicy: 'no-referrer',
            onerror(event) {
              event.currentTarget.remove();
              trimOverflow();
            },
            onload: () => trimOverflow(),
          })
        );
      }
      inner.push(
        el('div', { class: 'tile-body' }, [
          el('div', { class: 'tile-domain', text: item.domain || 'link' }),
          el('div', { class: 'tile-link-title', text: item.title || item.url }),
          item.description ? el('div', { class: 'tile-link-desc', text: item.description }) : null,
          item.note ? el('div', { class: 'tile-note', text: item.note }) : null,
        ])
      );
      tile.append(
        el(
          'a',
          { class: 'tile-link', href: item.url, target: '_blank', rel: 'noopener noreferrer' },
          inner
        )
      );
      break;
    }

    default:
      tile.append(el('div', { class: 'tile-body' }, [el('p', { class: 'tile-text', text: '…' })]));
  }

  tile.append(tileFoot(item));

  if (isHost && !spotlit) {
    tile.append(
      el('button', {
        class: 'tile-del',
        title: 'Take this down',
        'aria-label': 'Take this down',
        text: '×',
        onclick: () => bus.send({ t: 'host', action: 'delete', id: item.id }),
      })
    );
  }

  return tile;
}

// ---------------------------------------------------------------------------
// Layout: fixed-height columns, newest at the top, oldest pushed off the
// bottom. A board on a projector should never show a scrollbar.
// ---------------------------------------------------------------------------

function columnCount() {
  const width = wall.clientWidth || window.innerWidth;
  return Math.max(1, Math.min(5, Math.floor(width / 360) || 1));
}

function buildColumns() {
  const wanted = columnCount();
  if (columns.length === wanted) return false;
  wall.replaceChildren();
  columns = [];
  for (let i = 0; i < wanted; i += 1) {
    const col = el('div', { class: 'wall-col' });
    columns.push(col);
    wall.append(col);
  }
  return true;
}

function availableHeight() {
  const cs = getComputedStyle(wall);
  return wall.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
}

function shortestColumn() {
  let best = columns[0];
  for (const col of columns) if (col.offsetHeight < best.offsetHeight) best = col;
  return best;
}

function trimOverflow() {
  const limit = availableHeight();
  if (limit <= 0) return;
  for (const col of columns) {
    let guard = 0;
    while (col.offsetHeight > limit && col.children.length > 1 && guard < 200) {
      col.lastElementChild.remove();
      guard += 1;
    }
  }
}

function placeNewest(item) {
  if (!columns.length) buildColumns();
  shortestColumn().prepend(renderTile(item));
  trimOverflow();
}

/**
 * Put a tile in the shortest column that still has room for it.
 *
 * Simply taking the shortest column is not enough: one tall photo makes its
 * column the tallest forever, so everything else piles into the remaining
 * columns until they overflow and get trimmed, while the photo's column sits
 * there with visible empty space. Trying each column shortest-first and
 * keeping the tile only where it actually fits uses the whole board.
 *
 * Returning false means the board is genuinely full and older work stays off.
 */
function fitOntoBoard(item, limit) {
  const tile = renderTile(item);
  const byHeight = [...columns].sort((a, b) => a.offsetHeight - b.offsetHeight);
  for (const col of byHeight) {
    const wasEmpty = col.children.length === 0;
    col.append(tile);
    // A tile taller than the whole board still goes up; better clipped than absent.
    if (wasEmpty || limit <= 0 || col.offsetHeight <= limit) return true;
    tile.remove();
  }
  return false;
}

/** True once there is no meaningful room left anywhere on the board. */
function boardIsFull(limit) {
  if (limit <= 0) return false;
  return columns.every((col) => col.offsetHeight >= limit - 60);
}

function relayout() {
  buildColumns();
  for (const col of columns) col.replaceChildren();
  const limit = availableHeight();
  for (const item of Array.from(items.values()).reverse()) {
    if (boardIsFull(limit)) break;
    // One oversized photo must not strand every smaller item behind it, so a
    // tile that will not fit is skipped rather than ending the layout.
    fitOntoBoard(item, limit);
  }
  trimOverflow();
  refreshCounts();
}

function refreshCounts() {
  itemCount.textContent = String(items.size);
  emptyEl.hidden = items.size > 0;
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    columns = [];
    relayout();
  }, 160);
});

// ---------------------------------------------------------------------------
// Spotlight: each arrival is held up for the room before it joins the board.
// ---------------------------------------------------------------------------

const spotQueue = [];
let spotTimer = null;
let spotActive = false;

function queueSpotlight(item, force = false) {
  // A link arrives bare and fills in a moment later, so hold its turn until
  // there is something worth looking at.
  if (!force && item.kind === 'url') return;
  spotQueue.push(item);
  while (spotQueue.length > 3) spotQueue.shift();
  if (!spotActive) playSpotlight();
}

function playSpotlight() {
  const item = spotQueue.shift();
  if (!item) {
    closeSpotlight();
    return;
  }
  spotActive = true;
  spotlightInner.replaceChildren(renderTile(item, { spotlit: true }));
  spotlight.classList.remove('closing');
  spotlight.hidden = false;
  const dwell = spotQueue.length ? 1100 : 3200;
  clearTimeout(spotTimer);
  spotTimer = setTimeout(() => (spotQueue.length ? playSpotlight() : closeSpotlight()), dwell);
}

function closeSpotlight() {
  clearTimeout(spotTimer);
  if (spotlight.hidden) {
    spotActive = false;
    return;
  }
  spotlight.classList.add('closing');
  spotTimer = setTimeout(() => {
    spotlight.hidden = true;
    spotActive = false;
    spotlight.classList.remove('closing');
    spotlightInner.replaceChildren();
  }, 300);
}

spotlight.addEventListener('click', () => {
  spotQueue.length = 0;
  closeSpotlight();
});

// ---------------------------------------------------------------------------
// Emoji thrown across the room
// ---------------------------------------------------------------------------

function burst(emoji) {
  if (bursts.childElementCount > 40) return;
  const node = el('div', { class: 'burst', text: emoji });
  node.style.left = `${6 + Math.random() * 84}vw`;
  node.style.animationDelay = `${Math.random() * 140}ms`;
  bursts.append(node);
  setTimeout(() => node.remove(), 4000);
}

// ---------------------------------------------------------------------------
// Lights
//
// The wall ignores the laptop's dark mode on purpose: the right setting
// depends on the room the projector is in, not on the machine driving it.
// ---------------------------------------------------------------------------

const THEME_KEY = 'onescreen.wall-theme';

function setLights(mode) {
  document.documentElement.dataset.theme = mode;
  $('#btnLights').textContent = mode === 'dark' ? 'Lights up' : 'Lights down';
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* storage blocked; the setting just will not persist */
  }
}

function toggleLights() {
  setLights(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

setLights(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

const bus = connect({
  code: CODE,
  role: 'screen',
  hostToken: hostTokenFor(CODE),
  onState(state) {
    connEl.dataset.state = state === 'reconnecting' ? 'connecting' : state;
    connEl.textContent = state === 'live' ? 'live' : state;
  },
  onMessage(msg) {
    switch (msg.t) {
      case 'joined': {
        isHost = Boolean(msg.you?.isHost);
        hostbar.hidden = !isHost;
        applyRoom(msg.room);
        items.clear();
        for (const item of msg.items) items.set(item.id, item);
        columns = [];
        relayout();
        ready = true;
        phoneCount.textContent = String(msg.phones || 0);
        break;
      }

      case 'item': {
        items.set(msg.item.id, msg.item);
        refreshCounts();
        placeNewest(msg.item);
        if (ready) queueSpotlight(msg.item);
        if (msg.item.kind === 'emoji') burst(msg.item.emoji);
        break;
      }

      case 'update': {
        const isFresh = !items.has(msg.item.id) || Date.now() - msg.item.at < 10000;
        items.set(msg.item.id, msg.item);
        const existing = wall.querySelector(`[data-id="${CSS.escape(msg.item.id)}"]`);
        if (existing) existing.replaceWith(renderTile(msg.item));
        trimOverflow();
        if (ready && isFresh && msg.item.kind === 'url') queueSpotlight(msg.item, true);
        break;
      }

      case 'removed': {
        items.delete(msg.id);
        const node = wall.querySelector(`[data-id="${CSS.escape(msg.id)}"]`);
        if (node) {
          node.classList.add('leaving');
          setTimeout(() => {
            node.remove();
            relayout();
          }, 280);
        } else {
          refreshCounts();
        }
        break;
      }

      case 'cleared':
        items.clear();
        columns = [];
        relayout();
        spotQueue.length = 0;
        closeSpotlight();
        break;

      case 'room':
        applyRoom(msg.room);
        break;

      case 'presence':
        phoneCount.textContent = String(msg.phones || 0);
        break;

      case 'burst':
        burst(msg.emoji);
        break;

      case 'spotlight':
        queueSpotlight(msg.item, true);
        break;

      case 'nosuchroom':
        showDead(`Room ${msg.code} is not open.`);
        break;

      case 'error':
        toast(msg.msg);
        break;

      default:
        break;
    }
  },
});

function applyRoom(room) {
  if (!room) return;
  locked = Boolean(room.locked);
  lockPill.hidden = !locked;
  promptText.textContent = room.prompt || 'Send anything';
  $('#btnLock').textContent = locked ? 'Unlock' : 'Lock';
  $('#btnLock').classList.toggle('is-on', locked);
}

// ---------------------------------------------------------------------------
// Host controls
// ---------------------------------------------------------------------------

function toggleQr(force) {
  const hidden = force === undefined ? !screenEl.classList.contains('qr-hidden') : force;
  screenEl.classList.toggle('qr-hidden', hidden);
  $('#btnQr').textContent = hidden ? 'Show QR' : 'Hide QR';
  setTimeout(() => {
    columns = [];
    relayout();
  }, 520);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen was refused.'));
}

function editPrompt() {
  if (!isHost) return;
  const original = promptText.textContent;
  promptText.contentEditable = 'plaintext-only';
  promptText.spellcheck = false;
  promptText.focus();
  document.getSelection()?.selectAllChildren(promptText);

  const finish = (commit) => {
    promptText.contentEditable = 'false';
    promptText.removeEventListener('keydown', onKey);
    promptText.removeEventListener('blur', onBlur);
    const value = promptText.textContent.trim().slice(0, 140);
    if (commit) {
      bus.send({ t: 'host', action: 'prompt', value: value === 'Send anything' ? '' : value });
    } else {
      promptText.textContent = original;
    }
  };
  const onKey = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  promptText.addEventListener('keydown', onKey);
  promptText.addEventListener('blur', onBlur);
}

$('#btnPrompt').addEventListener('click', editPrompt);
$('#btnLock').addEventListener('click', () =>
  bus.send({ t: 'host', action: 'lock', value: !locked })
);
$('#btnQr').addEventListener('click', () => toggleQr());
$('#btnLights').addEventListener('click', toggleLights);
$('#btnFull').addEventListener('click', toggleFullscreen);
$('#btnPdf').addEventListener('click', () => {
  if (!isHost) return;
  if (!items.size) return toast('Nothing on the board to save.');
  toast('Choose “Save as PDF” in the print dialog…');
  saveBoardPdf({
    items: items.values(),
    code: CODE,
    prompt: promptText.textContent.trim(),
  }).catch((err) => toast(err?.message || 'Could not open the PDF view.', 'bad'));
  return undefined;
});
$('#btnClear').addEventListener('click', () => {
  if (!items.size) return toast('Nothing to clear.');
  if (confirm(`Take all ${items.size} things off the board?`)) {
    bus.send({ t: 'host', action: 'clear' });
  }
  return undefined;
});

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || /INPUT|TEXTAREA/.test(target.tagName))
  ) {
    return;
  }
  switch (event.key.toLowerCase()) {
    case 'q':
      toggleQr();
      break;
    case 'd':
      toggleLights();
      break;
    case 'f':
      toggleFullscreen();
      break;
    case 'p':
      editPrompt();
      break;
    case 'l':
      if (isHost) bus.send({ t: 'host', action: 'lock', value: !locked });
      break;
    case 's':
      if (isHost) $('#btnPdf').click();
      break;
    case 'escape':
      spotQueue.length = 0;
      closeSpotlight();
      break;
    default:
      break;
  }
});

buildColumns();
refreshCounts();
