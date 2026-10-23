import { test, expect } from 'bun:test';
import { normalizeProfile, detectConflicts, profileToPromptText } from '../../extension/lib/profile.js';

const items = [
  { id: 'a', kind: 'undecided', topic: 'ローンチ時期', text: '未定（テスト版の結果次第）', updatedAt: '2026-10-15', source: 'メモ' },
  { id: 'b', kind: 'fact', topic: 'ローンチ時期', text: '2026年12月にローンチ予定', updatedAt: '2026-09-01', source: '古い資料' },
  { id: 'c', kind: 'fact', topic: 'チェーン', text: 'Solana 上で動く', updatedAt: '2026-10-02', source: 'repo' },
  { id: 'd', kind: 'fact', topic: '', text: '', updatedAt: '', source: '' },
];
test('normalize drops empty items and coerces kinds', () => {
  const p = normalizeProfile({ items: [...items, { kind: 'bogus', text: 'x' }] });
  expect(p.items).toHaveLength(4);
  expect(p.items[3].kind).toBe('undecided');
});
test('conflicting dated items on the same topic are detected', () => {
  const c = detectConflicts(normalizeProfile({ items }).items);
  expect(c).toHaveLength(1); expect(c[0].topic).toBe('ローンチ時期');
  expect(c[0].items[0].updatedAt).toBe('2026-10-15');
});
test('prompt text marks kinds, dates, sources and conflicts; facts come first', () => {
  const t = profileToPromptText({ meta: { project: 'Zentoria' }, intents: { pricing: false }, items });
  expect(t).toContain('プロジェクト: Zentoria');
  expect(t).toContain('明示された意思 (これ以外の約束はしない): なし');
  expect(t.indexOf('[事実]')).toBeLessThan(t.indexOf('[未確定]'));
  expect(t).toContain('[矛盾の可能性] ローンチ時期');
  expect(t).toContain('(更新 2026-10-02, 出典: repo)');
});
