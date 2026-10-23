import { DEFAULT_SETTINGS, STORAGE_KEYS } from './lib/constants.js';
import { KINDS, emptyProfile, normalizeProfile, detectConflicts } from './lib/profile.js';
import { RelayClient } from './lib/relay-client.js';
import { MODELS, PRICES, classifyError } from './lib/claude.js';
import { makeClient } from './lib/providers/reply-direct.js';
import Anthropic from './vendor/anthropic-sdk.js';
import { webSpeechLocalAvailability, webSpeechLocalInstall } from './lib/providers/stt-webspeech.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function notice(text, kind = 'warn') { const n = $('notice'); if (!text) { n.hidden = true; return; } n.textContent = text; n.className = `notice ${kind === 'error' ? 'err' : ''}`; n.hidden = false; }

const SAMPLE = {
  version: 1,
  meta: { project: 'Zentoria（架空のサンプル: Solana 上の戦略ゲーム）', counterpart: '投資家（サンプル）', purpose: '進捗共有と次のステップの相談', updatedAt: '2026-10-24' },
  me: { name: '', role: '創業者・ゲーム開発者（サンプル）', notes: '数字は確認してから答えたい。短い文で話したい。' },
  intents: { pricing: false, deadlines: false, hiring: false, other: '' },
  items: [
    { id: 's1', kind: 'fact', topic: 'チェーン chain', text: 'Zentoria runs on Solana.', updatedAt: '2026-10-02', source: 'サンプル' },
    { id: 's2', kind: 'fact', topic: 'デモ demo', text: 'We have a playable demo on a test network.', updatedAt: '2026-10-10', source: 'サンプル' },
    { id: 's3', kind: 'plan', topic: 'AI', text: 'We plan to use AI for in-game agents and testing. Details are open.', updatedAt: '2026-10-10', source: 'サンプル' },
    { id: 's4', kind: 'undecided', topic: '資金調達 fundraising', text: 'The timing of a seed round is not decided.', updatedAt: '2026-10-15', source: 'サンプル' },
    { id: 's5', kind: 'undecided', topic: 'ローンチ launch', text: 'The launch date is not decided. It depends on the test build.', updatedAt: '2026-10-15', source: 'サンプル' },
    { id: 's6', kind: 'fact', topic: 'ローンチ launch', text: 'We plan to launch in December 2026.', updatedAt: '2026-09-01', source: 'サンプル（古い情報・矛盾の例）' },
    { id: 's7', kind: 'avoid', topic: '契約 commitments', text: 'Do not promise prices, deadlines or exclusive deals in this meeting.', updatedAt: '2026-10-17', source: 'サンプル' },
  ],
};

let profile = emptyProfile();
let settings = { ...DEFAULT_SETTINGS };

