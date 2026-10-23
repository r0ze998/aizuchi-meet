// Aizuchi local relay: loopback only, Origin + pairing-token checks, session budget, no body logging.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt, buildUserMessage, parseNdjsonLine } from '../extension/lib/prompt.js';
import { profileToPromptText, normalizeProfile } from '../extension/lib/profile.js';
import { createMockUpstream } from './upstream/mock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(here, '.env'));

const HOST = '127.0.0.1';
const PORT = Number(process.env.RELAY_PORT || 47231);
const UPSTREAM = process.env.UPSTREAM || 'mock';
const MODEL = process.env.REPLY_MODEL || 'claude-opus-5-5';
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || MODEL;
const EFFORT = process.env.REPLY_EFFORT || 'low';
const MAX_SESSION_USD = Number(process.env.MAX_SESSION_USD || 1.0);
const MAX_REQ_PER_MIN = Number(process.env.MAX_REQ_PER_MIN || 30);
const MAX_BODY = 200 * 1024;
const LOG_BODIES = process.env.RELAY_LOG_BODIES === '1';
const TOKEN_FILE = process.env.RELAY_TOKEN_FILE || path.join(here, 'relay-token');

const allowedIds = (process.env.ALLOWED_EXTENSION_IDS || readIdFile()).split(',').map((s) => s.trim()).filter(Boolean);
const allowedOrigins = new Set(allowedIds.map((id) => `chrome-extension://${id}`));
const token = loadOrCreateToken();

let upstream;
if (UPSTREAM === 'anthropic') {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('[relay] UPSTREAM=anthropic ですが ANTHROPIC_API_KEY がありません。relay/.env か環境変数で設定してください（チャットには貼らないでください）。');
    process.exit(2);
  }
  const { createAnthropicUpstream } = await import('./upstream/anthropic.mjs');
  upstream = createAnthropicUpstream({ model: MODEL, translateModel: TRANSLATE_MODEL, effort: EFFORT, fallbacks: process.env.REPLY_FALLBACKS !== '0' });
} else {
  upstream = createMockUpstream({ delayMs: Number(process.env.MOCK_DELAY_MS || 200), costUsd: Number(process.env.MOCK_COST_USD || 0) });
}

const session = { spentUsd: 0, requests: 0, startedAt: Date.now(), window: [] };

