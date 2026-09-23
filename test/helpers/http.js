// Drive the Express app without binding a socket.
//
// We construct a real IncomingMessage and a real ServerResponse, then capture
// the response body by replacing write/end. This exercises the actual routing,
// middleware and serialisation code rather than a stub of it.

import http from 'node:http';
import { Readable } from 'node:stream';

function makeRequest(method, url, { headers = {}, body = null } = {}) {
  const req = new Readable({ read() {} });
  req.method = method.toUpperCase();
  req.url = url;
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.headers = { host: 'localhost:4321', connection: 'close', ...headers };
  req.rawHeaders = Object.entries(req.headers).flat();
  req.socket = req.connection = {
    remoteAddress: '127.0.0.1',
    encrypted: false,
    destroyed: false,
    writable: true,
    setTimeout() {},
    setNoDelay() {},
    setKeepAlive() {},
  };
  if (body !== null) req.push(typeof body === 'string' ? body : Buffer.from(body));
  req.push(null);
  return req;
}

export function request(app, method, url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = makeRequest(method, url, options);
    const res = new http.ServerResponse(req);
    const chunks = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks);
      const headers = res.getHeaders();
      const type = String(headers['content-type'] || '');
      let json = null;
      if (type.includes('application/json')) {
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          json = null;
        }
      }
      resolve({
        status: res.statusCode,
        headers,
        body,
        text: body.toString('utf8'),
        json,
      });
    };

    res.write = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
      const cb = typeof encoding === 'function' ? encoding : callback;
      if (cb) cb();
      return true;
    };

    res.end = (chunk, encoding, callback) => {
      if (chunk && typeof chunk !== 'function') {
        chunks.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
      }
      const cb = [chunk, encoding, callback].find((v) => typeof v === 'function');
      if (cb) cb();
      res.emit('finish');
      finish();
      return res;
    };

    res.on('error', reject);
    setTimeout(() => reject(new Error(`request to ${url} timed out`)), 5000).unref();

    app(req, res);
  });
}

export const get = (app, url, options) => request(app, 'GET', url, options);

export const postJson = (app, url, payload = {}) =>
  request(app, 'POST', url, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
