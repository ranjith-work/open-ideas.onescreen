import { $, $$, el, codeFromPath, makeToast, savedName, saveName } from './util.js';
import { connect } from './bus.js';

const CODE = codeFromPath();
const toast = makeToast($('#toast'));

const connEl = $('#conn');
const phonePrompt = $('#phonePrompt');
const lockedNote = $('#lockedNote');
const sentLog = $('#sentLog');
const whoName = $('#whoName');
const whoDot = $('#whoDot');

$('#phoneCode').textContent = CODE || '····';

let locked = false;
let me = null;

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

const bus = connect({
  code: CODE,
  role: 'phone',
  name: savedName(),
  onState(state) {
    connEl.dataset.state = state === 'reconnecting' ? 'connecting' : state;
  },
  onMessage(msg) {
    switch (msg.t) {
      case 'joined':
        me = msg.you;
        paintMe();
        applyRoom(msg.room);
        break;
      case 'you':
        me = { ...me, ...msg.you };
        paintMe();
        break;
      case 'room':
        applyRoom(msg.room);
        break;
      case 'sent':
        logSent(msg.kind);
        break;
      case 'error':
        toast(msg.msg, 'bad');
        break;
      case 'nosuchroom':
        phonePrompt.textContent = `Room ${msg.code} is closed.`;
        $('#tabs').hidden = true;
        $('.panels').hidden = true;
        break;
      default:
        break;
    }
  },
});

function paintMe() {
  if (!me) return;
  whoName.textContent = me.name;
  whoDot.style.background = me.color;
}

function applyRoom(room) {
  if (!room) return;
  locked = Boolean(room.locked);
  lockedNote.hidden = !locked;
  if (locked) $('.phone-foot').classList.add('is-live');
  phonePrompt.textContent = room.prompt || 'Send anything to the big screen.';
}

const KIND_WORDS = {
  text: 'sent',
  emoji: 'emoji',
  photo: 'photo',
  drawing: 'drawing',
  url: 'link',
};

function logSent(kind) {
  const chip = el('span', {
    class: 'sent-chip',
    text: `${KIND_WORDS[kind] || kind} · on the wall`,
  });
  sentLog.prepend(chip);
  while (sentLog.children.length > 6) sentLog.lastElementChild.remove();
  $('.phone-foot').classList.add('is-live');
}

function guardLocked() {
  if (!locked) return false;
  toast('The host locked the wall.', 'bad');
  return true;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('is-on', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('is-on', p.dataset.panel === tab.dataset.tab));
    if (tab.dataset.tab === 'draw') sizePad();
  });
});

// ---------------------------------------------------------------------------
// Say
// ---------------------------------------------------------------------------

const textInput = $('#textInput');
const textCount = $('#textCount');

textInput.addEventListener('input', () => {
  textCount.textContent = `${textInput.value.length} / 600`;
});

function sendText() {
  if (guardLocked()) return;
  const text = textInput.value.trim();
  if (!text) {
    toast('Nothing to send yet.');
    return;
  }
  bus.send({ t: 'submit', kind: 'text', text });
  textInput.value = '';
  textCount.textContent = '0 / 600';
  toast('On the screen.', 'good', 1400);
}

$('#sendText').addEventListener('click', sendText);
textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    sendText();
  }
});

// ---------------------------------------------------------------------------
// Photo — everything is downscaled on the phone so a 12 MP shot does not
// crawl across the Wi-Fi while everyone waits.
// ---------------------------------------------------------------------------

const photoPreview = $('#photoPreview');
const photoEmpty = $('#photoEmpty');
const sendPhotoBtn = $('#sendPhoto');
let pendingPhoto = null;

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

async function downscale(file, maxDim = 1600, quality = 0.82) {
  const source = await loadBitmap(file);
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  if (!sw || !sh) throw new Error('empty image');

  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  if (source.close) source.close();

  let data = canvas.toDataURL('image/jpeg', quality);
  // Two fallback passes keep us under the server cap even for odd sources.
  for (let q = quality - 0.18; data.length > 5.2e6 && q > 0.3; q -= 0.18) {
    data = canvas.toDataURL('image/jpeg', q);
  }
  return { data, w, h };
}

