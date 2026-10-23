export function createRelayTranslator({ client, onState = () => {} } = {}) {
  let state = 'idle';
  return {
    info() { return { name: 'relay', label: '翻訳: ローカル中継 → Anthropic', external: true, supported: true, state }; },
    async availability() { return 'available'; },
    async ensure() { return true; },
    async translate(text, { signal, context } = {}) {
      state = 'busy'; onState({ provider: 'relay', state });
      try { const r = await client.translate({ text, context }, { signal }); state = 'ready'; return r.ja; }
      catch (e) { state = 'error'; onState({ provider: 'relay', state, detail: e?.message }); throw e; }
    },
    destroy() {},
  };
}
