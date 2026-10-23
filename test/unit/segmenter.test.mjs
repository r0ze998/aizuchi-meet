import { test, expect } from 'bun:test';
import { Segmenter, commonPrefixWords } from '../../extension/lib/segmenter.js';

test('commonPrefixWords', () => {
  expect(commonPrefixWords('how are you doing', 'how are you today')).toBe('how are you');
  expect(commonPrefixWords('', 'hello')).toBe('');
});

test('interim that stays unchanged for stableMs is emitted once as partial-stable', () => {
  const ev = []; let t = 1000;
  const s = new Segmenter({ stableMs: 700, now: () => t, onPartialStable: (p) => ev.push(['partial', p.text, p.reason]), onFinal: (f) => ev.push(['final', f.text]) });
  s.update({ interim: 'what is the status', ts: t });
  t += 300; s.tick(t); expect(ev).toHaveLength(0);
  t += 500; s.tick(t); expect(ev).toEqual([['partial', 'what is the status', 'idle']]);
  t += 500; s.tick(t); expect(ev).toHaveLength(1);
});

test('a growing interim emits its stable prefix without waiting', () => {
  const ev = []; let t = 0;
  const s = new Segmenter({ stableMs: 700, growWords: 6, now: () => t, onPartialStable: (p) => ev.push([p.text, p.reason]) });
  const words = 'let me give you some context first we have been looking at a few blockchain games this quarter'.split(' ');
  for (let i = 1; i <= words.length; i++) { t += 100; s.update({ interim: words.slice(0, i).join(' '), ts: t }); }
  expect(ev.length).toBeGreaterThanOrEqual(2);
  expect(ev[0][1]).toBe('grow');
  expect(ev[0][0].split(' ').length).toBeGreaterThanOrEqual(6);
  // every emitted prefix is a prefix of the full text
  for (const [text] of ev) expect(words.join(' ').startsWith(text)).toBe(true);
});

test('finals are emitted and reset the interim state', () => {
  const ev = []; let t = 0;
  const s = new Segmenter({ stableMs: 700, now: () => t, onPartialStable: (p) => ev.push(['partial', p.text]), onFinal: (f) => ev.push(['final', f.text]), onInterim: (i) => ev.push(['interim', i.text]) });
  s.update({ interim: 'which chain are', ts: t });
  t += 800; s.update({ finals: ['Which chain are you on?'], interim: '', ts: t });
  t += 800; s.tick(t);
  expect(ev).toEqual([['interim', 'which chain are'], ['final', 'Which chain are you on?']]);
});
