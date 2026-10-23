// Scenario tests for the audio-independent pipeline (restatements, negation, pinning, commitments, errors…).
import { test, expect } from 'bun:test';
import { Pipeline } from '../../extension/lib/pipeline.js';
import { createMockReply } from '../../extension/lib/providers/reply-mock.js';
import { createMockTranslator } from '../../extension/lib/providers/translate-mock.js';
import { Metrics } from '../../extension/lib/metrics.js';

const PROFILE = { meta: { project: 'Zentoria' }, items: [
  { id: '1', kind: 'fact', topic: 'chain', text: 'Zentoria runs on Solana.', updatedAt: '2026-10-02', source: 'repo' },
  { id: '2', kind: 'plan', topic: 'AI', text: 'We plan to use AI for in-game agents and testing; details are open.', updatedAt: '2026-10-10', source: 'memo' },
  { id: '3', kind: 'undecided', topic: 'launch', text: 'Launch timing is not decided (depends on the test build).', updatedAt: '2026-10-15', source: 'memo' },
] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function make({ replier, translator, settings } = {}) {
  const issues = [];
  const p = new Pipeline({ settings: { stableMs: 50, translateDebounceMs: 10, turnEndMs: 300, provisionalMinWords: 5, ...settings }, profile: PROFILE, translator: translator || createMockTranslator({ delayMs: 5 }), replier: replier || createMockReply({ delayMs: 15, stepMs: 5 }), metrics: new Metrics(), onIssue: (i) => issues.push(i) });
  return { p, issues };
}
const current = (p) => p.candidates.current();

test('normal question → summary + up to 3 distinct candidates, translated transcript, metrics recorded', async () => {
  const { p } = make();
  let t = 1000;
  p.speechStart(t);
  p.feedStt({ interim: 'what is the current status', ts: (t += 100) });
  p.feedStt({ finals: ['What is the current status of your game project, and when do you plan to launch it?'], ts: (t += 900) });
  await sleep(120);
  const set = current(p);
  expect(set.state).toBe('final'); expect(set.status).toBe('done');
  expect(set.items.length).toBeGreaterThanOrEqual(1); expect(set.items.length).toBeLessThanOrEqual(3);
  expect(new Set(set.items.map((i) => i.strategy)).size).toBe(set.items.length);
  expect(set.summaryJa.length).toBeGreaterThan(0);
  expect(p.transcript[0].jaState).toBe('final'); expect(p.transcript[0].ja).toContain('モック訳');
  const m = p.metrics.snapshot();
  expect(m.question_final_to_first_candidate.n).toBe(1); expect(m.final_to_translation.n).toBe(1); expect(m.capture_to_first_interim.n).toBe(1);
});

test('restatement: "forget that" supersedes the first question and the current set answers the new one', async () => {
  const { p, issues } = make();
  p.feedStt({ finals: ['How many users do you have right now?'], ts: 1000 });
  await sleep(10); // generation in flight
  const first = current(p);
  p.feedStt({ finals: ['Actually, sorry, forget that. What I really wanted to ask is, how are you planning to use AI inside the game?'], ts: 1400 });
  await sleep(150);
  expect(issues.some((i) => i.code === 'corrected')).toBe(true);
  expect(p.candidates.get(first.id).relation).toBe('superseded');
  const cur = current(p);
  expect(cur.id).not.toBe(first.id);
  expect(cur.questionText).toContain('use AI inside the game');
  expect(cur.items.some((i) => /AI/.test(i.en))).toBe(true);
});

test('negation mid-sentence: provisional set is superseded and the final answer follows the corrected question', async () => {
  const { p } = make();
  let t = 0;
  p.feedStt({ interim: 'do you plan to raise money this year', ts: (t += 100) });
  p.tick((t += 200)); // stable → provisional
  await sleep(60);
  const prov = current(p); expect(prov.state).toBe('provisional');
  p.feedStt({ interim: 'do you plan to raise money this year no wait not this year', ts: (t += 100) });
  p.feedStt({ finals: ['Do you plan to raise money this year? No wait, not this year. I mean next year. Are you planning to raise a seed round next year?'], ts: (t += 500) });
  await sleep(150);
  expect(p.candidates.get(prov.id).relation).toBe('superseded');
  const cur = current(p); expect(cur.state).toBe('final'); expect(cur.questionText).toContain('next year');
});

test('pinned candidate is unchanged when a new question arrives; sets are kept apart', async () => {
  const { p } = make();
  p.feedStt({ finals: ['Which chain are you on?'], ts: 1000 });
  await sleep(100);
  const s1 = current(p); const pin = p.pin(s1.items[0].id);
  p.tick(2000);
  p.feedStt({ finals: ['Could you tell us more about the team behind the project?'], ts: 2100 });
  await sleep(100);
  const s2 = current(p);
  expect(s2.id).not.toBe(s1.id); expect(p.candidates.get(s1.id).relation).toBe('old');
  expect(p.candidates.pinned[0].en).toBe(pin.en); expect(p.candidates.pinned[0].questionText).toBe('Which chain are you on?');
});

test('pricing / contract questions produce only confirm-hold-ask candidates flagged for confirmation', async () => {
  const { p } = make();
  p.feedStt({ finals: ['Can you commit to a fixed price of twenty thousand dollars and sign the contract this week?'], ts: 1000 });
  await sleep(120);
  const set = current(p);
  expect(set.commitment).toBe(true);
  expect(set.items.every((i) => i.confirm)).toBe(true);
  expect(set.items.every((i) => /保留|条件|確認/.test(i.strategy))).toBe(true);
  expect(set.items.some((i) => /^yes|we agree|deal/i.test(i.en))).toBe(false);
});

test('question outside the profile → ask-back / hold candidates with no invented facts', async () => {
  const { p } = make();
  p.feedStt({ finals: ['What is your opinion on the latest Unreal Engine changes announced last month?'], ts: 1000 });
  await sleep(120);
  const set = current(p);
  expect(set.items.every((i) => i.basis !== 'profile')).toBe(true);
  expect(set.items.some((i) => /聞き返す|保留する/.test(i.strategy))).toBe(true);
});

test('statement → reaction candidates, summary says it is not a question', async () => {
  const { p } = make();
  p.feedStt({ finals: ['That sounds great. Thanks for walking us through the demo.'], ts: 1000 });
  p.speechEnd(1800);
  await sleep(120);
  const set = current(p); expect(set.kind).toBe('statement'); expect(set.summaryJa).toContain('質問ではなく');
});

test('API error from the reply provider is surfaced on the set and as an issue', async () => {
  const replier = { info: () => ({ name: 'err' }), async generate(_, { onError }) { onError({ code: 'budget-exceeded', message: 'session budget exceeded' }); } };
  const { p, issues } = make({ replier });
  p.feedStt({ finals: ['Which chain are you on?'], ts: 1000 });
  await sleep(40);
  const set = current(p); expect(set.status).toBe('error'); expect(set.error).toContain('費用上限');
  expect(issues.some((i) => i.code === 'reply-budget-exceeded')).toBe(true);
});

test('translation failure is shown per segment, pipeline keeps going', async () => {
  const translator = { info: () => ({}), async translate() { throw new Error('offline'); }, destroy() {} };
  const { p, issues } = make({ translator });
  p.feedStt({ finals: ['Which chain are you on?'], ts: 1000 });
  await sleep(80);
  expect(p.transcript[0].jaState).toBe('error'); expect(issues.some((i) => i.code === 'translate-final')).toBe(true);
  expect(current(p).items.length).toBeGreaterThan(0);
});

test('translation queue cap drops the oldest with a visible issue', async () => {
  const translator = { info: () => ({}), translate: (t) => new Promise((r) => setTimeout(() => r('訳 ' + t), 30)), destroy() {} };
  const { p, issues } = make({ translator, settings: { maxQueue: 2 } });
  for (let i = 0; i < 5; i++) p.feedStt({ finals: [`Sentence number ${i} is here.`], ts: 1000 + i });
  await sleep(250);
  expect(issues.filter((i) => i.code === 'translate-drop').length).toBeGreaterThan(0);
  expect(p.transcript.some((t) => t.jaState === 'dropped')).toBe(true);
});

test('"spoken" marks only what the user chose; displayed candidates are not treated as spoken', async () => {
  const { p } = make();
  p.feedStt({ finals: ['Which chain are you on?'], ts: 1000 });
  await sleep(100);
  const set = current(p);
  expect(p.contextTurns().filter((t) => t.speaker === 'me-said')).toHaveLength(0);
  p.markSpoken(set.items[0].id);
  expect(p.contextTurns().filter((t) => t.speaker === 'me-said')).toHaveLength(1);
  expect(set.items[0].spoken).toBe(true); expect(set.items[1]?.spoken || false).toBe(false);
});

test('refine: Japanese intent → English versions; wipe clears session memory', async () => {
  const { p } = make();
  await p.refineText('来月のテスト版を見てから決めたい');
  expect(p.refine.items.length).toBeGreaterThan(0); expect(p.refine.generating).toBe(false);
  p.feedStt({ finals: ['Which chain are you on?'], ts: 1000 }); await sleep(60);
  p.wipe();
  expect(p.transcript).toHaveLength(0); expect(p.candidates.sets).toHaveLength(0); expect(p.refine.items).toHaveLength(0);
});

test('own-mic finals are labelled separately and never translated', () => {
  const { p } = make();
  p.feedStt({ finals: ['We are on Solana.'], ts: 1, label: 'me-mic' });
  expect(p.transcript[0].speaker).toBe('me-mic'); expect(p.transcript[0].jaState).toBe('none');
});

test('an unconfirmed final (recogniser ended mid-utterance) is kept and marked, never dropped silently', async () => {
  const { p } = make();
  p.feedStt({ finals: ['how does your project'], ts: 1000, unconfirmed: true });
  expect(p.transcript[0].unconfirmed).toBe(true);
  p.feedStt({ finals: ['Which chain are you on?'], ts: 1500 });
  expect(p.transcript[1].unconfirmed).toBe(false);
});

test('mock: conflicting profile facts produce a confirm candidate, never one side asserted', async () => {
  const conflictProfile = { items: [
    { id: 'a', kind: 'fact', topic: 'MagicBlock', text: 'MagicBlock is adopted and working.', updatedAt: '2026-10-08', source: 'm' },
    { id: 'b', kind: 'fact', topic: 'MagicBlock', text: 'MagicBlock is not used in the current version.', updatedAt: '2026-10-03', source: 'm' },
    { id: 'c', kind: 'avoid', topic: 'promises', text: 'Do not promise MagicBlock dates.', updatedAt: '2026-10-08', source: 'm' },
  ] };
  const out = [];
  await createMockReply({ delayMs: 0, stepMs: 0 }).generate({ latest: 'Are you using MagicBlock?', latestState: 'final', kind: 'question', profile: conflictProfile }, { onCandidate: (i, c) => out.push(c) });
  expect(out[0].strategy).toBe('確認する');
  expect(out.some((c) => /adopted and working|not used/.test(c.en))).toBe(false);
  expect(out.some((c) => /Do not promise/.test(c.en))).toBe(false);
});

test('upstream overload is shown as a short sentence, never raw JSON', async () => {
  const replier = { info: () => ({}), async generate(_, { onError }) { onError({ code: 'upstream-error', status: 529, message: '529 {"type":"error","error":{"type":"overloaded_error"}}' }); } };
  const { p } = make({ replier });
  p.feedStt({ finals: ['Which chain are you on?'], ts: 1000 });
  await sleep(30);
  const set = current(p);
  expect(set.error).toContain('混雑'); expect(set.error).not.toContain('{');
});
