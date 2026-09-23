// The HTTP surface. Exported without calling listen() so it can be driven
// directly in tests.

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import express from 'express';
import QRCode from 'qrcode';

import * as R from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export const DEFAULT_PORT = Number(process.env.PORT || 4321);

/** Every non-internal IPv4 address, Wi-Fi style interfaces first. */
export function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' && iface.family !== 4) continue;
      if (iface.internal) continue;
      found.push({ name, address: iface.address });
    }
  }
  const score = (n) => (/^(en|wl|wlan|wi)/i.test(n) ? 0 : 1);
  found.sort((a, b) => score(a.name) - score(b.name));
  return found;
}

export function bestLanAddress() {
  const list = lanAddresses();
  return list.length ? list[0].address : null;
}

export function isLoopbackHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  );
}

/**
 * The origin to put inside the QR code.
 *
 * The host opens the wall on http://localhost, but a phone that scans
 * "localhost" just gets its own browser. So whenever the page was served over
 * loopback we swap in this machine's LAN address instead.
 */
export function externalOrigin(req, port = DEFAULT_PORT) {
  const rawHost = req.get('x-forwarded-host') || req.get('host') || `localhost:${port}`;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const hostname = rawHost.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

  if (!isLoopbackHost(hostname)) return `${proto}://${rawHost}`;

  const lan = bestLanAddress();
  if (!lan) return `${proto}://${rawHost}`;
  const boundPort = (rawHost.match(/:(\d+)$/) || [])[1] || String(port);
  return `${proto}://${lan}:${boundPort}`;
}

export function createApp({ port = DEFAULT_PORT } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '256kb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      maxAge: '1h',
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  const page = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));

  app.get('/', page('index.html'));
  app.get('/s/:code', page('screen.html'));
  app.get('/j/:code', page('join.html'));
  app.get('/j', page('join.html'));

  // Create a room. The host token is handed out exactly once, to the creator.
  app.post('/api/rooms', (req, res) => {
    const room = R.createRoom();
    const origin = externalOrigin(req, port);
    res.json({
      code: room.code,
      hostToken: room.hostToken,
      joinUrl: `${origin}/j/${room.code}`,
      screenUrl: `${origin}/s/${room.code}`,
      origin,
    });
  });

  app.get('/api/rooms/:code', (req, res) => {
    const room = R.getRoom(req.params.code);
    if (!room) return res.status(404).json({ ok: false, error: 'no_such_room' });
    const origin = externalOrigin(req, port);
    return res.json({
      ok: true,
      room: R.publicRoom(room),
      joinUrl: `${origin}/j/${room.code}`,
      items: room.items.length,
    });
  });

  app.get('/api/net', (req, res) => {
    res.json({ origin: externalOrigin(req, port), interfaces: lanAddresses(), port });
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), ...R.stats() });
  });

  // QR image, generated server-side so the screen page ships no QR library.
  app.get('/api/qr.png', async (req, res) => {
    const data = String(req.query.d || '').slice(0, 512);
    const size = Math.min(1200, Math.max(120, Number(req.query.s) || 640));
    if (!data) return res.status(400).json({ ok: false, error: 'missing_d' });
    try {
      const buf = await QRCode.toBuffer(data, {
        type: 'png',
        width: size,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#0b0d12ff', light: '#ffffffff' },
      });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end(buf);
    } catch {
      return res.status(500).json({ ok: false, error: 'qr_failed' });
    }
  });

  // Media is held in RAM and served straight back out of its room.
  app.get('/m/:code/:id', (req, res) => {
    const room = R.getRoom(req.params.code);
    if (!room) return res.status(404).end();
    const media = room.media.get(req.params.id);
    if (!media) return res.status(404).end();
    res.setHeader('Content-Type', media.mime);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Content-Length', String(media.buf.length));
    return res.end(media.buf);
  });

  // Anything unrecognised lands on the home page rather than a raw 404.
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html')));

  return app;
}
