// Audio-independent core: STT updates → transcript / partial translations / question detection → candidates.
// Used by the offscreen document and by unit tests.
import { DEFAULT_SETTINGS } from './constants.js';
import { Debounce, LatestOnly, BoundedQueue, isAbort } from './scheduler.js';
import { Segmenter } from './segmenter.js';
import { QuestionTracker } from './question.js';
import { CandidateStore } from './candidates.js';
import { normalizeProfile } from './profile.js';
import { Metrics } from './metrics.js';

export class TranslateLane {
  constructor({ provider, debounceMs, maxQueue, onPartial, onFinal, onIssue, metrics, now }) {
    Object.assign(this, { provider, onPartial, onFinal, onIssue, metrics, now });
    this.cache = new Map();
    this.latest = new LatestOnly();
    this.debounce = new Debounce(debounceMs, (text, ts) => this.runPartial(text, ts));
    this.queue = new BoundedQueue(maxQueue, (dropped) => { dropped.entry.jaState = 'dropped'; onIssue({ level: 'warn', code: 'translate-drop', message: `翻訳待ちが上限を超え、1件を省略しました: "${dropped.entry.en.slice(0, 40)}…"` }); });
    this.running = false;
  }
  partial(text, ts) { this.debounce.call(text, ts); }
  async runPartial(text, ts) {
    if (this.cache.has(text)) { this.onPartial(text, this.cache.get(text)); return; }
    try {
      await this.latest.run(async (signal) => {
        const ja = await this.provider.translate(text, { signal });
        if (signal.aborted) return;
        this.cache.set(text, ja);
        this.metrics.add('partial_to_translation', this.now() - ts);
        this.onPartial(text, ja);
      });
    } catch (e) { if (!isAbort(e)) this.onIssue({ level: 'warn', code: 'translate-partial', message: `途中訳に失敗: ${e?.message || e}` }); }
  }
  final(entry, ts) {
    this.debounce.cancel(); this.latest.cancel();
    if (this.cache.has(entry.en)) { entry.ja = this.cache.get(entry.en); entry.jaState = 'final'; this.metrics.add('final_to_translation', this.now() - ts); this.onFinal(entry); return; }
    this.queue.push({ entry, ts });
    this.pump();
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const { entry, ts } = this.queue.shift();
        if (entry.jaState === 'dropped') continue;
        try {
          const ja = await this.provider.translate(entry.en, {});
          entry.ja = ja; entry.jaState = 'final';
          this.cache.set(entry.en, ja);
          this.metrics.add('final_to_translation', this.now() - ts);
        } catch (e) {
          entry.jaState = 'error'; entry.ja = '';
          this.onIssue({ level: 'error', code: 'translate-final', message: `確定訳に失敗: ${e?.message || e}` });
        }
        this.onFinal(entry);
      }
    } finally { this.running = false; }
  }
  cancelAll() { this.debounce.cancel(); this.latest.cancel(); this.queue.clear(); }
}

