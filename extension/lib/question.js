// Decides when the counterpart's utterance is "a question we can answer",
// provisionally (while still speaking) or finally, and detects corrections.
import { normalizeText, wordsOf } from './segmenter.js';

const Q_START = /^(what|when|where|who|whom|whose|why|how|which|is|are|am|was|were|do|does|did|can|could|will|would|should|shall|may|might|have|has|had|tell me|could you|can you|would you|any chance|what about|how about|so,? (what|how|when|why|which|is|are|do|does|can|could|would))\b/i;
const Q_INLINE = /\b(what|when|where|who|why|how|which|do you|did you|are you|is it|is there|can you|could you|would you|will you|have you|tell me|tell us|wondering|curious|question is|my question|any plans?|walk (me|us) through|explain)\b/i;
const CORRECTION = /\b(actually|sorry|forget (that|it)|no,? wait|wait,? no|i mean|i meant|scratch that|let me rephrase|never ?mind|correction|not (this|that)|rather than)\b/i;
// A question is a commitment risk when it asks the speaker to agree to something (commit / sign / promise …),
// or when it mentions money together with a request ("can you …", "how much would you charge").
// Merely talking about prices ("your opinion on Unreal pricing") is not a request for agreement.
const COMMIT_ASK = /\b(commit|commitment|sign|signing|agree|agreement|accept|promise|guarantee|deal|exclusive|exclusivity|hire|hiring|equity|deliver(y|able)?s?\s+by|deadline)\b/i;
const MONEY = /\b(price|prices|pricing|cost|costs|fee|fees|budget|discount|dollars?|usd|yen|percent|rate|rates|charge)\b|\$\s?\d|\d+\s?%/i;
const REQUEST = /\b(can you|could you|will you|would you|are you willing|willing to|is it ok|is that ok|can we|could we|how much (would|will|do|does|can)|what would you charge)\b/i;

export function lastSentence(text) {
  const parts = normalizeText(text).split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}
export function looksLikeQuestion(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  const last = lastSentence(t);
  return Q_START.test(last) || Q_INLINE.test(last);
}
export function hasCorrection(text) { return CORRECTION.test(String(text || '')); }
export function commitmentRisk(text) { const t = String(text || ''); return COMMIT_ASK.test(t) || (MONEY.test(t) && REQUEST.test(t)); }

export class QuestionTracker {
  constructor({ turnEndMs = 1500, provisionalMinWords = 5, provisionalCooldownMs = 1500, now = () => Date.now(), on = {} } = {}) {
    Object.assign(this, { turnEndMs, provisionalMinWords, provisionalCooldownMs, now });
    this.on = { turnStart: () => {}, provisional: () => {}, final: () => {}, extended: () => {}, corrected: () => {}, turnEnd: () => {}, ...on };
    this.turn = null;
    this.seq = 0;
  }
  text(turn = this.turn) {
    if (!turn) return '';
    return normalizeText([...turn.finals, turn.interim].filter(Boolean).join(' '));
  }
  ensureTurn(ts) {
    if (this.turn && !this.turn.closed) return this.turn;
    this.seq++;
    this.turn = { id: `q${this.seq}`, finals: [], interim: '', startTs: ts, lastTs: ts, finalEmitted: false, provisionalText: '', lastProvisionalTs: 0, corrected: false, closed: false };
    this.on.turnStart({ turnId: this.turn.id, ts });
    return this.turn;
  }
  onSpeechStart(ts) { ts = ts ?? this.now(); if (this.turn && !this.turn.closed) this.turn.lastTs = ts; }
  checkCorrection(text, ts) {
    const t = this.turn;
    if (!t) return;
    if (hasCorrection(text) && !t.corrected) {
      t.corrected = true;
      this.on.corrected({ turnId: t.id, text: this.text(t), ts });
    }
  }
  onInterim({ text, ts }) {
    ts = ts ?? this.now();
    const t = this.ensureTurn(ts);
    t.interim = normalizeText(text);
    t.lastTs = ts;
    this.checkCorrection(t.interim, ts);
  }
  onPartialStable({ text, ts }) {
    ts = ts ?? this.now();
    const t = this.ensureTurn(ts);
    t.interim = normalizeText(text);
    t.lastTs = ts;
    const full = this.text(t);
    if (t.finalEmitted) return; // already answering; wait for extension via finals
    if (!looksLikeQuestion(full)) return;
    if (wordsOf(full).length < this.provisionalMinWords) return;
    if (full === t.provisionalText) return;
    if (t.lastProvisionalTs && ts - t.lastProvisionalTs < this.provisionalCooldownMs) return;
    t.provisionalText = full;
    t.lastProvisionalTs = ts;
    this.on.provisional({ turnId: t.id, text: full, ts, kind: 'question' });
  }
  onFinal({ text, ts }) {
    ts = ts ?? this.now();
    const t = this.ensureTurn(ts);
    t.finals.push(normalizeText(text));
    t.interim = '';
    t.lastTs = ts;
    this.checkCorrection(text, ts);
    if (/\?\s*$/.test(text) || looksLikeQuestion(text)) this.emitFinal(ts);
  }
  onSilence(ts) {
    ts = ts ?? this.now();
    const t = this.turn;
    if (!t || t.closed) return;
    if (t.finals.length && !t.finalEmitted) this.emitFinal(ts);
  }
  tick(ts) {
    ts = ts ?? this.now();
    const t = this.turn;
    if (!t || t.closed) return;
    if (ts - t.lastTs < this.turnEndMs) return;
    if (t.finals.length && !t.finalEmitted) this.emitFinal(ts);
    t.closed = true;
    this.on.turnEnd({ turnId: t.id, text: this.text(t), ts });
  }
  emitFinal(ts) {
    const t = this.turn;
    const text = normalizeText(t.finals.join(' '));
    if (!text) return;
    const kind = looksLikeQuestion(text) ? 'question' : 'statement';
    const payload = { turnId: t.id, text, ts, kind, commitment: commitmentRisk(text) };
    if (t.finalEmitted) {
      if (text === t.lastFinalText) return;
      t.lastFinalText = text;
      this.on.extended(payload);
    } else {
      t.finalEmitted = true;
      t.lastFinalText = text;
      this.on.final(payload);
    }
  }
  reset() { this.turn = null; }
}
