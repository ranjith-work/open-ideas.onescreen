// Entry point: wires the HTTP app and the WebSocket hub onto one server and
// starts listening. All behaviour lives in app.js, hub.js and rooms.js.

import http from 'node:http';

import { WebSocketServer } from 'ws';

import { createApp, bestLanAddress, lanAddresses, DEFAULT_PORT } from './app.js';
import { attachClient } from './hub.js';
import * as R from './rooms.js';

const PORT = DEFAULT_PORT;
const HOST = process.env.HOST || '0.0.0.0';

const app = createApp({ port: PORT });
const server = http.createServer(app);

// 9 MB leaves headroom above the 6 MB image cap so an oversized upload gets a
// readable error from the validator instead of having its socket killed.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 9 * 1024 * 1024 });
wss.on('connection', (ws) => attachClient(ws));

// Drop sockets that stopped answering, so the device count stays honest.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* the close handler will deal with it */
    }
  }
}, 30_000);
heartbeat.unref();

const sweeper = setInterval(() => {
  const expired = R.sweep();
  if (expired.length) console.log(`[sweep] expired rooms: ${expired.join(', ')}`);
}, 60_000);
sweeper.unref();

// `ws` re-emits the HTTP server's errors on itself, so a failed listen lands
// here as well. Without a listener on both, EventEmitter turns a routine
// "port is taken" into an unhandled exception and a stack trace.
function reportFatal(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already taken. Try: PORT=4322 npm start\n`);
  } else if (err.code === 'EPERM' || err.code === 'EACCES') {
    console.error(`\n  Not allowed to listen on ${HOST}:${PORT}.`);
    console.error('  Try another port, or HOST=127.0.0.1 for a local-only run.\n');
  } else {
    console.error('\n  Server failed to start:', err.message, '\n');
  }
  process.exit(1);
}

const FATAL_CODES = new Set(['EADDRINUSE', 'EPERM', 'EACCES', 'EADDRNOTAVAIL']);

server.on('error', reportFatal);

wss.on('error', (err) => {
  if (FATAL_CODES.has(err.code)) reportFatal(err);
  else console.error('[ws] server error:', err.message);
});

server.listen(PORT, HOST, () => {
  const lan = bestLanAddress();
  const lines = ['', '  OneScreen is up.', '', `  On this computer   http://localhost:${PORT}`];
  if (lan) {
    lines.push(`  For phones         http://${lan}:${PORT}`);
    for (const iface of lanAddresses().slice(1)) {
      lines.push(`                     http://${iface.address}:${PORT}`);
    }
  } else {
    lines.push('  No LAN address found. Phones will not be able to reach this machine.');
  }
  lines.push('', '  Open the first link, hit "Open a room", point phones at the QR.', '');
  console.log(lines.join('\n'));
});

function shutdown() {
  console.log('\nClosing OneScreen. Every room is gone now, as promised.');
  clearInterval(heartbeat);
  clearInterval(sweeper);
  for (const ws of wss.clients) ws.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