function readIdFile() { try { return fs.readFileSync(path.join(here, '..', '.dev', 'extension-id.txt'), 'utf8').trim(); } catch { return ''; } }
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
function loadOrCreateToken() {
  if (process.env.RELAY_TOKEN) return process.env.RELAY_TOKEN;
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t.length >= 24) return t; } catch { /* create */ }
  const t = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
}
function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}
function rateLimited() {
  const now = Date.now();
  session.window = session.window.filter((t) => now - t < 60000);
  if (session.window.length >= MAX_REQ_PER_MIN) return true;
  session.window.push(now);
  return false;
}
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function authorize(req, res) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) { json(res, 403, { error: 'origin not allowed' }); return false; }
  cors(res, origin);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return false; }
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || !timingSafeEqual(auth.slice(7).trim(), token)) { json(res, 401, { error: 'pairing token missing or invalid' }); return false; }
  return true;
}
function accrue(costUsd, usage) {
  session.requests++;
  if (Number.isFinite(costUsd)) session.spentUsd += costUsd;
  return { costUsd, sessionSpentUsd: Number(session.spentUsd.toFixed(6)), usage: usage || null };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const t0 = Date.now();
  try {
    // Health is readable without the token so the options page can show "reachable"; it never exposes secrets.
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      const origin = req.headers.origin;
      if (origin && allowedOrigins.has(origin)) cors(res, origin);
      else if (origin) { json(res, 403, { error: 'origin not allowed' }); return; }
      const auth = req.headers.authorization || '';
      const paired = auth.startsWith('Bearer ') && timingSafeEqual(auth.slice(7).trim(), token);
      return json(res, 200, { ok: true, upstream: upstream.name, model: upstream.model, paired, limits: { maxSessionUsd: MAX_SESSION_USD, maxReqPerMin: MAX_REQ_PER_MIN }, spentUsd: Number(session.spentUsd.toFixed(6)), requests: session.requests, allowedExtensionIds: allowedIds, logBodies: LOG_BODIES });
    }
    if (!authorize(req, res)) return;
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (url.pathname === '/v1/session/reset') { session.spentUsd = 0; session.requests = 0; session.window = []; return json(res, 200, { ok: true }); }
    if (!['/v1/translate', '/v1/reply'].includes(url.pathname)) return json(res, 404, { error: 'not found' });
    if (rateLimited()) return json(res, 429, { error: `rate limit: ${MAX_REQ_PER_MIN} req/min` });
    if (session.spentUsd >= MAX_SESSION_USD) return json(res, 402, { error: `session budget exceeded ($${MAX_SESSION_USD})` });
    const body = await readBody(req);
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort());

    if (url.pathname === '/v1/translate') {
      const text = String(body.text || '').slice(0, 2000);
      if (!text) return json(res, 400, { error: 'text required' });
      const r = await upstream.translate({ text, context: String(body.context || '').slice(0, 500), signal: ctrl.signal });
      const acc = accrue(r.costUsd, r.usage);
      log('translate', t0, acc, { chars: text.length });
      return json(res, 200, { ja: r.ja, ms: Date.now() - t0, ...acc });
    }

    // /v1/reply → SSE
    const mode = body.mode === 'refine' ? 'refine' : 'candidates';
    const profileText = profileToPromptText(normalizeProfile(body.profile));
    const system = buildSystemPrompt({ mode, profileText });
    const user = buildUserMessage({ profileText: null, conversation: Array.isArray(body.conversation) ? body.conversation.slice(-10) : [], latest: String(body.latest || '').slice(0, 1500), latestState: body.latestState === 'provisional' ? 'provisional' : 'final', kind: body.kind === 'statement' ? 'statement' : 'question', commitment: !!body.commitment, hint: String(body.hint || '').slice(0, 300) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    let idx = 0, lines = 0;
    const onLine = (line) => {
      const obj = parseNdjsonLine(line);
      if (!obj) return;
      lines++;
      if (typeof obj.summary_ja === 'string') return send('summary', { summary_ja: obj.summary_ja.slice(0, 80) });
      if (typeof obj.en === 'string') {
        const i = Number.isInteger(obj.index) ? obj.index : idx;
        idx = i + 1;
        if (i > 2) return;
        send('candidate', { index: i, candidate: { strategy: String(obj.strategy || '').slice(0, 24), en: obj.en.slice(0, 300), ja: String(obj.ja || '').slice(0, 200), basis: ['profile', 'general', 'none'].includes(obj.basis) ? obj.basis : 'none', confirm: !!obj.confirm, done: true } });
      }
    };
    try {
      const r = await upstream.reply({ system, user, payload: { ...body, mode }, signal: ctrl.signal, onLine });
      const acc = accrue(r.costUsd, r.usage);
      send('done', { ...acc, ms: Date.now() - t0, model: r.model });
      log(`reply/${mode}`, t0, acc, { lines });
    } catch (e) {
      if (ctrl.signal.aborted) { log(`reply/${mode}`, t0, null, { aborted: true }); }
      else { send('error', { code: e.code || (e.status === 429 ? 'rate-limited' : 'upstream-error'), message: String(e.message || e).slice(0, 300) }); log(`reply/${mode}`, t0, null, { error: e.code || e.status || e.message }); }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) json(res, e.message === 'body too large' ? 413 : e.message === 'invalid JSON' ? 400 : 500, { error: String(e.message || e).slice(0, 200) });
    else res.end();
  }
});

function log(route, t0, acc, extra) {
  const parts = [`[relay] ${route}`, `${Date.now() - t0}ms`];
  if (acc?.usage) parts.push(`in=${acc.usage.input_tokens ?? '-'} out=${acc.usage.output_tokens ?? '-'}` + (acc.usage.cache_read_input_tokens ? ` cacheRead=${acc.usage.cache_read_input_tokens}` : ''));
  if (acc) parts.push(`cost=$${(acc.costUsd || 0).toFixed(5)} total=$${acc.sessionSpentUsd.toFixed(4)}`);
  if (extra) parts.push(JSON.stringify(extra));
  console.log(parts.join(' '));
}

server.listen(PORT, HOST, () => {
  console.log(`[relay] listening on http://${HOST}:${PORT} upstream=${upstream.name} model=${upstream.model} effort=${EFFORT}`);
  console.log(`[relay] allowed extension IDs: ${allowedIds.join(', ') || '(none!)'}`);
  console.log(`[relay] limits: $${MAX_SESSION_USD}/session, ${MAX_REQ_PER_MIN} req/min; request bodies are ${LOG_BODIES ? 'LOGGED' : 'not logged'}`);
  if (process.env.RELAY_PRINT_TOKEN !== '0') console.log(`[relay] pairing token (paste into the extension options page): ${token}`);
  else console.log(`[relay] pairing token stored at ${TOKEN_FILE}`);
});
export { server };
