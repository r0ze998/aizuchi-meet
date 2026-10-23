import { test, expect } from 'bun:test';
import { CandidateStore } from '../../extension/lib/candidates.js';

test('new set supersedes same-question sets and ages other questions', () => {
  const c = new CandidateStore({ maxSets: 3 });
  const s1 = c.startSet({ questionId: 'q1', state: 'provisional', questionText: 'a' });
  const s2 = c.startSet({ questionId: 'q1', state: 'final', questionText: 'a?' });
  const s3 = c.startSet({ questionId: 'q2', state: 'final', questionText: 'b?' });
  expect(c.get(s1.id).relation).toBe('superseded');
  expect(c.get(s2.id).relation).toBe('old');
  expect(c.get(s3.id).relation).toBe('current');
});
test('pinned snapshots survive pruning, supersede and item changes', () => {
  const c = new CandidateStore({ maxSets: 2 });
  const s1 = c.startSet({ questionId: 'q1', state: 'final', questionText: 'first?' });
  c.upsertItem(s1.id, 0, { en: 'We are on Solana.', ja: 'Solana です。', strategy: '要点を答える' });
  const pin = c.pin(`${s1.id}-0`);
  expect(pin.en).toBe('We are on Solana.');
  c.upsertItem(s1.id, 0, { en: 'changed' });
  for (let i = 0; i < 5; i++) c.startSet({ questionId: `q${i + 2}`, state: 'final', questionText: 'x' });
  expect(c.get(s1.id)).toBeNull();
  expect(c.pinned).toHaveLength(1);
  expect(c.pinned[0].en).toBe('We are on Solana.');
  expect(c.pinned[0].questionText).toBe('first?');
  c.unpin(pin.pinId); expect(c.pinned).toHaveLength(0);
});
test('at most three candidates, partial updates merge, spoken marks', () => {
  const c = new CandidateStore();
  const s = c.startSet({ questionId: 'q', state: 'final', questionText: 'x?' });
  c.upsertItem(s.id, 0, { en: 'A' }); c.upsertItem(s.id, 0, { ja: 'あ', done: true });
  c.upsertItem(s.id, 1, { en: 'B' }); c.upsertItem(s.id, 2, { en: 'C' }); expect(c.upsertItem(s.id, 3, { en: 'D' })).toBeNull();
  expect(s.items.map((i) => i.en)).toEqual(['A', 'B', 'C']);
  expect(s.items[0].ja).toBe('あ');
  c.markSpoken(`${s.id}-1`); expect(s.items[1].spoken).toBe(true);
  c.finishSet(s.id, { error: 'boom' }); expect(s.status).toBe('error');
});
