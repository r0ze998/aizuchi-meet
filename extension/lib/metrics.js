// Latency bookkeeping: nearest-rank percentiles over bounded series.
export function percentile(values, p) {
  if (!values || values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
}

export class Series {
  constructor(max = 1000) { this.v = []; this.max = max; }
  add(x) {
    if (!Number.isFinite(x) || x < 0) return;
    this.v.push(Math.round(x));
    if (this.v.length > this.max) this.v.shift();
  }
  stats() {
    if (!this.v.length) return { n: 0, p50: null, p95: null, min: null, max: null };
    return { n: this.v.length, p50: percentile(this.v, 50), p95: percentile(this.v, 95), min: Math.min(...this.v), max: Math.max(...this.v) };
  }
}

export const METRIC_LABELS = Object.freeze({
  capture_to_first_interim: '音声取得→認識 (発話開始→最初の途中結果)',
  speech_end_to_final: '音声取得→認識 (発話終了→確定)',
  partial_to_translation: '認識→翻訳 (途中訳)',
  final_to_translation: '認識→翻訳 (確定訳)',
  question_provisional_to_first_candidate: '質問(暫定)→最初の候補',
  question_final_to_first_candidate: '質問の確定→最初の候補',
  reply_total: '候補生成の完了まで',
  refine_to_result: '言い直し→結果',
});

export class Metrics {
  constructor() { this.series = {}; this.events = []; }
  add(name, ms, meta) {
    (this.series[name] ||= new Series()).add(ms);
    if (this.events.length < 2000) this.events.push({ t: Date.now(), name, ms: Math.round(ms), ...(meta || {}) });
  }
  snapshot() {
    const out = {};
    for (const [k, s] of Object.entries(this.series)) out[k] = { label: METRIC_LABELS[k] || k, ...s.stats() };
    return out;
  }
  reset() { this.series = {}; this.events = []; }
}
