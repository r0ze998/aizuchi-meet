// Optional translation through Anthropic with the user's own key (used when the on-device Translator API is unavailable).
import Anthropic from '../../vendor/anthropic-sdk.js';
import { translateOnce, classifyError } from '../claude.js';
import { makeClient } from './reply-direct.js';

export function createDirectTranslator({ getKey, model = 'claude-opus-5-5', baseURL, guard, onState = () => {}, clientFactory } = {}) {
  let client = null, clientKey = null, state = 'idle';
  function getClient() {
    const key = getKey?.();
    if (!key) { const e = new Error('API キーが未設定です'); e.code = 'no-key'; throw e; }
    if (!client || clientKey !== key) { client = clientFactory ? clientFactory(key) : makeClient(key, { baseURL }); clientKey = key; }
    return client;
  }
  return {
    info() { return { name: 'direct', label: `翻訳: Anthropic に直接接続（${model}）`, external: true, supported: true, state }; },
    async availability() { return getKey?.() ? 'available' : 'unavailable'; },
    async ensure() { getClient(); return true; },
    async translate(text, { signal, context } = {}) {
      const c = getClient();
      guard.check();
      state = 'busy'; onState({ provider: 'direct-translate', state });
      try {
        const r = await translateOnce({ client: c, model, text, context, signal });
        guard.add(r.costUsd);
        state = 'ready'; onState({ provider: 'direct-translate', state });
        return r.ja;
      } catch (e) {
        state = 'error'; onState({ provider: 'direct-translate', state, detail: e?.message });
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        const err = new Error(e?.message || String(e)); err.code = classifyError(e, Anthropic); throw err;
      }
    },
    destroy() {},
  };
}
