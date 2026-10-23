// Minimal Chrome DevTools Protocol client over WebSocket (Bun has WebSocket built in).
import fs from 'node:fs';

export class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); ws.onmessage = (m) => this.onMessage(JSON.parse(m.data)); ws.onclose = () => { for (const { rej } of this.pending.values()) rej(new Error('cdp closed')); this.pending.clear(); }; }
  static connect(url) { return new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(new CDP(ws)); ws.onerror = (e) => rej(new Error('ws error ' + (e?.message || ''))); }); }
  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) { const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) rej(new Error(`${msg.error.message}${msg.error.data ? ': ' + msg.error.data : ''}`)); else res(msg.result); return; }
    if (msg.method) { for (const h of this.handlers.get(msg.method) || []) h(msg.params, msg.sessionId); }
  }
  send(method, params = {}, sessionId) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); }
  on(method, h) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(h); }
  async targets() { return (await this.send('Target.getTargets')).targetInfos; }
  async waitForTarget(pred, timeout = 15000, label = 'target') {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const t = (await this.targets()).find(pred); if (t) return t; await Bun.sleep(150); }
    throw new Error(`${label} not found within ${timeout}ms. Targets: ${(await this.targets()).map((t) => `${t.type}:${t.url}`).join(' | ')}`);
  }
  async attach(targetId) { const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }); await this.send('Runtime.enable', {}, sessionId).catch(() => {}); return sessionId; }
  async evaluate(sessionId, expression, { userGesture = false, timeout = 20000 } = {}) {
    let timer;
    const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`evaluate timeout after ${timeout}ms: ${expression.slice(0, 80)}`)), timeout); });
    const r = await Promise.race([this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture, timeout }, sessionId), guard]).finally(() => clearTimeout(timer));
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
    return r.result?.value;
  }
  async openTab(url, { background = false } = {}) { const { targetId } = await this.send('Target.createTarget', { url, background }); return targetId; }
  async activate(targetId) { return this.send('Target.activateTarget', { targetId }); }
  async closeTab(targetId) { return this.send('Target.closeTarget', { targetId }); }
  async emulate(sessionId, { width = 420, height = 860 } = {}) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, sessionId); }
  async screenshot(sessionId, file, { fullPage = false } = {}) {
    await this.send('Page.enable', {}, sessionId).catch(() => {});
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, fromSurface: true }, sessionId);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

export async function waitFor(fn, pred, { timeout = 10000, interval = 150, label = 'condition' } = {}) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { last = await fn(); if (pred(last)) return last; await Bun.sleep(interval); }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)?.slice(0, 300)}`);
}
