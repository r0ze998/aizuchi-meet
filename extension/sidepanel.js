import { DEFAULT_SETTINGS, STORAGE_KEYS, describeDestinations } from './lib/constants.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = null;          // latest snapshot from the offscreen session
let invokedTab = null;     // tab chosen by the toolbar click
let settings = { ...DEFAULT_SETTINGS };
let pendingStart = false;

const sendSw = (msg) => chrome.runtime.sendMessage({ target: 'sw', ...msg }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
const sendOff = (msg) => chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch((e) => ({ ok: false, error: String(e?.message || e) }));

let translatorWarm = null;
// Chrome only downloads the on-device translation model during a user click. The offscreen document never
// has one, so the side panel prepares the model when the user presses 開始.
function warmTranslator() {
  if (settings.translateProvider !== 'chrome') return null;
  if (typeof Translator === 'undefined') { notice('この Chrome では端末内翻訳（Translator API）が使えません。設定画面で翻訳の方式を変えてください。', 'error'); return null; }
  if (translatorWarm) return translatorWarm;
  const opts = { sourceLanguage: 'en', targetLanguage: 'ja' };
  let created;
  try {
    // create() is called synchronously inside the click so the download is permitted.
    created = Translator.create({ ...opts, monitor(m) { m.addEventListener('downloadprogress', (e) => notice(`翻訳モデルをダウンロード中… ${Math.round((e.loaded || 0) * 100)}%（終わるまで訳は出ません）`, 'info')); } });
  } catch (e) { notice(`翻訳モデルを準備できません: ${e?.name || ''} ${e?.message || e}`, 'error'); return null; }
  translatorWarm = created.then((t) => { try { t.destroy?.(); } catch { /* ignore */ } setTranslatorStatus('ready'); return 'ready'; })
    .catch((e) => { translatorWarm = null; setTranslatorStatus('error'); notice(`翻訳モデルを準備できません: ${e?.name || ''} ${e?.message || e}`, 'error'); return 'error'; });
  return translatorWarm;
}
let translatorStatus = '';
function setTranslatorStatus(s) { translatorStatus = s; if (s === 'ready') { const n = $('notice'); if (n && /翻訳モデル/.test(n.textContent)) notice(''); } }

function notice(text, kind = 'warn') { const n = $('notice'); if (!text) { n.hidden = true; return; } n.textContent = text; n.className = `notice ${kind === 'error' ? 'err' : ''}`; n.hidden = false; }

async function init() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
  invokedTab = (await sendSw({ type: 'get-invoked' })) || null;
  if (invokedTab && typeof invokedTab === 'object' && 'ok' in invokedTab && !invokedTab.tabId) invokedTab = null;
  const r = await sendOff({ type: 'get-state' });
  state = r?.state || null;
  render();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'panel') return;
  if (msg.type === 'state') { state = msg.state; render(); }
  if (msg.type === 'invoked') { invokedTab = msg.invokedTab; render(); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.settings]) { settings = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEYS.settings].newValue || {}) }; render(); }
});

// ---------- controls ----------
$('btnStart').addEventListener('click', () => beginStart());
$('consentAck').addEventListener('change', (e) => { $('btnConsentStart').disabled = !e.target.checked; });
$('btnConsentCancel').addEventListener('click', () => { $('consent').hidden = true; pendingStart = false; });
$('btnConsentStart').addEventListener('click', async () => { warmTranslator(); await chrome.storage.session.set({ consentAcked: Date.now() }); $('consent').hidden = true; doStart(); });
$('btnPause').addEventListener('click', () => sendOff({ type: 'pause' }));
$('btnResume').addEventListener('click', () => sendOff({ type: 'resume' }));
$('btnStop').addEventListener('click', () => sendOff({ type: 'stop', reason: 'user' }));
$('btnOptions').addEventListener('click', () => sendSw({ type: 'open-options' }));
$('btnMicPerm').addEventListener('click', () => sendSw({ type: 'open-mic-permission' }));
$('micToggle').addEventListener('change', async (e) => {
  if (e.target.checked) { const r = await sendOff({ type: 'mic-enable' }); if (!r?.ok) { e.target.checked = false; notice('マイクを有効にできません。先に「マイク許可ページ」で許可してから、取得中にもう一度お試しください。'); } }
  else sendOff({ type: 'mic-disable' });
});
$('refineForm').addEventListener('submit', (e) => { e.preventDefault(); sendOff({ type: 'refine', text: $('refineInput').value }); });
$('btnCopyMetrics').addEventListener('click', async () => {
  const payload = { exportedAt: new Date().toISOString(), metrics: state?.metrics || {}, usage: state?.usage || {}, audio: state?.audio || {}, providers: state?.providers || {} };
  try { await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)); notice('遅延データをコピーしました', 'info'); setTimeout(() => notice(''), 1500); } catch { notice('コピーできませんでした', 'error'); }
});

