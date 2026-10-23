// Pre-meeting knowledge: facts / plans / undecided / commitments to avoid, each with date and source.
export const KINDS = Object.freeze({ fact: '事実', plan: '構想', undecided: '未確定', avoid: '避けたい約束' });

export function emptyProfile() {
  return {
    version: 1,
    meta: { project: '', counterpart: '', purpose: '', updatedAt: '' },
    me: { name: '', role: '', notes: '' },
    intents: { pricing: false, deadlines: false, hiring: false, other: '' },
    items: [],
  };
}

export function normalizeProfile(p) {
  const base = emptyProfile();
  if (!p || typeof p !== 'object') return base;
  const out = { ...base, ...p };
  out.meta = { ...base.meta, ...(p.meta || {}) };
  out.me = { ...base.me, ...(p.me || {}) };
  out.intents = { ...base.intents, ...(p.intents || {}) };
  out.items = Array.isArray(p.items) ? p.items.map((it, i) => ({
    id: it.id || `i${i + 1}`,
    kind: KINDS[it.kind] ? it.kind : 'undecided',
    topic: String(it.topic || '').slice(0, 80),
    text: String(it.text || '').slice(0, 600),
    updatedAt: String(it.updatedAt || '').slice(0, 10),
    source: String(it.source || '').slice(0, 120),
  })).filter((it) => it.text) : [];
  return out;
}

export function detectConflicts(items) {
  const groups = new Map();
  for (const it of items || []) {
    const key = String(it.topic || '').trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const conflicts = [];
  for (const [topic, arr] of groups) {
    if (arr.length < 2) continue;
    const texts = new Set(arr.map((a) => a.text.trim().toLowerCase()));
    const dates = new Set(arr.map((a) => a.updatedAt));
    const kinds = new Set(arr.map((a) => a.kind));
    if ((texts.size > 1 && dates.size > 1) || (kinds.has('fact') && kinds.has('undecided'))) {
      conflicts.push({ topic, items: [...arr].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')) });
    }
  }
  return conflicts;
}

export function profileToPromptText(profile, { maxChars = 7000 } = {}) {
  const p = normalizeProfile(profile);
  const lines = [];
  if (p.meta.project) lines.push(`プロジェクト: ${p.meta.project}`);
  if (p.meta.counterpart) lines.push(`相手: ${p.meta.counterpart}`);
  if (p.meta.purpose) lines.push(`会議の目的: ${p.meta.purpose}`);
  if (p.me.name || p.me.role) lines.push(`自分: ${[p.me.name, p.me.role].filter(Boolean).join(' / ')}`);
  if (p.me.notes) lines.push(`自分についての補足: ${p.me.notes}`);
  const intents = [];
  if (p.intents.pricing) intents.push('価格・費用について具体的に話してよい');
  if (p.intents.deadlines) intents.push('納期・日程を約束してよい');
  if (p.intents.hiring) intents.push('採用・契約について合意してよい');
  if (p.intents.other) intents.push(p.intents.other);
  lines.push(`明示された意思 (これ以外の約束はしない): ${intents.length ? intents.join('；') : 'なし'}`);
  const order = ['fact', 'plan', 'undecided', 'avoid'];
  const sorted = [...p.items].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  lines.push('登録情報:');
  for (const it of sorted) {
    lines.push(`- [${KINDS[it.kind]}]${it.topic ? ` ${it.topic}:` : ''} ${it.text} (更新 ${it.updatedAt || '不明'}, 出典: ${it.source || '不明'})`);
  }
  const conflicts = detectConflicts(p.items);
  for (const c of conflicts) {
    lines.push(`- [矛盾の可能性] ${c.topic}: ` + c.items.map((i) => `「${i.text}」(${i.updatedAt || '日付不明'})`).join(' と ') + ' → 断定せず確認を促す');
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n(…省略)';
  return text;
}
