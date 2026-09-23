// WebSocket connection with automatic reconnect.
//
// Phones lock, tabs sleep, Wi-Fi drops as people walk around a room. A dropped
// socket has to heal itself without anybody noticing, and re-announce the room
// on the way back in.

export function connect({ code, role, hostToken = '', name = '', onMessage, onState }) {
  let ws = null;
  let attempts = 0;
  let stopped = false;
  let retryTimer = null;
  let pingTimer = null;
  const queue = [];

  const state = (s) => {
    if (typeof onState === 'function') onState(s);
  };

  function flush() {
    while (queue.length && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(queue.shift()));
    }
  }

  function open() {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      scheduleRetry();
      return;
    }
    state(attempts === 0 ? 'connecting' : 'reconnecting');

    ws.onopen = () => {
      attempts = 0;
      state('live');
      ws.send(JSON.stringify({ t: 'hello', code, role, hostToken, name }));
      flush();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }));
      }, 25000);
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') return;
      onMessage(msg);
    };

    ws.onclose = () => {
      clearInterval(pingTimer);
      if (stopped) return;
      state('down');
      scheduleRetry();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
  }

  function scheduleRetry() {
    attempts += 1;
    const backoff = Math.min(6000, 350 * 2 ** Math.min(attempts, 5));
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, backoff + Math.random() * 250);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    if (queue.length < 12) queue.push(obj);
    return false;
  }

  // Coming back from a locked phone should feel instant, not like a 6s wait.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (stopped) return;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      clearTimeout(retryTimer);
      attempts = 0;
      open();
    }
  });

  window.addEventListener('online', () => {
    if (stopped) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearTimeout(retryTimer);
      attempts = 0;
      open();
    }
  });

  open();

  return {
    send,
    get ready() {
      return Boolean(ws && ws.readyState === WebSocket.OPEN);
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
  };
}
