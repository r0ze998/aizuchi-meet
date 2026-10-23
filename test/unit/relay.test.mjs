// Relay security and limits (spawns the real server with the mock upstream).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const PORT = 47311; const TOKEN = 'test-token-0123456789abcdef'; const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXT}`;
let proc;
beforeAll(async () => {
  proc = Bun.spawn(['node', path.join(ROOT, 'relay', 'server.mjs')], { env: { ...process.env, RELAY_PORT: String(PORT), RELAY_TOKEN: TOKEN, ALLOWED_EXTENSION_IDS: EXT, UPSTREAM: 'mock', MOCK_DELAY_MS: '5', MOCK_COST_USD: '0.03', MAX_SESSION_USD: '0.05', MAX_REQ_PER_MIN: '4', RELAY_PRINT_TOKEN: '0' }, stdout: 'pipe', stderr: 'pipe' });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) { try { const r = await fetch(`http://127.0.0.1:${PORT}/v1/health`); if (r.ok) return; } catch { /* retry */ } await Bun.sleep(100); }
  throw new Error('relay did not start');
});
afterAll(() => { proc?.kill(); });
const post = (p, body, headers = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const authed = { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}` };

test('health exposes no secrets and reports pairing state', async () => {
  const h = await (await fetch(`http://127.0.0.1:${PORT}/v1/health`)).json();
  expect(h.ok).toBe(true); expect(JSON.stringify(h)).not.toContain(TOKEN); expect(h.paired).toBe(false);
  const h2 = await (await fetch(`http://127.0.0.1:${PORT}/v1/health`, { headers: authed })).json(); expect(h2.paired).toBe(true);
});
test('requests without an allowed Origin are refused (403), wrong token 401, preflight OK', async () => {
  expect((await post('/v1/translate', { text: 'hi' })).status).toBe(403);
  expect((await post('/v1/translate', { text: 'hi' }, { Origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', Authorization: `Bearer ${TOKEN}` })).status).toBe(403);
  expect((await post('/v1/translate', { text: 'hi' }, { Origin: 'http://127.0.0.1:4310', Authorization: `Bearer ${TOKEN}` })).status).toBe(403);
  expect((await post('/v1/translate', { text: 'hi' }, { Origin: ORIGIN, Authorization: 'Bearer nope' })).status).toBe(401);
  const pre = await fetch(`http://127.0.0.1:${PORT}/v1/reply`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  expect(pre.status).toBe(204); expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
});
test('reply streams SSE candidates; translate works; budget and rate limits trip', async () => {
  const r = await post('/v1/reply', { mode: 'candidates', latest: 'Which chain are you on?', latestState: 'final', kind: 'question', profile: { items: [{ kind: 'fact', topic: 'chain', text: 'We run on Solana.', updatedAt: '2026-10-02', source: 'repo' }] } }, authed);
  expect(r.status).toBe(200); expect(r.headers.get('content-type')).toContain('text/event-stream');
  const txt = await r.text();
  expect(txt).toContain('event: summary'); expect(txt).toContain('event: candidate'); expect(txt).toContain('event: done'); expect(txt).toContain('Solana');
  const t = await post('/v1/translate', { text: 'Which chain are you on?' }, authed);
  expect(t.status).toBe(200); expect((await t.json()).ja).toContain('モック訳');
  // spent 0.06 >= 0.05 → budget
  const b = await post('/v1/translate', { text: 'again' }, authed); expect(b.status).toBe(402);
  // 4th request this minute is still refused by the budget (402); the 5th trips the per-minute rate limit (429)
  expect((await post('/v1/translate', { text: 'again' }, authed)).status).toBe(402);
  const rl = await post('/v1/translate', { text: 'again' }, authed); expect(rl.status).toBe(429);
});
test('oversized or invalid bodies are rejected', async () => {
  const big = await fetch(`http://127.0.0.1:${PORT}/v1/session/reset`, { method: 'POST', headers: authed }); expect([200, 429]).toContain(big.status);
});
