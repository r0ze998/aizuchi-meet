export function createMockTranslator({ delayMs = 120 } = {}) {
  return {
    info() { return { name: 'mock', label: '翻訳: モック (送信なし)', external: false, supported: true, state: 'ready' }; },
    async availability() { return 'available'; },
    async ensure() { return true; },
    translate(text, { signal } = {}) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(`〔モック訳〕${text}`), delayMs);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      });
    },
    destroy() {},
  };
}