export class Pipeline {
  constructor({ settings, profile, translator, replier, metrics, now = () => Date.now(), onChange = () => {}, onIssue = () => {} }) {
    this.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    this.profile = normalizeProfile(profile);
    this.translator = translator; this.replier = replier;
    this.metrics = metrics || new Metrics();
    this.now = now; this.onChange = onChange; this.onIssue = onIssue;
    this.transcript = []; this.interim = null; this.question = null;
    this.refine = { input: '', items: [], generating: false, error: null };
    this.usage = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    this.candidates = new CandidateStore({ maxSets: this.settings.maxCandidateSets });
    this.gen = new LatestOnly(); this.refineGen = new LatestOnly();
    this.lastGenKey = '';
    this.lastSpeechStart = 0; this.lastSpeechEnd = 0; this.awaitingFirstInterim = false;
    this.trace = [];
    const s = this.settings;
    this.segmenter = new Segmenter({
      stableMs: s.stableMs, now,
      onInterim: ({ text, ts }) => {
        const keepJa = this.interim && text.startsWith(this.interim.jaFor || '\u0000');
        this.interim = { en: text, ja: keepJa ? this.interim.ja : '', jaFor: keepJa ? this.interim.jaFor : '', since: this.interim?.since || ts };
        this.log('interim', { ts, text }); this.questions.onInterim({ text, ts }); this.changed();
      },
      onPartialStable: ({ text, ts }) => { this.log('partial-stable', { ts, text }); this.lane.partial(text, ts); this.questions.onPartialStable({ text, ts }); },
      onFinal: ({ id, text, ts }) => this.onFinalSegment({ id, text, ts }),
    });
    this.questions = new QuestionTracker({
      turnEndMs: s.turnEndMs, provisionalMinWords: s.provisionalMinWords, now,
      on: {
        provisional: (q) => { this.log('question-provisional', { ts: q.ts, turnId: q.turnId, text: q.text }); this.generate({ ...q, state: 'provisional' }); },
        final: (q) => { this.log('question-final', { ts: q.ts, turnId: q.turnId, text: q.text, kind: q.kind }); this.generate({ ...q, state: 'final' }); },
        extended: (q) => { this.log('question-extended', { ts: q.ts, turnId: q.turnId, text: q.text }); this.generate({ ...q, state: 'final', extended: true }); },
        corrected: ({ turnId }) => this.onCorrected(turnId),
      },
    });
    this.lane = new TranslateLane({
      provider: translator, debounceMs: s.translateDebounceMs, maxQueue: s.maxQueue, metrics: this.metrics, now,
      onPartial: (en, ja) => { this.log('translation-partial', { en, ja }); if (this.interim && this.interim.en.startsWith(en)) { this.interim.ja = ja; this.interim.jaFor = en; this.changed(); } },
      onFinal: (entry) => { this.log('translation-final', { id: entry.id, en: entry.en, ja: entry.ja, state: entry.jaState }); this.changed(); },
      onIssue: (i) => this.onIssue(i),
    });
  }
  changed() { this.onChange(); }
  log(type, data) { if (this.trace.length < 4000) this.trace.push({ t: this.now(), type, ...data }); }

  // ----- inputs -----
  speechStart(ts) { this.lastSpeechStart = ts; this.awaitingFirstInterim = true; this.questions.onSpeechStart(ts); }
  speechEnd(ts, endedAt = ts) { this.lastSpeechEnd = endedAt; this.questions.onSilence(ts); }
  noteLoud(ts) { this.lastLoudTs = ts; }
  tick(ts) { ts = ts ?? this.now(); this.segmenter.tick(ts); this.questions.tick(ts); }
  feedStt({ finals = [], interim = '', ts, label = 'peer', unconfirmed = false }) {
    ts = ts ?? this.now();
    this.pendingUnconfirmed = !!unconfirmed;
    if (label === 'me-mic') { for (const f of finals) this.pushTranscript({ id: `mic${ts}`, speaker: 'me-mic', en: f, ja: '', jaState: 'none', ts }); this.changed(); return; }
    if (this.awaitingFirstInterim && (interim || finals.length)) { this.awaitingFirstInterim = false; if (this.lastSpeechStart) this.metrics.add('capture_to_first_interim', ts - this.lastSpeechStart); }
    this.segmenter.update({ finals, interim, ts });
  }
  onFinalSegment({ id, text, ts }) {
    if (this.lastLoudTs && ts - this.lastLoudTs >= 0 && ts - this.lastLoudTs < 6000) this.metrics.add('speech_end_to_final', ts - this.lastLoudTs);
    const entry = { id, speaker: 'peer', en: text, ja: '', jaState: 'pending', ts, unconfirmed: this.pendingUnconfirmed };
    this.log('final', { ts, id, text, unconfirmed: this.pendingUnconfirmed });
    if (this.interim?.jaFor === text && this.interim.ja) { entry.ja = this.interim.ja; entry.jaState = 'final'; this.log('translation-final', { id, en: text, ja: entry.ja, state: 'final', reused: true }); }
    this.interim = null;
    this.pushTranscript(entry);
    if (entry.jaState !== 'final') this.lane.final(entry, ts);
    this.questions.onFinal({ text, ts });
    this.changed();
  }
  pushTranscript(entry) { this.transcript.push(entry); if (this.transcript.length > this.settings.maxTranscript) this.transcript.splice(0, this.transcript.length - this.settings.maxTranscript); }
  contextTurns() { return this.transcript.slice(-10).map((t) => ({ speaker: t.speaker, en: t.en })); }