async function beginStart() {
  notice('');
  warmTranslator();
  if (settings.replyProvider === 'direct') {
    chrome.storage.local.get(STORAGE_KEYS.anthropicKey).then(({ anthropicKey }) => { if (!anthropicKey) notice('返答候補を出すには、設定（⚙）の「Anthropic API」でキーを入れてください。訳だけならこのまま使えます。'); });
  }
  if (!invokedTab?.tabId) { notice('Meet タブを開いた状態で、ツールバーの Aizuchi アイコン（または ⌘⇧Y）を押してください。押したタブの音声だけを取得します。'); return; }
  const { consentAcked } = await chrome.storage.session.get('consentAcked');
  if (!consentAcked) {
    $('consentTab').textContent = invokedTab.title ? `「${invokedTab.title}」` : '選択したタブ';
    $('consentDest').innerHTML = describeDestinations(settings).map((d) => `<li>${esc(d.stage)}: ${esc(d.label)}${d.external ? '（外部送信）' : ''}</li>`).join('');
    $('consentAck').checked = false; $('btnConsentStart').disabled = true;
    $('consent').hidden = false; pendingStart = true; return;
  }
  doStart();
}
async function doStart() {
  $('btnStart').disabled = true;
  const r = await sendSw({ type: 'start', tabId: invokedTab?.tabId });
  $('btnStart').disabled = false;
  if (r?.ok) return;
  const msgs = {
    'needs-invoke': 'このタブに対する許可が切れています。Meet タブでツールバーの Aizuchi アイコン（または ⌘⇧Y）を押してから、もう一度「開始」を押してください。',
    'no-tab': 'Meet タブでツールバーの Aizuchi アイコンを押してから開始してください。',
    'already-captured': 'このタブは別の拡張または機能が取得中のため開始できません。',
    'tab-gone': '選んだタブが見つかりません。Meet タブでアイコンを押し直してください。',
  };
  notice(msgs[r?.code] || `開始できませんでした: ${r?.error || '不明なエラー'}`, 'error');
}

// ---------- rendering ----------
function fmtTime(ts) { const d = new Date(ts); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; }

function render() {
  const s = state;
  const status = s?.status || 'idle';
  const pill = $('statusPill');
  const labels = { idle: '待機', starting: '開始中…', capturing: '取得中', paused: '一時停止', stopping: '停止中…', stopped: s?.ended ? '停止しました' : '停止', error: 'エラー' };
  pill.textContent = labels[status] || status;
  pill.className = `pill ${status}`;
  $('captureDot').hidden = status !== 'capturing';
  const tabLabel = status === 'capturing' || status === 'paused' ? (s.tabTitle || `タブ ${s.tabId}`) : invokedTab?.title ? `対象: ${invokedTab.title}` : '対象タブ未選択（Meet タブでアイコンを押す）';
  $('tabName').textContent = tabLabel; $('tabName').title = tabLabel;
  $('btnStart').hidden = status === 'capturing' || status === 'paused' || status === 'starting';
  $('btnPause').hidden = status !== 'capturing';
  $('btnResume').hidden = status !== 'paused';
  $('btnStop').hidden = !(status === 'capturing' || status === 'paused');
  const dests = status === 'capturing' || status === 'paused' ? s.destinations : describeDestinations(settings);
  $('dest').innerHTML = dests.map((d) => `<span class="${d.external ? 'ext' : ''}">${esc(d.stage)}: ${esc(d.label.replace(/\s*\(.*?\)\s*/g, ' ').trim())}${d.external ? ' ↗' : ''}</span>`).join('');
  $('level').style.width = `${Math.round((s?.audio?.level || 0) * 100)}%`;
  $('level').style.background = s?.audio?.speaking ? 'var(--ok)' : 'var(--accent)';

  if (s?.ended) notice(`停止しました（理由: ${reasonLabel(s.reason)}）。${s.settings?.persistSession ? '設定により内容を保持しています。' : '会議中の文脈はメモリから破棄しました。この表示は次の開始まで残ります。'}`, 'info');
  else if (status === 'capturing' && s.audio?.trackState === 'muted') notice('音声トラックがミュート状態です。Meet 側の音声を確認してください。', 'warn');

  renderTranscript(s);
  renderAsk(s);
  renderCandidates(s);
  renderRefine(s);
  renderIssues(s);
  renderMetrics(s);
  $('micToggle').checked = !!s?.mic?.enabled;
  $('micState').textContent = s?.mic?.state === 'on' ? '取得中（別経路）' : s?.mic?.state === 'denied' ? '許可されていません' : '';
  $('micToggle').disabled = !(status === 'capturing' || status === 'paused');
}
function reasonLabel(r) { return { user: 'あなたの操作', 'tab-closed': 'タブが閉じられた', 'track-ended': '音声トラックの終了（権限取消や別の取得）', restart: '再開のため', 'start-failed': '開始に失敗' }[r] || r || '—'; }

