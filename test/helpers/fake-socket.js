// A fake WebSocket that satisfies everything the hub needs, so the whole room
// protocol can be exercised in-process with no network.

import { EventEmitter } from 'node:events';

export class FakeSocket extends EventEmitter {
  constructor(label = 'client') {
    super();
    this.label = label;
    this.readyState = 1; // OPEN
    this.sent = [];
    this.terminated = false;
  }

  send(payload) {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(JSON.parse(payload));
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }

  /** Deliver a client -> server message and wait for handlers to settle. */
  async tell(obj) {
    this.emit('message', JSON.stringify(obj));
    await tick();
  }

  /** Every message of a given type that this socket received. */
  all(type) {
    return this.sent.filter((m) => m.t === type);
  }

  /** The most recent message of a given type, or undefined. */
  last(type) {
    const matching = this.all(type);
    return matching[matching.length - 1];
  }

  clear() {
    this.sent = [];
  }
}

/** Let queued microtasks and immediates run. */
export function tick(times = 3) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return chain;
}

/**
 * Poll until `predicate` returns something truthy, or give up.
 * Used for work that waits on real latency, such as a DNS lookup.
 */
export async function waitFor(predicate, { timeout = 5000, every = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = predicate();
    if (result) return result;
    if (Date.now() > deadline) return null;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/** A 1x1 transparent PNG, as a data URL. */
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk' +
  'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
