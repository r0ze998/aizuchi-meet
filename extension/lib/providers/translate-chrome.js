// On-device translation with Chrome's Translator API (no network after the language pack is installed).
export function createChromeTranslator({ source = 'en', target = 'ja', onState = () => {} } = {}) {
  let translator = null, creating = null, state = 'idle';
  const supported = typeof globalThis.Translator !== 'undefined';
  function setState(s, detail) { state = s; onState({ provider: 'chrome', state: s, detail }); }
  async function availability() {
    if (!supported) return 'unsupported';
    try { return await globalThis.Translator.availability({ sourceLanguage: source, targetLanguage: target }); } catch { return 'unsupported'; }
  }
  async function ensure() {
    if (translator) return translator;
    if (creating) return creating;
    if (!supported) throw new Error('Translator API がありません');
    setState('preparing');
    creating = globalThis.Translator.create({
      sourceLanguage: source, targetLanguage: target,
      monitor(m) { m.addEventListener('downloadprogress', (e) => setState('downloading', Math.round((e.loaded || 0) * 100))); },
    }).then((t) => { translator = t; creating = null; setState('ready'); return t; }, (e) => { creating = null; setState('error', String(e?.message || e)); throw e; });
    return creating;
  }
  return {
    info() { return { name: 'chrome', label: '翻訳: 端末内 (Chrome Translator API)', external: false, supported, state }; },
    availability, ensure,
    async translate(text, { signal } = {}) {
      const t = await ensure();
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return await t.translate(text);
    },
    destroy() { try { translator?.destroy?.(); } catch { /* ignore */ } translator = null; },
  };
}
