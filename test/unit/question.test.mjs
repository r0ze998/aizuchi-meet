import { test, expect } from 'bun:test';
import { QuestionTracker, looksLikeQuestion, hasCorrection, commitmentRisk } from '../../extension/lib/question.js';

test('question detection', () => {
  expect(looksLikeQuestion('So, what is the current status of your game project?')).toBe(true);
  expect(looksLikeQuestion('which chain are you on')).toBe(true);
  expect(looksLikeQuestion('Could you tell us more about the team')).toBe(true);
  expect(looksLikeQuestion('That sounds great. Thanks for walking us through the demo.')).toBe(false);
  expect(looksLikeQuestion('Why?')).toBe(true);
});
test('correction and commitment detection', () => {
  expect(hasCorrection('No wait, not this year. I mean next year.')).toBe(true);
  expect(hasCorrection('Actually, sorry, forget that.')).toBe(true);
  expect(hasCorrection('How are you planning to use AI?')).toBe(false);
  expect(commitmentRisk('Can you commit to a fixed price of twenty thousand dollars and sign the contract this week?')).toBe(true);
  expect(commitmentRisk('How does your project handle onboarding?')).toBe(false);
});

function tracker(on, opts = {}) { let t = 0; const q = new QuestionTracker({ turnEndMs: 1500, provisionalMinWords: 5, now: () => t, on, ...opts }); return { q, at: (ms) => { t = ms; return t; } }; }

test('provisional while speaking, then final on question mark', () => {
  const ev = []; const { q, at } = tracker({ provisional: (p) => ev.push(['prov', p.text]), final: (f) => ev.push(['final', f.text, f.kind]) });
  q.onInterim({ text: 'what is the current', ts: at(100) });
  q.onPartialStable({ text: 'what is the current status of your', ts: at(900) });
  expect(ev).toEqual([['prov', 'what is the current status of your']]);
  q.onFinal({ text: 'What is the current status of your project?', ts: at(2000) });
  expect(ev[1]).toEqual(['final', 'What is the current status of your project?', 'question']);
});
test('correction is reported once per corrected text', () => {
  const ev = []; const { q, at } = tracker({ corrected: (c) => ev.push(c.turnId) });
  q.onInterim({ text: 'how many users do you have actually sorry', ts: at(100) });
  q.onInterim({ text: 'how many users do you have actually sorry forget that', ts: at(200) });
  q.onFinal({ text: 'How many users do you have? Actually, sorry, forget that.', ts: at(300) });
  expect(ev.length).toBeGreaterThanOrEqual(1);
  expect(new Set(ev).size).toBe(1);
});
test('speaker continues after a question → extended with the merged text', () => {
  const ev = []; const { q, at } = tracker({ final: (f) => ev.push(['final', f.text]), extended: (f) => ev.push(['ext', f.text]) });
  q.onFinal({ text: 'Which chain are you on?', ts: at(100) });
  q.onFinal({ text: 'And why did you choose it over the alternatives?', ts: at(600) });
  expect(ev).toEqual([['final', 'Which chain are you on?'], ['ext', 'Which chain are you on? And why did you choose it over the alternatives?']]);
});
test('statement is finalized on silence with kind=statement', () => {
  const ev = []; const { q, at } = tracker({ final: (f) => ev.push([f.text, f.kind]) });
  q.onFinal({ text: 'That sounds great.', ts: at(100) });
  expect(ev).toHaveLength(0);
  q.onSilence(at(1200));
  expect(ev).toEqual([['That sounds great.', 'statement']]);
});
test('turn closes after inactivity and the next final starts a new turn', () => {
  const ids = []; const { q, at } = tracker({ final: (f) => ids.push(f.turnId) });
  q.onFinal({ text: 'Why?', ts: at(100) });
  q.tick(at(2000));
  q.onFinal({ text: 'Which chain are you on?', ts: at(2100) });
  expect(ids).toHaveLength(2); expect(ids[0]).not.toBe(ids[1]);
});
test('commitment flag is carried on the final event', () => {
  const ev = []; const { q, at } = tracker({ final: (f) => ev.push(f.commitment) });
  q.onFinal({ text: 'Can you sign the contract this week?', ts: at(100) });
  expect(ev).toEqual([true]);
});

test('commitment risk needs a request for agreement, not just a price word', () => {
  expect(commitmentRisk('What is your opinion on the latest Unreal Engine pricing changes?')).toBe(false);
  expect(commitmentRisk('Is the budget around fifteen thousand dollars by March third?')).toBe(false);
  expect(commitmentRisk('How much would you charge for a pilot?')).toBe(true);
  expect(commitmentRisk('Could you do it for 20,000 dollars?')).toBe(true);
  expect(commitmentRisk('Can you sign the contract this week?')).toBe(true);
  expect(commitmentRisk('Would you agree to an exclusive deal?')).toBe(true);
});