function renderTranscript(s) {
  const box = $('transcript');
  const items = s?.transcript || [];
  if (!items.length) box.innerHTML = '<div class="empty">まだ発言を検知していません</div>';
  else box.innerHTML = items.slice(-12).map((t) => {
    const who = t.speaker === 'peer' ? '相手' : t.speaker === 'me-said' ? '自分（話した）' : '自分（マイク）';
    const jaCls = t.jaState === 'final' ? '' : t.jaState === 'error' ? 'error' : t.jaState === 'dropped' ? 'error' : 'pending';
    const ja = t.jaState === 'final' ? t.ja : t.jaState === 'error' ? '（翻訳に失敗）' : t.jaState === 'dropped' ? '（翻訳を省略: 混雑）' : t.speaker === 'peer' ? '翻訳中…' : '';
    return `<div class="utt ${t.speaker !== 'peer' ? 'me' : ''}"><div class="who">${who} · ${fmtTime(t.ts)}${t.unconfirmed ? ' · <span class="badge confirm">認識が途中で終了（未確定）</span>' : ''}</div><div class="en">${esc(t.en)}</div>${ja ? `<div class="ja ${jaCls}">${esc(ja)}</div>` : ''}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
  const it = $('interim');
  if (s?.interim?.en) { it.hidden = false; it.innerHTML = `<div class="lbl">聞き取り中…</div><div class="en">${esc(s.interim.en)}</div>${s.interim.ja ? `<div class="ja"><span class="lbl">途中訳</span> ${esc(s.interim.ja)}</div>` : ''}`; }
  else it.hidden = true;
}
function renderAsk(s) {
  const q = s?.question;
  const st = $('askState');
  if (!q) { $('ask').textContent = '—'; st.hidden = true; return; }
  st.hidden = false; st.textContent = q.state === 'provisional' ? '暫定（まだ話し中）' : '確定'; st.className = `tag ${q.state === 'provisional' ? 'prov' : 'final'}`;
  $('ask').innerHTML = `${esc(q.summaryJa || (q.kind === 'statement' ? '質問ではなく説明' : '要約中…'))}<small>${esc(q.en)}</small>`;
}
function candHtml(it, set, { pinned = false, pinId = null } = {}) {
  const badges = `${it.confirm ? '<span class="badge confirm">要確認・約束しない</span>' : ''}${it.basis === 'profile' ? '<span class="badge profile">登録情報</span>' : ''}`;
  const acts = pinned
    ? `<button data-act="unpin" data-pin="${esc(pinId)}">固定を解除</button><button data-act="spoken-text" data-en="${esc(it.en)}" data-ja="${esc(it.ja)}">これを話した</button>`
    : `<button data-act="pin" data-id="${esc(it.id)}">固定</button><button data-act="spoken" data-id="${esc(it.id)}">これを話した</button>`;
  return `<div class="cand ${it.spoken ? 'spoken' : ''} ${it.confirm ? 'confirm' : ''}"><div class="top"><span class="strategy">${esc(it.strategy || '候補')}</span>${badges}${pinned && set ? `<span class="muted">← ${esc(set)}</span>` : ''}</div><div class="en">${esc(it.en)}${it.done === false ? ' <span class="spin"></span>' : ''}</div><div class="ja">${esc(it.ja)}</div><div class="acts">${acts}</div></div>`;
}
function renderCandidates(s) {
  const sets = s?.candidateSets || [];
  const cur = sets.find((x) => x.relation === 'current');
  const st = $('candState');
  if (cur) {
    st.hidden = false;
    st.textContent = cur.status === 'generating' ? (cur.state === 'provisional' ? '暫定・生成中' : '生成中') : cur.state === 'provisional' ? '暫定' : cur.kind === 'statement' ? '反応の例' : '確定';
    st.className = `tag ${cur.status === 'generating' ? 'gen' : cur.state === 'provisional' ? 'prov' : 'final'}`;
  } else st.hidden = true;
  const box = $('cands');
  if (!cur) box.innerHTML = '<div class="empty">質問が確定すると、ここに最大3つの候補が出ます</div>';
  else {
    let html = cur.items.map((it) => candHtml(it, cur)).join('');
    if (cur.status === 'generating' && !cur.items.length) html += '<div class="empty"><span class="spin"></span> 候補を考えています…</div>';
    if (cur.status === 'done' && !cur.items.length) html += '<div class="empty">この発言には候補を出しませんでした（情報不足のときは聞き返しや確認が安全です）</div>';
    if (cur.error) html += `<div class="setErr">${esc(cur.error)}</div>`;
    box.innerHTML = html;
  }
  const old = sets.filter((x) => x.relation === 'old' && x.items.length).slice(0, 3);
  $('oldSets').hidden = !old.length;
  $('oldCands').innerHTML = old.map((set) => `<div class="muted" style="margin:6px 0 2px">${esc(set.summaryJa || set.questionText.slice(0, 60))} · ${fmtTime(set.createdAt)}</div>${set.items.map((it) => candHtml(it, set)).join('')}`).join('');
  const pins = s?.pinned || [];
  $('pinned').innerHTML = pins.length ? `<div class="hdr">固定中（更新で消えません）</div>${pins.map((p) => candHtml({ ...p, id: p.itemId, done: true }, p.summaryJa || p.questionText?.slice(0, 40), { pinned: true, pinId: p.pinId })).join('')}` : '';
}
function renderRefine(s) {
  const r = s?.refine;
  const out = $('refineOut');
  if (!r || (!r.items.length && !r.generating && !r.error)) { out.innerHTML = ''; return; }
  let html = r.items.filter(Boolean).map((it) => `<div class="cand"><div class="top"><span class="strategy">${esc(it.strategy || '言い直し')}</span></div><div class="en">${esc(it.en)}</div><div class="ja">${esc(it.ja)}</div><div class="acts"><button data-act="pin-text" data-en="${esc(it.en)}" data-ja="${esc(it.ja)}">固定</button><button data-act="spoken-text" data-en="${esc(it.en)}" data-ja="${esc(it.ja)}">これを話した</button></div></div>`).join('');
  if (r.generating) html += '<div class="empty"><span class="spin"></span> 英語にしています…</div>';
  if (r.error) html += `<div class="setErr">${esc(r.error)}</div>`;
  out.innerHTML = html;
}
function renderIssues(s) {
  const list = (s?.issues || []).filter((i) => i.level !== 'info').slice(-8).reverse();
  $('secIssues').hidden = !list.length && !(s?.audio?.dropped?.count);
  const drop = s?.audio?.dropped;
  const dropLine = drop?.count ? `<li class="warn">取りこぼしの可能性: ${drop.count} 回${drop.ms ? `（合計 約${Math.round(drop.ms / 100) / 10} 秒）` : ''}</li>` : '';
  $('issues').innerHTML = dropLine + list.map((i) => `<li class="${esc(i.level)}">${fmtTime(i.ts)} ${esc(i.message)}</li>`).join('');
}
function renderMetrics(s) {
  const m = s?.metrics || {};
  const rows = Object.entries(m).filter(([, v]) => v.n > 0);
  $('metrics').innerHTML = rows.length ? '<tr><th>区間</th><th>n</th><th>p50</th><th>p95</th></tr>' + rows.map(([k, v]) => `<tr><td>${esc(v.label || k)}</td><td class="num">${v.n}</td><td class="num">${v.p50} ms</td><td class="num">${v.p95} ms</td></tr>`).join('') : '<tr><td class="muted">まだ計測がありません</td></tr>';
  const u = s?.usage;
  const sp = s?.spend;
  $('usage').textContent = u?.requests || sp?.requests ? `生成 ${u?.requests || 0} 回 / この会議の推定費用 $${(sp && s?.settings?.replyProvider === 'direct' ? sp.spentUsd : (u?.costUsd || 0)).toFixed(4)}${sp && s?.settings?.replyProvider === 'direct' ? `（上限 $${sp.maxSessionUsd.toFixed(2)}）` : ''}` : '';
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'pin') sendOff({ type: 'pin', itemId: b.dataset.id });
  else if (act === 'pin-text') sendOff({ type: 'pin', text: { en: b.dataset.en, ja: b.dataset.ja } });
  else if (act === 'unpin') sendOff({ type: 'unpin', pinId: b.dataset.pin });
  else if (act === 'spoken') sendOff({ type: 'spoken', itemId: b.dataset.id });
  else if (act === 'spoken-text') sendOff({ type: 'spoken', text: { en: b.dataset.en, ja: b.dataset.ja } });
});

init();
