import { $, el, rememberHostToken } from './util.js';

const openBtn = $('#openRoom');
const joinForm = $('#joinForm');
const joinCode = $('#joinCode');
const joinHint = $('#joinHint');
const netHint = $('#netHint');

openBtn.addEventListener('click', async () => {
  const label = openBtn.textContent;
  openBtn.disabled = true;
  openBtn.textContent = 'Opening…';
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error('create failed');
    const data = await res.json();
    rememberHostToken(data.code, data.hostToken);
    location.href = `/s/${data.code}`;
  } catch {
    openBtn.disabled = false;
    openBtn.textContent = label;
    joinHint.textContent = 'Could not reach the server. Is it still running?';
  }
});

joinCode.addEventListener('input', () => {
  joinCode.value = joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  joinHint.textContent = '';
});

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = joinCode.value.trim();
  if (code.length < 4) {
    joinHint.textContent = 'Room codes are four characters.';
    return;
  }
  joinHint.textContent = '';
  try {
    const res = await fetch(`/api/rooms/${code}`);
    if (!res.ok) {
      joinHint.textContent = `No room called ${code}. It may have already closed.`;
      return;
    }
    location.href = `/j/${code}`;
  } catch {
    joinHint.textContent = 'Could not reach the server.';
  }
});

// Tell the host, up front, which address phones should actually be pointed at.
(async () => {
  try {
    const res = await fetch('/api/net');
    const net = await res.json();
    const onLoopback = /^(localhost|127\.0\.0\.1|\[::1\])/.test(location.host);
    if (onLoopback && net.origin && !net.origin.includes('localhost')) {
      netHint.replaceChildren(
        document.createTextNode('Phones on this Wi-Fi should reach you at '),
        el('code', { text: net.origin }),
        document.createTextNode('. The QR will use it automatically.')
      );
    } else {
      netHint.textContent = 'Rooms are kept in memory only and disappear when this server stops.';
    }
  } catch {
    netHint.textContent = '';
  }
})();
