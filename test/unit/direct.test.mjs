// Direct connection (extension → Anthropic) with the bundled official SDK, against a local fake API. No cost.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { startFakeAnthropic, FAKE_VALID_KEY } from '../harness/fake-anthropic.mjs';
import { createDirectReply } from '../../extension/lib/providers/reply-direct.js';
import { createDirectTranslator } from '../../extension/lib/providers/translate-direct.js';
import { SpendGuard } from '../../extension/lib/spend.js';
import { estimateCost, classifyError } from '../../extension/lib/claude.js';

let fake;
beforeAll(() => { fake = startFakeAnthropic({ firstTokenMs: 30, chunkMs: 2 }); });
afterAll(() => fake.stop());

const PROFILE = { items: [{ id: '1', kind: 'fact', topic: 'chain', text: 'Zentoria runs on Solana.', updatedAt: '2026-10-02', source: 'repo' }] };
function run(provider, payload) {
  const out = { summary: '', cands: [], done: null, error: null };
  return provider.generate({ profile: PROFILE, latestState: 'final', kind: 'question', ...payload }, {
    onSummary: (s) => { out.summary = s; }, onCandidate: (i, c) => { out.cands[i] = c; }, onDone: (d) => { out.done = d; }, onError: (e) => { out.error = e; },
  }).then(() => out);
}
const make = (opts = {}) => createDirectReply({ getKey: () => FAKE_VALID_KEY, model: 'claude-opus-5-5', baseURL: fake.url, guard: new SpendGuard({ maxSessionUsd: 5 }), ...opts });

test('streams summary + candidates; request uses the SDK browser header, prompt caching, low effort and refusal fallback (Opus)', async () => {
  const before = fake.log.length;
  const out = await run(make(), { latest: 'Which chain are you on?' });
  expect(out.error).toBeNull();
  expect(out.summary).toContain('偽API');
  expect(out.cands.filter(Boolean).length).toBe(2);
  expect(out.done.costUsd).toBeGreaterThan(0);
  const req = fake.log.slice(before).find((r) => r.path === '/v1/messages');
  expect(req.directHeader).toBe('true');
  expect(req.stream).toBe(true); expect(req.cache).toBe(true); expect(req.effort).toBe('low');
  expect(req.fallbacks).toBe('default'); expect(req.beta).toBe(true); expect(req.betaHeader).toContain('server-side-fallback-2026-07-01');
});
test('Haiku 5.5 is sent without the fallback beta', async () => {
  const before = fake.log.length;
  await run(make({ model: 'claude-haiku-5-5' }), { latest: 'Which chain are you on?' });
  const req = fake.log.slice(before).find((r) => r.path === '/v1/messages');
  expect(req.model).toBe('claude-haiku-5-5'); expect(req.fallbacks).toBeNull(); expect(req.beta).toBe(false);
});
test('commitment questions come back as confirm-only candidates', async () => {
  const out = await run(make(), { latest: 'Can you sign the contract this week?', commitment: true });
  expect(out.cands.every((c) => c.confirm)).toBe(true);
});
test('missing key → no-key, no request is sent', async () => {
  const before = fake.log.length;
  const out = await run(make({ getKey: () => '' }), { latest: 'Why?' });
  expect(out.error.code).toBe('no-key'); expect(fake.log.length).toBe(before);
});
test('invalid key → auth error (typed SDK error mapped)', async () => {
  const out = await run(make({ getKey: () => 'sk-ant-wrong-key-123456' }), { latest: 'Why?' });
  expect(out.error.code).toBe('auth');
});
test('overloaded upstream (529) after one retry → upstream-error', async () => {
  fake.failNext(529, 2);
  const out = await run(make(), { latest: 'Why?' });
  expect(out.error.code).toBe('upstream-error');
});
test('per-meeting cost cap stops further requests before they are sent', async () => {
  const guard = new SpendGuard({ maxSessionUsd: 0.0001 });
  const p = make({ guard });
  const first = await run(p, { latest: 'Why?' });
  expect(first.error).toBeNull();
  const before = fake.log.length;
  const second = await run(p, { latest: 'And why not?' });
  expect(second.error.code).toBe('budget-exceeded'); expect(fake.log.length).toBe(before);
});
test('per-minute cap → rate-limited', async () => {
  const p = make({ guard: new SpendGuard({ maxSessionUsd: 5, maxReqPerMin: 1 }) });
  await run(p, { latest: 'Why?' });
  const out = await run(p, { latest: 'Why again?' });
  expect(out.error.code).toBe('rate-limited');
});
test('abort cancels the stream, throws AbortError and still charges a conservative estimate', async () => {
  const guard = new SpendGuard({ maxSessionUsd: 5 });
  const p = createDirectReply({ getKey: () => FAKE_VALID_KEY, model: 'claude-opus-5-5', baseURL: fake.url, guard });
  const ctrl = new AbortController();
  const pr = p.generate({ profile: PROFILE, latest: 'Which chain are you on?', latestState: 'final', kind: 'question' }, { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 10);
  let err; try { await pr; } catch (e) { err = e; }
  expect(err?.name).toBe('AbortError');
  expect(guard.spentUsd).toBeGreaterThan(0);
});
test('direct translation', async () => {
  const t = createDirectTranslator({ getKey: () => FAKE_VALID_KEY, model: 'claude-haiku-5-5', baseURL: fake.url, guard: new SpendGuard() });
  expect(await t.translate('Which chain are you on?')).toBe('〔偽API訳〕Which chain are you on?');
});
test('cost estimate and error classification helpers', () => {
  expect(estimateCost('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(4.0);
  expect(estimateCost('claude-haiku-5-5', { input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(0.5);
  const e = new Error('x'); e.code = 'no-key'; expect(classifyError(e)).toBe('no-key');
});