function renderProfile() {
  $('p_project').value = profile.meta.project; $('p_counterpart').value = profile.meta.counterpart; $('p_purpose').value = profile.meta.purpose; $('p_updatedAt').value = profile.meta.updatedAt;
  $('me_name').value = profile.me.name; $('me_role').value = profile.me.role; $('me_notes').value = profile.me.notes;
  $('i_pricing').checked = !!profile.intents.pricing; $('i_deadlines').checked = !!profile.intents.deadlines; $('i_hiring').checked = !!profile.intents.hiring; $('i_other').value = profile.intents.other || '';
  $('items').innerHTML = profile.items.map((it, i) => `<tr data-i="${i}">
    <td><select data-k="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${it.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
    <td><input data-k="topic" value="${esc(it.topic)}"></td>
    <td><textarea data-k="text">${esc(it.text)}</textarea></td>
    <td><input data-k="updatedAt" type="date" value="${esc(it.updatedAt)}"></td>
    <td><input data-k="source" value="${esc(it.source)}"></td>
    <td><button data-del="${i}" class="ghost" title="削除">✕</button></td></tr>`).join('');
  renderConflicts();
  $('profileJson').value = JSON.stringify(profile, null, 2);
}
function renderConflicts() {
  const c = detectConflicts(profile.items);
  $('conflicts').innerHTML = c.map((x) => `<div class="conflict">⚠ 「${esc(x.topic)}」に矛盾の可能性: ${x.items.map((i) => `「${esc(i.text)}」(${esc(i.updatedAt || '日付不明')})`).join(' / ')} — 候補では断定せず確認を促します</div>`).join('');
}
function collectProfile() {
  const p = normalizeProfile(profile);
  p.meta = { project: $('p_project').value, counterpart: $('p_counterpart').value, purpose: $('p_purpose').value, updatedAt: $('p_updatedAt').value };
  p.me = { name: $('me_name').value, role: $('me_role').value, notes: $('me_notes').value };
  p.intents = { pricing: $('i_pricing').checked, deadlines: $('i_deadlines').checked, hiring: $('i_hiring').checked, other: $('i_other').value };
  p.items = [...$('items').querySelectorAll('tr')].map((tr, i) => {
    const g = (k) => tr.querySelector(`[data-k="${k}"]`).value;
    return { id: profile.items[i]?.id || `i${Date.now()}${i}`, kind: g('kind'), topic: g('topic'), text: g('text'), updatedAt: g('updatedAt'), source: g('source') };
  });
  return normalizeProfile(p);
}
async function saveProfile() {
  profile = collectProfile();
  await chrome.storage.local.set({ [STORAGE_KEYS.profile]: profile });
  renderProfile();
  $('profileSaved').textContent = `保存しました ${new Date().toLocaleTimeString()}`;
}
$('items').addEventListener('click', (e) => { const b = e.target.closest('button[data-del]'); if (!b) return; profile = collectProfile(); profile.items.splice(+b.dataset.del, 1); renderProfile(); });
$('items').addEventListener('input', () => { profile = collectProfile(); renderConflicts(); });
$('btnAddItem').addEventListener('click', () => { profile = collectProfile(); profile.items.push({ id: `i${Date.now()}`, kind: 'fact', topic: '', text: '', updatedAt: new Date().toISOString().slice(0, 10), source: '' }); renderProfile(); });
$('btnSample').addEventListener('click', () => { profile = normalizeProfile(SAMPLE); renderProfile(); notice('サンプルを読み込みました（保存はまだです）。内容はあなたの事実に合わせて修正してください。', 'info'); });
$('btnSaveProfile').addEventListener('click', saveProfile);
$('btnExport').addEventListener('click', () => { $('profileJson').value = JSON.stringify(collectProfile(), null, 2); });
$('btnImport').addEventListener('click', async () => { try { profile = normalizeProfile(JSON.parse($('profileJson').value)); await chrome.storage.local.set({ [STORAGE_KEYS.profile]: profile }); renderProfile(); notice('JSON を読み込んで保存しました', 'info'); } catch (e) { notice(`JSON を読めません: ${e.message}`, 'error'); } });

function renderSettings() {
  $('s_stt').value = settings.sttProvider; $('s_sttLang').value = settings.sttLang; $('s_sttLocal').checked = !!settings.sttProcessLocally;
  $('s_translate').value = settings.translateProvider; $('s_reply').value = settings.replyProvider;
  $('s_relayUrl').value = settings.relayUrl;
  $('s_replyModel').innerHTML = MODELS.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
  $('s_replyModel').value = settings.replyModel;
  $('s_maxSessionUsd').value = settings.maxSessionUsd;
  $('s_maxReqPerMin').value = settings.maxReqPerMin;
  renderCost();
  for (const k of ['stableMs', 'translateDebounceMs', 'silenceMs', 'turnEndMs', 'provisionalMinWords']) $(`s_${k}`).value = settings[k];
  $('s_persistSession').checked = !!settings.persistSession;
}
async function saveSettings() {
  const s = { ...settings };
  s.sttProvider = $('s_stt').value; s.sttLang = $('s_sttLang').value.trim() || 'en-US'; s.sttProcessLocally = $('s_sttLocal').checked;
  s.translateProvider = $('s_translate').value; s.replyProvider = $('s_reply').value;
  s.relayUrl = $('s_relayUrl').value.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.relayUrl;
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(s.relayUrl)) { notice('中継 URL はループバック (http://127.0.0.1:ポート) のみ使えます', 'error'); return; }
  for (const k of ['stableMs', 'translateDebounceMs', 'silenceMs', 'turnEndMs', 'provisionalMinWords']) s[k] = Number($(`s_${k}`).value) || DEFAULT_SETTINGS[k];
  s.persistSession = $('s_persistSession').checked;
  s.replyModel = MODELS.some((m) => m.id === $('s_replyModel').value) ? $('s_replyModel').value : DEFAULT_SETTINGS.replyModel;
  s.maxSessionUsd = Math.min(50, Math.max(0.05, Number($('s_maxSessionUsd').value) || DEFAULT_SETTINGS.maxSessionUsd));
  s.maxReqPerMin = Math.min(120, Math.max(1, Number($('s_maxReqPerMin').value) || DEFAULT_SETTINGS.maxReqPerMin));
  settings = s;
  const token = $('s_relayToken').value.trim();
  const payload = { [STORAGE_KEYS.settings]: settings };
  if (token) payload[STORAGE_KEYS.relayToken] = token;
  await chrome.storage.local.set(payload);
  if (token) $('s_relayToken').value = '';
  $('settingsSaved').textContent = `保存しました ${new Date().toLocaleTimeString()}${token ? '（トークンも保存）' : ''}`;
}
$('btnSaveSettings').addEventListener('click', saveSettings);

