// Build a printable snapshot of every tile on the board and hand it to the
// browser's print dialog. Choosing "Save as PDF" there keeps the full board
// with no viewport crop and no artificial page cap — the printer paginates.

import { clockTime } from './util.js';

function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : doc.createTextNode(String(child)));
  }
  return node;
}

function cardFor(doc, item) {
  const card = el(doc, 'article', { class: `card kind-${item.kind}` });
  card.append(
    el(doc, 'header', { class: 'card-head' }, [
      el(doc, 'span', { class: 'who', text: item.by?.name || 'Someone' }),
      el(doc, 'span', { class: 'when', text: clockTime(item.at) }),
    ])
  );

  switch (item.kind) {
    case 'text':
      card.append(el(doc, 'p', { class: 'body text', text: item.text || '' }));
      break;
    case 'emoji':
      card.append(el(doc, 'p', { class: 'body emoji', text: item.emoji || '' }));
      break;
    case 'photo':
    case 'drawing': {
      if (item.src) {
        card.append(el(doc, 'img', { class: 'media', src: item.src, alt: item.caption || '' }));
      }
      if (item.caption) card.append(el(doc, 'p', { class: 'caption', text: item.caption }));
      break;
    }
    case 'url': {
      if (item.image) {
        card.append(
          el(doc, 'img', {
            class: 'media link-img',
            src: item.image,
            alt: '',
            referrerpolicy: 'no-referrer',
          })
        );
      }
      card.append(el(doc, 'p', { class: 'domain', text: item.domain || 'link' }));
      card.append(el(doc, 'p', { class: 'link-title', text: item.title || item.url || '' }));
      if (item.description) {
        card.append(el(doc, 'p', { class: 'link-desc', text: item.description }));
      }
      if (item.note) card.append(el(doc, 'p', { class: 'note', text: item.note }));
      if (item.url) card.append(el(doc, 'p', { class: 'url', text: item.url }));
      break;
    }
    default:
      card.append(el(doc, 'p', { class: 'body text', text: '…' }));
  }

  return card;
}

const PRINT_CSS = `
  @page { margin: 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: #1c1915;
    background: #fff;
    font: 14px/1.45 "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  }
  .mast {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 16px;
    border-bottom: 1px solid #d6d0c4;
    padding-bottom: 10px;
    margin-bottom: 18px;
  }
  .wordmark { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; }
  .meta { color: #6b655c; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; }
  .prompt {
    font-size: 22px;
    margin: 0 0 18px;
    letter-spacing: -0.02em;
  }
  .grid {
    column-width: 220px;
    column-gap: 14px;
  }
  .card {
    break-inside: avoid;
    page-break-inside: avoid;
    border: 1px solid #d6d0c4;
    border-radius: 2px;
    padding: 10px 12px 12px;
    margin: 0 0 14px;
    background: #f7f3ea;
    -webkit-column-break-inside: avoid;
  }
  .card-head {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font: 11px/1.3 ui-sans-serif, system-ui, sans-serif;
    color: #6b655c;
    margin-bottom: 8px;
  }
  .body.text { margin: 0; white-space: pre-wrap; word-break: break-word; }
  .body.emoji {
    margin: 0;
    font-size: 56px;
    line-height: 1.1;
    text-align: center;
    padding: 12px 0;
  }
  .media {
    display: block;
    width: 100%;
    height: auto;
    max-height: 420px;
    object-fit: contain;
    background: #efe9dc;
  }
  .caption, .note, .link-desc, .url {
    margin: 8px 0 0;
    font-size: 12px;
    color: #3f3a34;
    word-break: break-word;
  }
  .domain {
    margin: 6px 0 0;
    font: 10px/1.3 ui-sans-serif, system-ui, sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #8a8378;
  }
  .link-title { margin: 4px 0 0; font-weight: 600; word-break: break-word; }
  .empty {
    color: #6b655c;
    font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
  }
  @media print {
    body { background: #fff; }
    .card { box-shadow: none; }
  }
`;

function waitForImages(doc, timeoutMs = 20000) {
  const images = Array.from(doc.images || []);
  if (!images.length) return Promise.resolve();
  return Promise.race([
    Promise.all(
      images.map(
        (img) =>
          new Promise((resolve) => {
            if (img.complete) {
              resolve();
              return;
            }
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          })
      )
    ),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * Open a print view of every item currently on the board.
 * @param {object} opts
 * @param {Iterable<object>} opts.items
 * @param {string} opts.code
 * @param {string} [opts.prompt]
 */
export async function saveBoardPdf({ items, code, prompt = '' }) {
  const list = Array.from(items).sort((a, b) => (b.at || 0) - (a.at || 0));
  const stamp = new Date().toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const win = window.open('', '_blank', 'noopener,noreferrer');
  if (!win) {
    throw new Error('Pop-up blocked — allow pop-ups for this site to save the board.');
  }

  const doc = win.document;
  doc.open();
  doc.write('<!doctype html><html><head></head><body></body></html>');
  doc.close();

  doc.title = `OneScreen ${code || ''}`.trim();
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  doc.head.append(charset);
  doc.head.append(el(doc, 'style', { text: PRINT_CSS }));

  doc.body.append(
    el(doc, 'div', { class: 'mast' }, [
      el(doc, 'div', { class: 'wordmark', text: 'OneScreen' }),
      el(doc, 'div', {
        class: 'meta',
        text: `Room ${code || '····'} · ${stamp} · ${list.length} on the board`,
      }),
    ])
  );
  doc.body.append(el(doc, 'h1', { class: 'prompt', text: prompt || 'Send anything' }));

  if (!list.length) {
    doc.body.append(el(doc, 'p', { class: 'empty', text: 'Nothing was on the board.' }));
  } else {
    const grid = el(doc, 'div', { class: 'grid' });
    for (const item of list) grid.append(cardFor(doc, item));
    doc.body.append(grid);
  }

  await waitForImages(doc);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const closeLater = () => {
    try {
      win.close();
    } catch {
      /* already gone */
    }
  };
  win.addEventListener('afterprint', closeLater, { once: true });
  setTimeout(closeLater, 60_000);

  win.focus();
  win.print();
}
