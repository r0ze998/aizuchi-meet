// A local stand-in for the Anthropic Messages API (Bun). Streams SSE in the real event format so the
// official SDK runs unchanged. No network, no cost. Used by unit tests and the Chrome E2E harness.
import { commitmentRisk } from '../../extension/lib/question.js';
import { TRANSLATE_SYSTEM } from '../../extension/lib/claude.js';

export const FAKE_VALID_KEY = 'sk-ant-test-valid-0000000000';
const KNOWN_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

function apiError(status, type, message) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_fake' } });
}
function answerLines(body) {
  const user = String(body.messages?.[0]?.content || '');
  const latest = (user.match(/<latest[^>]*>\n?([\s\S]*?)\n?<\/latest>/) || [])[1]?.trim() || '';
  const intent = (user.match(/<speaker_intent_ja>\n?([\s\S]*?)\n?<\/speaker_intent_ja>/) || [])[1]?.trim();
  if (intent) return [{ index: 0, strategy: '言い直し', en: `(fake API) I would like to decide after we see next month's test build.`, ja: intent, basis: 'none', confirm: false }];
  if (commitmentRisk(latest)) return [
    { summary_ja: '（偽API）合意を求められています' },
    { index: 0, strategy: '保留する', en: "(fake API) I can't decide that today. Let me check and get back to you.", ja: '今日は決められません。確認して折り返します。', basis: 'none', confirm: true },
    { index: 1, strategy: '条件を尋ねる', en: '(fake API) Could you send me the details first?', ja: '先に詳細を送ってもらえますか？', basis: 'none', confirm: true },
  ];
  return [
    { summary_ja: `（偽API）質問: ${latest.slice(0, 24)}` },
    { index: 0, strategy: '要点を答える', en: '(fake API) Good question. Here is the short answer.', ja: '良い質問です。短く答えます。', basis: 'general', confirm: false },
    { index: 1, strategy: '聞き返す', en: '(fake API) Do you mean the current version?', ja: '今のバージョンのことですか？', basis: 'none', confirm: false },
  ];
}
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function startFakeAnthropic({ port = 0, firstTokenMs = 300, chunkMs = 15, validKey = FAKE_VALID_KEY } = {}) {
  const log = [];
  let fail = { status: 0, count: 0 };
  const server = Bun.serve({
    port, hostname: '127.0.0.1', idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      const key = req.headers.get('x-api-key');
      if (url.pathname.startsWith('/v1/models/') && req.method === 'GET') {
        log.push({ path: url.pathname, method: 'GET', keyOk: key === validKey });
        if (key !== validKey) return apiError(401, 'authentication_error', 'invalid x-api-key');
        const id = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
        if (!KNOWN_MODELS.includes(id)) return apiError(404, 'not_found_error', `model: ${id}`);
        return Response.json({ type: 'model', id, display_name: id.replace('claude-', 'Claude ').replace(/-/g, ' '), created_at: '2026-10-01T00:00:00Z' });
      }
      if (url.pathname !== '/v1/messages' || req.method !== 'POST') return apiError(404, 'not_found_error', 'not found');
      const body = await req.json();
      const entry = {
        path: url.pathname, beta: url.searchParams.get('beta') === 'true', model: body.model, stream: !!body.stream,
        directHeader: req.headers.get('anthropic-dangerous-direct-browser-access'), betaHeader: req.headers.get('anthropic-beta'),
        version: req.headers.get('anthropic-version'), keyOk: key === validKey, fallbacks: body.fallbacks ?? null,
        effort: body.output_config?.effort ?? null, cache: !!body.system?.[0]?.cache_control, translate: body.system === TRANSLATE_SYSTEM,
      };
      log.push(entry);
      if (key !== validKey) return apiError(401, 'authentication_error', 'invalid x-api-key');
      if (fail.count > 0) { fail.count--; return apiError(fail.status, fail.status === 529 ? 'overloaded_error' : 'api_error', 'simulated failure'); }
      const usage = { input_tokens: 1800, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      if (entry.translate) {
        const text = String(body.messages?.[0]?.content || '').replace(/^[\s\S]*Translate: /, '');
        return Response.json({ id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: `〔偽API訳〕${text}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { ...usage, input_tokens: 80, output_tokens: 40 } });
      }
      const text = answerLines(body).map((o) => JSON.stringify(o)).join('\n') + '\n';
      const stream = new ReadableStream({
        async start(ctrl) {
          const enc = new TextEncoder(); const push = (s) => ctrl.enqueue(enc.encode(s));
          try {
            push(sse('message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }));
            push(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
            await Bun.sleep(firstTokenMs);
            for (let i = 0; i < text.length; i += 24) { push(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 24) } })); await Bun.sleep(chunkMs); }
            push(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
            push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.ceil(text.length / 3) } }));
            push(sse('message_stop', { type: 'message_stop' }));
            ctrl.close();
          } catch { /* client aborted */ }
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_fake' } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port, log, failNext: (status, count = 1) => { fail = { status, count }; }, stop: () => server.stop(true) };
}
