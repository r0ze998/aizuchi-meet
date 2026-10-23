// Small concurrency helpers: debounce, latest-only async runner, bounded queue, dedupe.
export class Debounce {
  constructor(ms, fn) { this.ms = ms; this.fn = fn; this.t = null; this.args = null; }
  call(...args) {
    this.args = args;
    if (this.t) clearTimeout(this.t);
    this.t = setTimeout(() => { this.t = null; const a = this.args; this.args = null; this.fn(...a); }, this.ms);
  }
  flush() { if (this.t) { clearTimeout(this.t); this.t = null; const a = this.args; this.args = null; if (a) this.fn(...a); } }
  cancel() { if (this.t) clearTimeout(this.t); this.t = null; this.args = null; }
}

// Runs one async task at a time; starting a new one aborts the previous via AbortSignal.
export class LatestOnly {
  constructor() { this.ctrl = null; this.seq = 0; }
  run(task) {
    if (this.ctrl) this.ctrl.abort(new DOMException('superseded', 'AbortError'));
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const seq = ++this.seq;
    let p;
    try { p = Promise.resolve(task(ctrl.signal, seq)); } catch (e) { p = Promise.reject(e); }
    p.finally(() => { if (this.ctrl === ctrl) this.ctrl = null; }).catch(() => {});
    return p;
  }
  cancel(reason = 'cancelled') { if (this.ctrl) this.ctrl.abort(new DOMException(reason, 'AbortError')); this.ctrl = null; }
  isCurrent(seq) { return seq === this.seq; }
  get busy() { return !!this.ctrl; }
}

export class BoundedQueue {
  constructor(max, onDrop) { this.max = max; this.items = []; this.onDrop = onDrop || (() => {}); this.dropped = 0; }
  push(item) {
    if (this.items.length >= this.max) { const d = this.items.shift(); this.dropped++; this.onDrop(d); }
    this.items.push(item);
    return true;
  }
  shift() { return this.items.shift(); }
  get length() { return this.items.length; }
  clear() { this.items = []; }
}

export class Dedupe {
  constructor(ttlMs = 8000) { this.ttl = ttlMs; this.m = new Map(); }
  seen(key, now = Date.now()) {
    for (const [k, t] of this.m) if (now - t > this.ttl) this.m.delete(k);
    if (this.m.has(key)) return true;
    this.m.set(key, now);
    return false;
  }
  clear() { this.m.clear(); }
}

export function isAbort(e) { return e && (e.name === 'AbortError' || e.code === 20); }
