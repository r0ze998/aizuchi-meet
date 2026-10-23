// Deterministic candidate generator for tests and offline demos. Mirrors the safety rules of the real prompt.
import { commitmentRisk } from '../question.js';
import { normalizeProfile, detectConflicts, KINDS as KIND_JA } from '../profile.js';

const STOP = new Set('a an the and or but so of to in on at for with from by as is are was were be been am do does did have has had will would could can should may might you your yours we our us i me my it its this that these those what when where which who whom why how any some more most about into over just now right tell please there here they them their game games really also very much many thing things'.split(' '));
const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const wordsOf = (t) => String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w)).map(stem);

// Whole-word overlap between the question and each usable profile item; topic words count double.
// "avoid" items are rules for the speaker, never something to say.
function pickProfileSnippets(profile, text, max = 2) {
  const p = normalizeProfile(profile);
  const q = new Set(wordsOf(text));
  const scored = [];
  for (const it of p.items) {
    if (it.kind === 'avoid') continue;
    const topic = new Set(wordsOf(it.topic));
    const body = new Set(wordsOf(it.text));
    let score = 0;
    for (const w of q) { if (topic.has(w)) score += 2; if (body.has(w)) score += 1; }
    if (score > 0) scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.it.updatedAt || '').localeCompare(a.it.updatedAt || ''));
  return scored.slice(0, max).map((x) => x.it);
}

function sayable(it) {
  const already = /not (decided|final)|undecided|未定|未確定/i.test(it.text);
  if (it.kind === 'plan') return (already ? '' : 'We are planning this, but it is not final. ') + it.text;
  if (it.kind === 'undecided') return (already ? '' : 'It is not decided yet. ') + it.text;
  return it.text;
}

function summarize(text, kind) {
  if (kind === 'statement') return '質問ではなく説明';
  const t = text.toLowerCase();
  if (/status|progress|how is|how's/.test(t)) return '進捗・現状を聞かれています';
  if (/when|timeline|launch|deadline|by when/.test(t)) return '時期・スケジュールを聞かれています';
  if (/why|reason/.test(t)) return '理由を聞かれています';
  if (/how (do|does|are|will|would)|how .* (handle|use|plan)/.test(t)) return 'やり方・方針を聞かれています';
  if (/price|cost|budget|contract|sign|commit/.test(t)) return '費用・契約に関する確認です';
  if (/team|who/.test(t)) return 'チーム・担当を聞かれています';
  if (/which chain|solana|ethereum|blockchain/.test(t)) return 'チェーンの選択について聞かれています';
  if (/opinion|think about|thoughts/.test(t)) return '意見・感想を聞かれています';
  return '質問の内容を確認してください';
}

export function createMockReply({ delayMs = 250, stepMs = 180 } = {}) {
  return {
    info() { return { name: 'mock', label: '候補: モック (送信なし)', external: false, supported: true, state: 'ready' }; },
    async generate(payload, { signal, onSummary = () => {}, onCandidate = () => {}, onDone = () => {}, onError = () => {} } = {}) {
      const wait = (ms) => new Promise((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true }); });
      try {
        const { latest = '', latestState = 'final', kind = 'question', hint = '', profile } = payload;
        await wait(delayMs);
        if (payload.mode === 'refine') {
          onCandidate(0, { index: 0, strategy: '言い直し', en: `(mock) ${hint}`, ja: hint, basis: 'none', confirm: false, done: true });
          await wait(stepMs);
          onCandidate(1, { index: 1, strategy: '言い直し', en: `(mock, shorter) ${hint.slice(0, 20)}`, ja: hint.slice(0, 20), basis: 'none', confirm: false, done: true });
          onDone({ usage: null, costUsd: 0, mock: true });
          return;
        }
        onSummary(summarize(latest, kind));
        const cands = [];
        const risky = commitmentRisk(latest) || payload.commitment;
        const snippets = pickProfileSnippets(profile, latest);
        if (risky) {
          cands.push({ strategy: '保留する', en: 'I can\'t decide that today. Let me check and get back to you.', ja: '今日は決められません。確認して折り返します。', basis: 'none', confirm: true });
          cands.push({ strategy: '条件を尋ねる', en: 'Could you share the details in writing first?', ja: 'まず詳細を書面でいただけますか？', basis: 'none', confirm: true });
          if (latestState === 'final') cands.push({ strategy: '確認する', en: 'Just to confirm, what exactly are you asking me to agree to?', ja: '確認ですが、具体的に何への合意を求めていますか？', basis: 'none', confirm: true });
        } else if (kind === 'statement') {
          cands.push({ strategy: '相づち・感謝', en: 'Thank you. That\'s helpful to know.', ja: 'ありがとうございます。参考になります。', basis: 'general', confirm: false });
          cands.push({ strategy: '聞き返す', en: 'Could you tell me a bit more about that?', ja: 'その点をもう少し教えてもらえますか？', basis: 'none', confirm: false });
        } else if (snippets.length) {
          const [a, b] = snippets;
          const conflicted = new Set(detectConflicts(normalizeProfile(profile).items).map((c) => c.topic));
          if (conflicted.has(String(a.topic || '').trim().toLowerCase())) {
            const name = String(a.topic || '').replace(/[^\x00-\x7F]+/g, ' ').trim() || 'this';
            cands.push({ strategy: '確認する', en: `Let me check the latest status of ${name} and get back to you.`, ja: `（登録情報に矛盾あり: ${a.topic}。断定せず、確認して折り返す）`, basis: 'none', confirm: true });
            cands.push({ strategy: '聞き返す', en: 'Do you mean the current version or the next one?', ja: '今のバージョンのことですか、次のことですか？', basis: 'none', confirm: false });
            for (let i = 0; i < cands.length; i++) { if (i) await wait(stepMs); onCandidate(i, { index: i, ...cands[i], done: true }); }
            onDone({ usage: null, costUsd: 0, mock: true });
            return;
          }
          cands.push({ strategy: a.kind === 'fact' ? '要点を答える' : '知っている範囲で話す', en: sayable(a).slice(0, 200), ja: `（登録情報: ${a.topic || KIND_JA[a.kind]}）`, basis: 'profile', confirm: false });
          if (b && latestState === 'final') cands.push({ strategy: '補足する', en: sayable(b).slice(0, 200), ja: `（登録情報: ${b.topic || KIND_JA[b.kind]}）`, basis: 'profile', confirm: false });
          cands.push({ strategy: '聞き返す', en: 'Do you mean the current version or the next one?', ja: '今のバージョンのことですか、次のことですか？', basis: 'none', confirm: false });
        } else {
          cands.push({ strategy: '聞き返す', en: 'Sorry, could you say that again more slowly?', ja: 'すみません、もう一度ゆっくり言ってもらえますか？', basis: 'none', confirm: false });
          cands.push({ strategy: '保留する', en: 'I don\'t have that information right now. I will check and follow up.', ja: '今は情報がありません。確認して追って連絡します。', basis: 'none', confirm: false });
        }
        for (let i = 0; i < Math.min(3, cands.length); i++) {
          if (i) await wait(stepMs);
          onCandidate(i, { index: i, ...cands[i], done: true });
        }
        onDone({ usage: null, costUsd: 0, mock: true });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        onError({ code: 'mock', message: String(e?.message || e) });
      }
    },
  };
}
