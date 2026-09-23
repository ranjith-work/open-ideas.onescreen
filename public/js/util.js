// Small shared helpers. No framework, no build step — the phone should be
// usable the instant the QR resolves, on whatever browser someone has.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clockTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function codeFromPath() {
  const parts = location.pathname.split('/').filter(Boolean);
  const raw = parts.length > 1 ? parts[1] : '';
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

/** A toast that replaces whatever toast came before it. */
export function makeToast(node) {
  let timer = null;
  return function toast(message, tone = '', ms = 2600) {
    if (!node) return;
    node.textContent = message;
    node.className = node.className.replace(/\b(good|bad)\b/g, '').trim();
    if (tone) node.classList.add(tone);
    node.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      node.hidden = true;
    }, ms);
  };
}

export function hostTokenFor(code) {
  try {
    return localStorage.getItem(`onescreen.host.${code}`) || '';
  } catch {
    return '';
  }
}

export function rememberHostToken(code, token) {
  try {
    localStorage.setItem(`onescreen.host.${code}`, token);
  } catch {
    /* private mode, no big deal — the room still works, just not as host */
  }
}

export function savedName() {
  try {
    return localStorage.getItem('onescreen.name') || '';
  } catch {
    return '';
  }
}

export function saveName(name) {
  try {
    localStorage.setItem('onescreen.name', name);
  } catch {
    /* ignore */
  }
}
