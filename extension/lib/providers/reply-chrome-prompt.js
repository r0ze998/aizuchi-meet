// Optional on-device candidates with Chrome's Prompt API (Gemini Nano). Unverified on this machine until the model is downloaded.
import { buildSystemPrompt, buildUserMessage, parseNdjsonLine } from '../prompt.js';
import { profileToPromptText } from '../profile.js';

export function createChromePromptReply({ onState = () => {} } = {}) {
  let session = null, state = 'idle';
  const supported = typeof globalThis.LanguageModel !== 'undefined';
  function setState(s, d) { state = s; onState({ provider: 'chrome-prompt', state: s, detail: d }); }
  async function availability() { if (!supported) return 'unsupported'; try { return await Promise.race([globalThis.LanguageModel.availability({ expectedOutputs: [{ type: 'text', languages: ['ja', 'en'] }] }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))]); } catch { return 'unsupported'; } }
  async function ensure(mode) {
    if (session && session.__mode === mode) return session;
    try { session?.destroy?.(); } catch { /* ignore */ }
    setState('preparing');
    session = await globalThis.LanguageModel.create({
      initialPrompts: [{ role: 'system', content: buildSystemPrompt({ mode }) }],
      expectedInputs: [{ type: 'text', languages: ['en', 'ja'] }],
      expectedOutputs: [{ type: 'text', languages: ['ja', 'en'] }],
      monitor(m) { m.addEventListener('downloadprogress', (e) => setState('downloading', Math.round((e.loaded || 0) * 100))); },
    });
    session.__mode = mode;
    setState('ready');
    return session;
  }
  return {
    info() { return { name: 'chrome-prompt', label: '候補: 端末内 (Chrome Prompt API / Gemini Nano)', external: false, supported, state }; },
    availability,
    async generate(payload, { signal, onSummary = () => {}, onCandidate = () => {}, onDone = () => {}, onError = () => {} } = {}) {
      try {
        const mode = payload.mode === 'refine' ? 'refine' : 'candidates';
        const s = await ensure(mode);
        const user = buildUserMessage({ profileText: profileToPromptText(payload.profile), conversation: payload.conversation, latest: payload.latest, latestState: payload.latestState, kind: payload.kind, commitment: payload.commitment, hint: payload.hint });
        const stream = s.promptStreaming(user, { signal });
        let buf = '', idx = 0;
        const handle = (line) => {
          const obj = parseNdjsonLine(line);
          if (!obj) return;
          if (obj.summary_ja) onSummary(obj.summary_ja);
          else if (obj.en) { onCandidate(Number.isInteger(obj.index) ? obj.index : idx, { ...obj, done: true }); idx++; }
        };
        for await (const chunk of stream) {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
        }
        if (buf.trim()) handle(buf);
        onDone({ usage: null, costUsd: 0, local: true });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        setState('error', String(e?.message || e));
        onError({ code: 'prompt-api', message: String(e?.message || e) });
      }
    },
  };
}
