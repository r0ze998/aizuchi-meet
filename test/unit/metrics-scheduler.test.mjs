import { test, expect } from 'bun:test';
import { percentile, Series, Metrics } from '../../extension/lib/metrics.js';
import { LatestOnly, BoundedQueue, Debounce, Dedupe } from '../../extension/lib/scheduler.js';

test('nearest-rank percentiles', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  expect(percentile(v, 50)).toBe(5); expect(percentile(v, 95)).toBe(10); expect(percentile([], 50)).toBeNull();
  const s = new Series(3); s.add(1); s.add(2); s.add(3); s.add(4); expect(s.stats().n).toBe(3); expect(s.stats().min).toBe(2);
  const m = new Metrics(); m.add('final_to_translation', 120); expect(m.snapshot().final_to_translation.p50).toBe(120); expect(m.snapshot().final_to_translation.label).toContain('翻訳');
});
test('LatestOnly aborts the previous task', async () => {
  const l = new LatestOnly(); const seen = [];
  const p1 = l.run((signal) => new Promise((res) => { signal.addEventListener('abort', () => { seen.push('aborted1'); res('a1'); }); }));
  const p2 = l.run(async () => { seen.push('run2'); return 'r2'; });
  expect(await p2).toBe('r2'); await p1; expect(seen).toEqual(['aborted1', 'run2']);
});
test('BoundedQueue drops the oldest and reports it', () => {
  const dropped = []; const q = new BoundedQueue(2, (d) => dropped.push(d));
  q.push(1); q.push(2); q.push(3); expect(q.length).toBe(2); expect(dropped).toEqual([1]); expect(q.dropped).toBe(1);
});
test('Debounce coalesces calls; Dedupe expires', async () => {
  const calls = []; const d = new Debounce(20, (x) => calls.push(x));
  d.call(1); d.call(2); d.call(3); await Bun.sleep(40); expect(calls).toEqual([3]);
  const dd = new Dedupe(50); expect(dd.seen('k', 0)).toBe(false); expect(dd.seen('k', 10)).toBe(true); expect(dd.seen('k', 100)).toBe(false);
});