// ---- Anthropic API key (direct connection) ----
function renderCost() {
  const m = $('s_replyModel').value || settings.replyModel;
  const p = PRICES[m];
  const perReq = p ? (2000 * p.in + 400 * p.out) / 1e6 : 0;
  $('apiCost').textContent = p ? `目安: 1 回の候補生成 約 $${perReq.toFixed(4)}、60 分の会議（約 90 回）で 約 $${(perReq * 90).toFixed(2)}。上限に達すると候補生成を止めます。請求額は Anthropic Console で確認してください。` : '';
}
$('s_replyModel').addEventListener('change', async () => { renderCost(); settings.replyModel = $('s_replyModel').value; await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings }); });
async function renderKeyState() {
  const { anthropicKey } = await chrome.storage.local.get(STORAGE_KEYS.anthropicKey);
  $('apiState').innerHTML = anthropicKey ? `<span class="ok">保存済み（…${esc(anthropicKey.slice(-4))}）</span>` : '<span class="ng">未設定</span>';
}
$('btnApiSave').addEventListener('click', async () => {
  const key = $('api_key').value.trim();
  if (!key) { notice('キーを貼り付けてから「キーを保存」を押してください', 'error'); return; }
  if (!/^sk-ant-[A-Za-z0-9_-]{10,}$/.test(key)) { notice('キーの形式が違うようです（sk-ant- で始まる文字列）。貼り付け直してください。', 'error'); return; }
  await chrome.storage.local.set({ [STORAGE_KEYS.anthropicKey]: key });
  $('api_key').value = '';
  const s = { ...settings, replyProvider: 'direct' };
  settings = s; await chrome.storage.local.set({ [STORAGE_KEYS.settings]: s }); renderSettings();
  notice('キーを保存し、返答候補を「Anthropic に直接」にしました。「接続を確認」で確かめられます（無料）。', 'info');
  renderKeyState();
});
$('btnApiDelete').addEventListener('click', async () => { await chrome.storage.local.remove(STORAGE_KEYS.anthropicKey); renderKeyState(); notice('キーを削除しました', 'info'); });
// Checks the key with the Models API (no tokens are used, so this is free).
$('btnApiCheck').addEventListener('click', async () => {
  const el = $('apiState');
  const { anthropicKey } = await chrome.storage.local.get(STORAGE_KEYS.anthropicKey);
  if (!anthropicKey) { el.innerHTML = '<span class="ng">キーが未設定です</span>'; return; }
  const model = $('s_replyModel').value || settings.replyModel;
  el.textContent = '確認中…';
  try {
    const m = await makeClient(anthropicKey, { baseURL: settings.anthropicBaseUrl || undefined }).models.retrieve(model);
    el.innerHTML = `<span class="ok">接続OK</span> ${esc(m.display_name || m.id)} を使えます（…${esc(anthropicKey.slice(-4))}）`;
  } catch (e) {
    const code = classifyError(e, Anthropic);
    const why = { auth: 'キーが無効です（401）', permission: 'このキーではこのモデルを使えません（403）', 'model-not-found': 'モデルが見つかりません（404）', 'unreachable-api': 'Anthropic に接続できません', 'rate-limited': '回数の上限です。少し待ってから' }[code] || (e?.message || String(e)).slice(0, 120);
    el.innerHTML = `<span class="ng">失敗: ${esc(why)}</span>`;
  }
});

