// Reply candidates straight from the extension to Anthropic, with the user's own API key.
// The key comes from chrome.storage.local (entered on the options page); it is never logged or put in snapshots.
import Anthropic from '../../vendor/anthropic-sdk.js';
import { buildSystemPrompt, buildUserMessage, parseNdjsonLine } from '../prompt.js';
import { profileToPromptText, normalizeProfile } from '../profile.js';
import { streamCandidates, classifyError, estimateAbortedCost } from '../claude.js';

export function makeClient(key, { baseURL } = {}) {
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 20000, ...(baseURL ? { baseURL } : {}) });
}

export function createDirectReply({ getKey, model = 'claude-opus-5-5', effort = 'low', fallbacks = true, baseURL, guard, onState = () => {}, clientFactory } = {}) {
  let client = null, clientKey = null, state = 'idle';
  function getClient() {
    const key = getKey?.();
    if (!key) { const e = new Error('API キーが未設定です'); e.code = 'no-key'; throw e; }
    if (!client || clientKey !== key) { client = clientFactory ? clientFactory(key) : makeClient(key, { baseURL }); clientKey = key; }
    return client;
  }
  function setState(s, detail) { state = s; onState({ provider: 'direct', state: s, detail }); }
  return {
    info() { return { name: 'direct', label: `候補: Anthropic に直接接続（${model}）`, external: true, supported: true, state }; },
    async generate(payload, { signal, onSummary = () => {}, onCandidate = () => {}, onDone = () => {}, onError = () => {} } = {}) {
      const mode = payload.mode === 'refine' ? 'refine' : 'candidates';
      let system = '', user = '', sent = false;
      try {
        const c = getClient();
        guard.check();
        setState('busy');
        system = buildSystemPrompt({ mode, profileText: profileToPromptText(normalizeProfile(payload.profile)) });
        user = buildUserMessage({
          profileText: null,
          conversation: Array.isArray(payload.conversation) ? payload.conversation.slice(-10) : [],
          latest: String(payload.latest || '').slice(0, 1500),
          latestState: payload.latestState === 'provisional' ? 'provisional' : 'final',
          kind: payload.kind === 'statement' ? 'statement' : 'question',
          commitment: !!payload.commitment,
          hint: String(payload.hint || '').slice(0, 300),
        });
        let idx = 0;
        sent = true;
        const r = await streamCandidates({
          client: c, model, effort, fallbacks, system, user, signal,
          onLine: (line) => {
            if (signal?.aborted) return;
            const obj = parseNdjsonLine(line);
            if (!obj) return;
            if (typeof obj.summary_ja === 'string') { onSummary(obj.summary_ja.slice(0, 80)); return; }
            if (typeof obj.en === 'string') {
              const i = Number.isInteger(obj.index) ? obj.index : idx;
              idx = i + 1;
              if (i > 2) return;
              onCandidate(i, { ...obj, done: true });
            }
          },
        });
        const total = guard.add(r.costUsd);
        setState('ready');
        onDone({ usage: r.usage, costUsd: r.costUsd, sessionSpentUsd: total, model: r.model });
      } catch (e) {
        setState('ready');
        if (signal?.aborted || classifyError(e, Anthropic) === 'aborted') {
          if (sent) guard.add(estimateAbortedCost(model, system, user));
          throw new DOMException('aborted', 'AbortError');
        }
        const code = classifyError(e, Anthropic);
        onError({ code, status: Number(e?.status) || undefined, message: String(e?.message || e).slice(0, 300) });
      }
    },
  };
}