async function takePhoto(file) {
  if (!file) return;
  sendPhotoBtn.disabled = true;
  sendPhotoBtn.textContent = 'Preparing…';
  try {
    pendingPhoto = await downscale(file);
    photoPreview.src = pendingPhoto.data;
    photoPreview.hidden = false;
    photoEmpty.hidden = true;
    sendPhotoBtn.disabled = false;
  } catch {
    pendingPhoto = null;
    toast('Could not read that image.', 'bad');
  } finally {
    sendPhotoBtn.textContent = 'Send photo';
  }
}

$('#photoCamera').addEventListener('change', (e) => takePhoto(e.target.files?.[0]));
$('#photoLibrary').addEventListener('change', (e) => takePhoto(e.target.files?.[0]));

sendPhotoBtn.addEventListener('click', () => {
  if (guardLocked() || !pendingPhoto) return;
  bus.send({
    t: 'submit',
    kind: 'photo',
    data: pendingPhoto.data,
    w: pendingPhoto.w,
    h: pendingPhoto.h,
    caption: $('#photoCaption').value.trim(),
  });
  pendingPhoto = null;
  photoPreview.hidden = true;
  photoPreview.removeAttribute('src');
  photoEmpty.hidden = false;
  $('#photoCaption').value = '';
  $('#photoCamera').value = '';
  $('#photoLibrary').value = '';
  sendPhotoBtn.disabled = true;
  toast('On the screen.', 'good', 1400);
});

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

const pad = $('#pad');
const pctx = pad.getContext('2d');
const PAPER = '#fffdf8';
// Inks, not screen colours. They have to stay legible once the drawing is
// shrunk to a tile on the far wall.
const PEN_COLORS = ['#1b1a17', '#c2401f', '#b45309', '#4d7c0f', '#0f766e', '#1d4ed8', '#7e22ce'];
const PEN_SIZES = [3, 7, 14];

let strokes = [];
let current = null;
let penColor = PEN_COLORS[0];
let penSize = PEN_SIZES[1];
let dpr = 1;

function buildPens() {
  const pens = $('#pens');
  pens.replaceChildren();
  PEN_COLORS.forEach((color, i) => {
    const btn = el('button', {
      class: `pen${i === 0 ? ' is-on' : ''}`,
      style: { background: color },
      'aria-label': `Pen colour ${i + 1}`,
      onclick() {
        penColor = color;
        $$('.pen').forEach((p) => p.classList.toggle('is-on', p === btn));
      },
    });
    pens.append(btn);
  });

  const sizes = el('div', { class: 'pen-size' });
  PEN_SIZES.forEach((size, i) => {
    const btn = el(
      'button',
      {
        class: `size${i === 1 ? ' is-on' : ''}`,
        'aria-label': `Brush size ${i + 1}`,
        onclick() {
          penSize = size;
          $$('.size').forEach((s) => s.classList.toggle('is-on', s === btn));
        },
      },
      [el('i', { style: { width: `${size + 3}px`, height: `${size + 3}px` } })]
    );
    sizes.append(btn);
  });
  pens.append(sizes);
}

function sizePad() {
  const rect = pad.getBoundingClientRect();
  if (!rect.width) return;
  dpr = Math.min(3, window.devicePixelRatio || 1);
  pad.width = Math.round(rect.width * dpr);
  pad.height = Math.round(rect.height * dpr);
  redraw();
}

function redraw() {
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.fillStyle = PAPER;
  pctx.fillRect(0, 0, pad.width, pad.height);
  pctx.scale(dpr, dpr);
  pctx.lineCap = 'round';
  pctx.lineJoin = 'round';
  for (const stroke of strokes) drawStroke(stroke);
}

function drawStroke(stroke) {
  if (stroke.points.length < 2) {
    const [p] = stroke.points;
    if (!p) return;
    pctx.fillStyle = stroke.color;
    pctx.beginPath();
    pctx.arc(p.x, p.y, stroke.size / 2, 0, Math.PI * 2);
    pctx.fill();
    return;
  }
  pctx.strokeStyle = stroke.color;
  pctx.lineWidth = stroke.size;
  pctx.beginPath();
  pctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let i = 1; i < stroke.points.length; i += 1) {
    const prev = stroke.points[i - 1];
    const point = stroke.points[i];
    pctx.quadraticCurveTo(prev.x, prev.y, (prev.x + point.x) / 2, (prev.y + point.y) / 2);
  }
  pctx.stroke();
}

