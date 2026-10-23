// Turns a stream of speech-recognition updates ({finals, interim}) into
//  - interim notifications (for display),
//  - "partial stable" chunks (safe to translate before the sentence ends),
//  - final segments.
export function normalizeText(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
export function wordsOf(t) { return normalizeText(t).split(' ').filter(Boolean); }
export function commonPrefixWords(a, b) {
  const wa = wordsOf(a), wb = wordsOf(b);
  let i = 0;
  while (i < wa.length && i < wb.length && wa[i].toLowerCase() === wb[i].toLowerCase()) i++;
  return wa.slice(0, i).join(' ');
}

export class Segmenter {
  constructor({ stableMs = 700, growWords = 6, minWords = 3, now = () => Date.now(), onInterim = () => {}, onPartialStable = () => {}, onFinal = () => {} } = {}) {
    Object.assign(this, { stableMs, growWords, minWords, now, onInterim, onPartialStable, onFinal });
    this.seq = 0;
    this.resetInterim(0);
  }
  resetInterim(ts) { this.lastInterim = ''; this.lastChangeTs = ts; this.emittedPartial = ''; this.prefixStable = ''; }

  update({ finals = [], interim = '', ts } = {}) {
    ts = ts ?? this.now();
    let hadFinal = false;
    for (const f of finals) {
      const text = normalizeText(f);
      if (!text) continue;
      hadFinal = true;
      this.seq++;
      this.onFinal({ id: `s${this.seq}`, text, ts });
    }
    if (hadFinal) this.resetInterim(ts);
    interim = normalizeText(interim);
    if (interim === this.lastInterim) return;
    this.prefixStable = commonPrefixWords(this.lastInterim, interim);
    this.lastInterim = interim;
    this.lastChangeTs = ts;
    if (interim) this.onInterim({ text: interim, ts });
    else this.emittedPartial = '';
    const stableWords = wordsOf(this.prefixStable).length;
    if (stableWords >= wordsOf(this.emittedPartial).length + this.growWords && stableWords >= this.minWords) {
      this.emitPartial(this.prefixStable, ts, 'grow');
    }
  }

  tick(ts) {
    ts = ts ?? this.now();
    if (!this.lastInterim) return;
    if (ts - this.lastChangeTs < this.stableMs) return;
    if (this.lastInterim === this.emittedPartial) return;
    if (wordsOf(this.lastInterim).length < this.minWords) return;
    this.emitPartial(this.lastInterim, ts, 'idle');
  }

  emitPartial(text, ts, reason) {
    if (text === this.emittedPartial) return;
    this.emittedPartial = text;
    this.onPartialStable({ text, ts, reason });
  }
}