$('btnRelayCheck').addEventListener('click', async () => {
  const url = $('s_relayUrl').value.trim();
  const { relayToken } = await chrome.storage.local.get(STORAGE_KEYS.relayToken);
  const token = $('s_relayToken').value.trim() || relayToken || '';
  const el = $('relayState'); el.textContent = '確認中…'; el.className = 'kv';
  try {
    const h = await new RelayClient({ baseUrl: url, token }).health();
    el.innerHTML = `<span class="ok">接続OK</span> upstream=${esc(h.upstream)} model=${esc(h.model || '-')} 上限 $${esc(h.limits?.maxSessionUsd)} / ${esc(h.limits?.maxReqPerMin)}req/min 累計 $${esc((h.spentUsd ?? 0).toFixed?.(4) ?? h.spentUsd)}`;
  } catch (e) { el.innerHTML = `<span class="ng">失敗: ${esc(e.code || '')} ${esc(e.message)}</span>`; }
});
async function refreshSttLocal() { const a = await webSpeechLocalAvailability($('s_sttLang').value || 'en-US'); $('sttLocalState').textContent = `オンデバイス: ${a}`; }
$('btnSttLocalPrep').addEventListener('click', async () => { $('sttLocalState').textContent = '準備中…'; try { const ok = await webSpeechLocalInstall($('s_sttLang').value || 'en-US'); $('sttLocalState').textContent = ok ? '準備できました' : '準備できませんでした（Chrome が対応していないか、ダウンロード不可）'; } catch (e) { $('sttLocalState').textContent = `失敗: ${e.message}`; } refreshSttLocal(); });
async function refreshTranslator() {
  const el = $('translatorState');
  if (typeof globalThis.Translator === 'undefined') { el.innerHTML = '<span class="ng">Translator API なし</span>'; return; }
  try { const a = await globalThis.Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ja' }); el.textContent = `en→ja: ${a}`; } catch (e) { el.textContent = `確認失敗: ${e.message}`; }
}
$('btnTranslatorPrep').addEventListener('click', async () => {
  const el = $('translatorState');
  if (typeof globalThis.Translator === 'undefined') { el.innerHTML = '<span class="ng">Translator API なし</span>'; return; }
  try {
    const t = await globalThis.Translator.create({ sourceLanguage: 'en', targetLanguage: 'ja', monitor(m) { m.addEventListener('downloadprogress', (e) => { el.textContent = `ダウンロード中 ${Math.round((e.loaded || 0) * 100)}%`; }); } });
    const sample = await t.translate('Could you tell us more about the team behind the project?');
    el.innerHTML = `<span class="ok">準備OK</span> 例: ${esc(sample)}`;
    t.destroy?.();
  } catch (e) { el.innerHTML = `<span class="ng">失敗: ${esc(e.message)}</span>`; }
});
$('btnPromptCheck').addEventListener('click', async () => {
  const el = $('promptState');
  if (typeof globalThis.LanguageModel === 'undefined') { el.innerHTML = '<span class="ng">Prompt API なし</span>'; return; }
  try { const a = await Promise.race([globalThis.LanguageModel.availability({ expectedOutputs: [{ type: 'text', languages: ['ja', 'en'] }] }), new Promise((_, rej) => setTimeout(() => rej(new Error('10 秒以内に応答がありません（この環境では利用できない可能性）')), 10000))]); el.textContent = `Gemini Nano: ${a}${a === 'downloadable' ? '（モデルは数GB。ダウンロードは明示的に選んだ時だけ始まります）' : ''}`; } catch (e) { el.textContent = `確認失敗: ${e.message}`; }
});

(async function init() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.profile]);
  settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
  profile = normalizeProfile(stored[STORAGE_KEYS.profile]);
  renderProfile(); renderSettings(); renderKeyState();
  refreshSttLocal(); refreshTranslator();
})();
