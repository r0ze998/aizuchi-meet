// Candidate sets per question, with pinned snapshots that never move or disappear on updates.
export class CandidateStore {
  constructor({ maxSets = 6 } = {}) { this.maxSets = maxSets; this.sets = []; this.pinned = []; this.seq = 0; this.pinSeq = 0; }

  startSet({ questionId, state, questionText, kind, commitment }) {
    for (const s of this.sets) {
      if (s.questionId === questionId) s.relation = 'superseded';
      else if (s.relation === 'current') s.relation = 'old';
    }
    this.seq++;
    const set = { id: `c${this.seq}`, questionId, state, kind: kind || 'question', commitment: !!commitment, relation: 'current', status: 'generating', questionText, summaryJa: '', items: [], createdAt: Date.now(), error: null };
    this.sets.unshift(set);
    if (this.sets.length > this.maxSets) this.sets.length = this.maxSets;
    return set;
  }
  get(setId) { return this.sets.find((s) => s.id === setId) || null; }
  setSummary(setId, summaryJa) { const s = this.get(setId); if (s) s.summaryJa = String(summaryJa || '').slice(0, 80); }
  upsertItem(setId, index, partial) {
    const s = this.get(setId);
    if (!s) return null;
    index = Number.isInteger(index) ? index : s.items.length;
    if (index > 2) return null; // at most 3 candidates
    const id = `${setId}-${index}`;
    let it = s.items.find((i) => i.id === id);
    if (!it) { it = { id, index, strategy: '', en: '', ja: '', basis: 'none', confirm: false, done: false, spoken: false }; s.items.push(it); s.items.sort((a, b) => a.index - b.index); }
    Object.assign(it, sanitizeCandidate(partial));
    return it;
  }
  finishSet(setId, { error } = {}) { const s = this.get(setId); if (!s) return; s.status = error ? 'error' : 'done'; s.error = error || null; for (const it of s.items) it.done = true; }
  supersede(setId) { const s = this.get(setId); if (s) s.relation = 'superseded'; }
  find(itemId) { for (const s of this.sets) { const it = s.items.find((i) => i.id === itemId); if (it) return { set: s, item: it }; } return null; }
  isPinned(itemId) { return this.pinned.some((p) => p.itemId === itemId); }
  pin(itemId) {
    if (this.isPinned(itemId)) return null;
    const f = this.find(itemId);
    if (!f) return null;
    const p = { pinId: `p${++this.pinSeq}`, itemId, en: f.item.en, ja: f.item.ja, strategy: f.item.strategy, questionText: f.set.questionText, summaryJa: f.set.summaryJa, pinnedAt: Date.now() };
    this.pinned.push(p);
    return p;
  }
  pinText({ en, ja, strategy = '言い直し', questionText = '' }) {
    const p = { pinId: `p${++this.pinSeq}`, itemId: null, en, ja, strategy, questionText, summaryJa: '', pinnedAt: Date.now() };
    this.pinned.push(p);
    return p;
  }
  unpin(pinId) { this.pinned = this.pinned.filter((p) => p.pinId !== pinId); }
  markSpoken(itemId) { const f = this.find(itemId); if (f) f.item.spoken = true; return f ? f.item : null; }
  current() { return this.sets.find((s) => s.relation === 'current') || null; }
  snapshot() { return { sets: this.sets.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i })) })), pinned: this.pinned.map((p) => ({ ...p })) }; }
  clear() { this.sets = []; this.pinned = []; }
}

export function sanitizeCandidate(c) {
  const out = {};
  if (!c || typeof c !== 'object') return out;
  if (typeof c.strategy === 'string') out.strategy = c.strategy.slice(0, 24);
  if (typeof c.en === 'string') out.en = c.en.slice(0, 300);
  if (typeof c.ja === 'string') out.ja = c.ja.slice(0, 200);
  if (typeof c.basis === 'string' && ['profile', 'general', 'none'].includes(c.basis)) out.basis = c.basis;
  if (typeof c.confirm === 'boolean') out.confirm = c.confirm;
  if (typeof c.done === 'boolean') out.done = c.done;
  return out;
}