  // ----- candidates -----
  onCorrected(turnId) {
    const cur = this.candidates.current();
    if (cur && cur.questionId === turnId && cur.status === 'generating') { this.gen.cancel('corrected'); this.candidates.finishSet(cur.id, { error: '訂正を検知したため中止' }); this.candidates.supersede(cur.id); }
    else if (cur && cur.questionId === turnId && cur.state === 'provisional') { this.candidates.supersede(cur.id); }
    this.onIssue({ level: 'info', code: 'corrected', message: '言い直し・訂正を検知しました。候補を作り直します。' });
    this.changed();
  }
  generate(q) {
    const key = `${q.turnId}|${q.state}|${q.text}`;
    if (key === this.lastGenKey) return;
    this.lastGenKey = key;
    const set = this.candidates.startSet({ questionId: q.turnId, state: q.state, questionText: q.text, kind: q.kind, commitment: q.commitment });
    this.question = { id: q.turnId, en: q.text, state: q.state, kind: q.kind || 'question', summaryJa: '', ts: q.ts };
    this.changed();
    const t0 = this.now(); let first = true;
    return this.gen.run(async (signal) => {
      try {
        await this.replier.generate({ mode: 'candidates', profile: this.profile, conversation: this.contextTurns(), latest: q.text, latestState: q.state, kind: q.kind, commitment: q.commitment }, {
          signal,
          onSummary: (s) => { if (signal.aborted) return; this.log('summary', { setId: set.id, summaryJa: s }); this.candidates.setSummary(set.id, s); if (this.question?.id === q.turnId) this.question.summaryJa = s; this.changed(); },
          onCandidate: (index, cand) => { if (signal.aborted) return; if (first) { first = false; this.metrics.add(q.state === 'final' ? 'question_final_to_first_candidate' : 'question_provisional_to_first_candidate', this.now() - t0); } this.log('candidate', { setId: set.id, state: q.state, index, en: cand.en, strategy: cand.strategy, confirm: cand.confirm }); this.candidates.upsertItem(set.id, index, cand); this.changed(); },
          onDone: (d) => { if (signal.aborted) return; this.metrics.add('reply_total', this.now() - t0); this.accountUsage(d); this.candidates.finishSet(set.id); this.changed(); },
          onError: (e) => { if (signal.aborted) return; this.candidates.finishSet(set.id, { error: this.describeReplyError(e) }); this.onIssue({ level: 'error', code: `reply-${e.code || 'error'}`, message: this.describeReplyError(e) }); this.changed(); },
        });
        if (!signal.aborted && this.candidates.get(set.id)?.status === 'generating') this.candidates.finishSet(set.id);
      } catch (e) {
        if (isAbort(e)) { if (this.candidates.get(set.id)?.status === 'generating') this.candidates.finishSet(set.id, { error: '新しい発話のため中止' }); }
        else { this.candidates.finishSet(set.id, { error: e?.message || String(e) }); this.onIssue({ level: 'error', code: 'reply-exception', message: this.describeReplyError(e) }); }
      }
      this.changed();
    }).catch(() => {});
  }
  describeReplyError(e) {
    const code = e?.code;
    if (code === 'unreachable') return `ローカル中継に接続できません (${this.settings.relayUrl})。relay を起動してください。`;
    if (code === 'unpaired') return '中継とのペアリングが無効です。設定画面でトークンを入れ直してください。';
    if (code === 'budget-exceeded') return '中継のセッション費用上限に達しました。候補生成を止めています。';
    if (code === 'rate-limited') return '中継のレート上限に達しました。少し待ってから再試行してください。';
    if (code === 'refusal') return `モデルが応答を拒否しました: ${e.message}`;
    if (code === 'upstream-error') return `モデル側のエラー: ${e.message}`;
    return `候補生成に失敗: ${e?.message || e}`;
  }
  accountUsage(d) {
    this.usage.requests++;
    if (d?.usage) { this.usage.inputTokens += d.usage.input_tokens || 0; this.usage.outputTokens += d.usage.output_tokens || 0; }
    if (Number.isFinite(d?.costUsd)) this.usage.costUsd += d.costUsd;
    if (Number.isFinite(d?.sessionSpentUsd)) this.usage.relaySpentUsd = d.sessionSpentUsd;
  }
  refineText(text) {
    text = String(text || '').trim().slice(0, 300);
    this.refine = { input: text, items: [], generating: !!text, error: null };
    this.changed();
    if (!text) { this.refineGen.cancel(); return Promise.resolve(); }
    const t0 = this.now();
    return this.refineGen.run(async (signal) => {
      try {
        await this.replier.generate({ mode: 'refine', profile: this.profile, conversation: this.contextTurns(), latest: this.question?.en || '', latestState: 'final', kind: this.question?.kind || 'question', hint: text }, {
          signal,
          onCandidate: (index, cand) => { if (signal.aborted) return; const i = Number.isInteger(index) ? index : this.refine.items.length; this.refine.items[i] = { id: `r${t0}-${i}`, ...cand }; if (i === 0) this.metrics.add('refine_to_result', this.now() - t0); this.changed(); },
          onDone: (d) => { if (signal.aborted) return; this.accountUsage(d); this.refine.generating = false; this.changed(); },
          onError: (e) => { if (signal.aborted) return; this.refine.generating = false; this.refine.error = this.describeReplyError(e); this.changed(); },
        });
        if (!signal.aborted) this.refine.generating = false;
      } catch (e) { if (!isAbort(e)) { this.refine.generating = false; this.refine.error = e?.message || String(e); } }
      this.changed();
    }).catch(() => {});
  }
  pin(itemId) { const p = this.candidates.pin(itemId); this.changed(); return p; }
  pinText(t) { const p = this.candidates.pinText(t); this.changed(); return p; }
  unpin(pinId) { this.candidates.unpin(pinId); this.changed(); }
  markSpoken(itemId, text) {
    let en = '', ja = '';
    if (itemId) { const it = this.candidates.markSpoken(itemId); if (it) { en = it.en; ja = it.ja; } }
    if (!en && text?.en) { en = text.en; ja = text.ja || ''; }
    if (!en) return false;
    this.pushTranscript({ id: `me${this.now()}`, speaker: 'me-said', en, ja, jaState: 'final', ts: this.now() });
    this.changed();
    return true;
  }
  setProfile(p) { this.profile = normalizeProfile(p); }
  cancelAll() { this.gen.cancel('stopped'); this.refineGen.cancel('stopped'); this.lane.cancelAll(); }
  wipe() { this.transcript = []; this.interim = null; this.question = null; this.candidates.clear(); this.refine = { input: '', items: [], generating: false, error: null }; this.lane.cache.clear(); this.questions.reset(); this.lastGenKey = ''; }
  snapshot() {
    const c = this.candidates.snapshot();
    return { interim: this.interim ? { ...this.interim } : null, transcript: this.transcript.slice(-30), question: this.question ? { ...this.question } : null, candidateSets: c.sets, pinned: c.pinned, refine: { ...this.refine, items: [...this.refine.items] }, usage: { ...this.usage } };
  }
}
