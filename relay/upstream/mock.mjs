// Mock upstream: deterministic candidates, no network. Optional MOCK_COST_USD simulates spend for budget tests.
import { createMockReply } from '../../extension/lib/providers/reply-mock.js';

export function createMockUpstream({ delayMs = 200, costUsd = 0 } = {}) {
  const mock = createMockReply({ delayMs, stepMs: 150 });
  return {
    name: 'mock', model: 'mock',
    async reply({ payload, signal, onLine }) {
      await mock.generate(payload, {
        signal,
        onSummary: (s) => onLine(JSON.stringify({ summary_ja: s })),
        onCandidate: (i, c) => onLine(JSON.stringify({ ...c, index: i })),
        onDone: () => {}, onError: (e) => { throw new Error(e.message); },
      });
      return { usage: { input_tokens: 1200, output_tokens: 160 }, costUsd, model: 'mock' };
    },
    async translate({ text, signal }) {
      await new Promise((r, j) => { const t = setTimeout(r, 80); signal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
      return { ja: `〔モック訳〕${text}`, usage: { input_tokens: 40, output_tokens: 30 }, costUsd };
    },
  };
}