function padPoint(event) {
  const rect = pad.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

pad.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  pad.setPointerCapture(event.pointerId);
  current = { color: penColor, size: penSize, points: [padPoint(event)] };
  strokes.push(current);
  redraw();
});

pad.addEventListener('pointermove', (event) => {
  if (!current) return;
  event.preventDefault();
  const point = padPoint(event);
  const last = current.points[current.points.length - 1];
  if (Math.hypot(point.x - last.x, point.y - last.y) < 1.2) return;
  current.points.push(point);
  redraw();
});

const endStroke = () => {
  current = null;
};
pad.addEventListener('pointerup', endStroke);
pad.addEventListener('pointercancel', endStroke);
pad.addEventListener('pointerleave', endStroke);

$('#undoDraw').addEventListener('click', () => {
  strokes.pop();
  redraw();
});

$('#clearDraw').addEventListener('click', () => {
  strokes = [];
  redraw();
});

$('#sendDraw').addEventListener('click', () => {
  if (guardLocked()) return;
  if (!strokes.length) {
    toast('Draw something first.');
    return;
  }
  const data = pad.toDataURL('image/jpeg', 0.9);
  bus.send({
    t: 'submit',
    kind: 'drawing',
    data,
    w: pad.width,
    h: pad.height,
  });
  strokes = [];
  redraw();
  toast('On the screen.', 'good', 1400);
});

buildPens();
window.addEventListener('resize', () => {
  if ($('.panel[data-panel="draw"]').classList.contains('is-on')) sizePad();
});
sizePad();

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------

$('#sendLink').addEventListener('click', () => {
  if (guardLocked()) return;
  const url = $('#linkInput').value.trim();
  if (!url) {
    toast('Paste a link first.');
    return;
  }
  bus.send({ t: 'submit', kind: 'url', url, note: $('#linkNote').value.trim() });
  $('#linkInput').value = '';
  $('#linkNote').value = '';
  toast('Sent. The screen is fetching a preview.', 'good', 2000);
});

// ---------------------------------------------------------------------------
// Emoji — tap flings it across the screen, hold pins it as a tile.
// ---------------------------------------------------------------------------

const EMOJI = [
  '😂', '🔥', '❤️', '👏', '🎉', '😮', '👀', '💯',
  '🤔', '😅', '🙌', '✨', '🚀', '🍕', '☕️', '🧠',
  '👍', '👎', '🥹', '😴', '🤯', '🫠', '🐝', '🌈',
];

const emojiGrid = $('#emojiGrid');

EMOJI.forEach((emoji) => {
  const btn = el('button', { class: 'emoji-btn', text: emoji, type: 'button' });
  let holdTimer = null;
  let held = false;

  const start = () => {
    held = false;
    holdTimer = setTimeout(() => {
      held = true;
      if (guardLocked()) return;
      bus.send({ t: 'submit', kind: 'emoji', emoji });
      btn.classList.add('pinned');
      setTimeout(() => btn.classList.remove('pinned'), 420);
      if (navigator.vibrate) navigator.vibrate(18);
      toast('Pinned to the wall.', 'good', 1200);
    }, 420);
  };

  const end = (event) => {
    clearTimeout(holdTimer);
    if (held) {
      event.preventDefault();
      return;
    }
    if (guardLocked()) return;
    bus.send({ t: 'react', emoji });
  };

  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', () => clearTimeout(holdTimer));
  btn.addEventListener('pointerleave', () => clearTimeout(holdTimer));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  emojiGrid.append(btn);
});

// ---------------------------------------------------------------------------
// Name
// ---------------------------------------------------------------------------

const nameSheet = $('#nameSheet');
const nameInput = $('#nameInput');

$('#whoBtn').addEventListener('click', () => {
  nameInput.value = me?.name || '';
  if (typeof nameSheet.showModal === 'function') nameSheet.showModal();
  else {
    const value = window.prompt('What should the screen call you?', nameInput.value);
    if (value) commitName(value);
  }
});

$('#nameForm').addEventListener('submit', (event) => {
  if (event.submitter?.value !== 'save') return;
  commitName(nameInput.value);
});

function commitName(raw) {
  const name = String(raw || '').trim().slice(0, 24);
  if (!name) return;
  saveName(name);
  bus.send({ t: 'rename', name });
}
