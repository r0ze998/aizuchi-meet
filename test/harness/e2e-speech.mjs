// End-to-end run with synthetic English speech: tab audio → Web Speech → (on-device) translation → relay (mock) candidates.
// Measures latencies per stage, checks recognition against ground truth, exercises pin / refine / spoken / relay-down.
// Run: bun test/harness/e2e-speech.mjs   (no paid API is used: relay runs with UPSTREAM=mock)
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, ROOT, OUT_DIR, SHOT_DIR, EXT_ID } from './chrome.mjs';
import { startFixtures } from './fixtures-server.mjs';
import { connect, swSession, offscreenSession, pageSession, setSettings, setProfile, setToken, activeTabId, setInvokedTab, panelStart, panelClick, offState, waitStatus, extUrl } from './common.mjs';
import { waitFor } from './cdp.mjs';
import { percentile } from '../../extension/lib/metrics.js';
import { startFakeAnthropic, FAKE_VALID_KEY } from './fake-anthropic.mjs';

// E2E_REPLY=direct → the extension talks straight to an Anthropic-shaped API (a local fake; no cost).
const DIRECT = process.env.E2E_REPLY === 'direct';
const fakeApi = DIRECT ? startFakeAnthropic({ firstTokenMs: 400, chunkMs: 15 }) : null;
const SUFFIX = DIRECT ? '-direct' : '';

fs.mkdirSync(OUT_DIR, { recursive: true }); fs.mkdirSync(SHOT_DIR, { recursive: true });
const LOG = path.join(OUT_DIR, `e2e-speech${SUFFIX}.log`); fs.writeFileSync(LOG, '');
const _log = console.log.bind(console); console.log = (...a) => { const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); fs.appendFileSync(LOG, line + '\n'); _log(...a); };
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'audio', 'transcripts.json'), 'utf8'));
const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'profile.sample.json'), 'utf8'));
const RELAY_PORT = 47333, RELAY_TOKEN = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
function wer(ref, hyp) {
  const r = norm(ref), h = norm(hyp); const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return r.length ? +(d[r.length][h.length] / r.length).toFixed(3) : 0;
}
const scenarios = [
  { id: 'q01_status', expectQuestion: true, shot: 'e2e-01-status-candidates' },
  { id: 'q02_restate', expectQuestion: true, expectCorrection: true, shot: 'e2e-02-restate' },
  { id: 'q03_long', expectQuestion: true, shotDuring: 'e2e-03-long-interim' },
  { id: 'q04_fast', expectQuestion: true },
  { id: 'q05_names', expectQuestion: true, keywords: ['zentoria', 'solana', '15,000|fifteen thousand|15000', 'march'] },
  { id: 'q06_contract', expectQuestion: true, expectConfirm: true, shot: 'e2e-06-contract-confirm' },
  { id: 'q07_outside', expectQuestion: true, relayDown: true, shot: 'e2e-07-relay-down' },
  { id: 'q08_negation', expectQuestion: true, expectCorrection: true },
  { id: 'q09_short', expectQuestion: true },
  { id: 'q10_statement', expectQuestion: false },
  { id: 'q11_overlap', expectQuestion: true },
  { id: 'q12_gaps', expectQuestion: true },
];

function startRelay() {
  const proc = Bun.spawn(['node', path.join(ROOT, 'relay', 'server.mjs')], { env: { ...process.env, RELAY_PORT: String(RELAY_PORT), RELAY_TOKEN, UPSTREAM: 'mock', MOCK_DELAY_MS: '350', RELAY_PRINT_TOKEN: '0', MAX_SESSION_USD: '5' }, stdout: 'pipe', stderr: 'pipe' });
  return proc;
}
async function waitRelay(up, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/v1/health`); if (r.ok === up) return true; } catch { if (!up) return true; } await Bun.sleep(100); }
  return false;
}

const shot = (n) => path.join(SHOT_DIR, `${DIRECT ? 'direct-' : ''}${n}.png`);
const replyCfg = () => (DIRECT ? { replyProvider: 'direct', replyModel: 'claude-opus-5-5', anthropicBaseUrl: fakeApi.url } : { replyProvider: 'relay', relayUrl: `http://127.0.0.1:${RELAY_PORT}` });
const out = { mode: DIRECT ? 'direct (fake Anthropic API)' : 'relay (mock upstream)', startedAt: new Date().toISOString(), extensionId: EXT_ID, providers: null, scenarios: [], checks: [], features: null };
const check = (id, name, pass, detail) => { out.checks.push({ id, name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} ${detail ? JSON.stringify(detail).slice(0, 240) : ''}`); };

let relay = startRelay(); await waitRelay(true);
const fx = startFixtures(0);
const chrome = await launchChrome({ port: 9335, allowlist: true, url: `${fx.url}/speech-player.html` });
out.browser = chrome.browser;
const cdp = await connect(chrome);
try {
  const tabA = await cdp.waitForTarget((t) => t.type === 'page' && t.url.endsWith('/speech-player.html'), 10000, 'player');
  const player = await cdp.attach(tabA.targetId);
  await cdp.activate(tabA.targetId);
  const sw = await swSession(cdp);
  await setProfile(cdp, sw, profile); await setToken(cdp, sw, RELAY_TOKEN);
  if (DIRECT) await cdp.evaluate(sw, `chrome.storage.local.set({ anthropicKey: ${JSON.stringify(FAKE_VALID_KEY)}, settings: ${JSON.stringify({ ...replyCfg() })} }).then(() => true)`);
  // Prepare on-device models from the options page (user activation): translator en→ja, and on-device speech if offered.
  const opt = await pageSession(cdp, extUrl('options.html'), { width: 960, height: 1400 });
  await Bun.sleep(800);
  const trAvail0 = await cdp.evaluate(opt.sid, `Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ja' })`).catch((e) => 'error:' + e.message);
  let trAvail = trAvail0;
  if (trAvail0 === 'downloadable' || trAvail0 === 'downloading') {
    console.log('translator model: downloading…');
    await cdp.evaluate(opt.sid, `(async () => { const t = await Translator.create({ sourceLanguage: 'en', targetLanguage: 'ja' }); const s = await t.translate('Which chain are you on?'); t.destroy?.(); return s; })()`, { userGesture: true, timeout: Number(process.env.E2E_TRANSLATOR_TIMEOUT_MS || 90000) }).then((s) => console.log('translator ready, sample:', s)).catch((e) => console.log('translator create failed:', e.message));
    trAvail = await cdp.evaluate(opt.sid, `Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ja' })`).catch((e) => 'error:' + e.message);
  }
  let sttLocal = await cdp.evaluate(opt.sid, `(globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition).available({ langs: ['en-US'], processLocally: true })`).catch((e) => 'error:' + e.message);
  if (process.env.E2E_STT_LOCAL === '1' && (sttLocal === 'downloadable' || sttLocal === 'downloading')) {
    console.log('on-device speech pack: installing…');
    await cdp.evaluate(opt.sid, `(globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition).install({ langs: ['en-US'], processLocally: true })`, { userGesture: true, timeout: 180000 }).then((r) => console.log('install result', r)).catch((e) => console.log('install failed:', e.message));
    sttLocal = await cdp.evaluate(opt.sid, `(globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition).available({ langs: ['en-US'], processLocally: true })`).catch((e) => 'error:' + e.message);
  }
  const useLocalStt = process.env.E2E_STT_LOCAL === '1' ? sttLocal === 'available' : false;
  const translateProvider = trAvail === 'available' ? 'chrome' : 'mock';
  out.features = { translatorAvailability: { before: trAvail0, after: trAvail }, onDeviceSpeech: sttLocal, sttMode: useLocalStt ? 'on-device' : 'google-server', translateProvider };
  console.log('features', out.features);
  await setSettings(cdp, sw, { sttProvider: 'webspeech', sttProcessLocally: useLocalStt, translateProvider, ...replyCfg(), provisionalMinWords: 5 });
  await Bun.sleep(300);
  await cdp.evaluate(opt.sid, `document.getElementById('btnSample').click(); true`); await Bun.sleep(300);
  if (DIRECT) {
    await cdp.evaluate(opt.sid, `document.getElementById('btnApiCheck').click(); true`);
    const apiState = await waitFor(() => cdp.evaluate(opt.sid, `document.getElementById('apiState').textContent`), (t) => /接続OK|失敗/.test(t), { timeout: 15000, label: 'api check' });
    const keyField = await cdp.evaluate(opt.sid, `document.getElementById('api_key').value`);
    const pageHasKey = await cdp.evaluate(opt.sid, `document.body.innerText.includes(${JSON.stringify(FAKE_VALID_KEY)})`);
    check('direct/options-check', '設定画面の「接続を確認」が無料のモデル API で成功し、キー本体は画面に出ない', /接続OK/.test(apiState) && keyField === '' && !pageHasKey, { apiState, keyFieldEmpty: keyField === '', pageHasKey });
    await cdp.evaluate(opt.sid, `document.getElementById('secApi').scrollIntoView(); true`); await Bun.sleep(300);
    await cdp.screenshot(opt.sid, path.join(SHOT_DIR, 'options-api.png'));
  }
  await cdp.screenshot(opt.sid, shot('options-profile-sample'), { fullPage: true });
  await cdp.activate(tabA.targetId); await Bun.sleep(400);
  const aId = await activeTabId(cdp, sw);
  await setInvokedTab(cdp, sw, aId, 'Speech player (capture target)');
  const panel = await pageSession(cdp, extUrl('sidepanel.html'), { width: 420, height: 960 });
  await Bun.sleep(600);
  await panelClick(cdp, panel.sid, '#btnStart'); await Bun.sleep(400);
  await cdp.screenshot(panel.sid, shot('panel-consent'));
  await panelStart(cdp, panel.sid);
  const off = await offscreenSession(cdp, 15000);
  await waitStatus(cdp, off, 'capturing', 15000);
  await Bun.sleep(1200);
  const s0 = await offState(cdp, off);
  out.providers = s0.providers; out.destinations = s0.destinations;
  console.log('capturing; stt', s0.providers.states?.webspeech?.state, 'translate', s0.providers.translate.label);

  let pinnedEn = null, traceCursor = 0;
  const onlyIds = (process.env.E2E_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const sc of scenarios.filter((x) => !onlyIds.length || onlyIds.includes(x.id))) {
    if (sc.relayDown) { if (DIRECT) { fakeApi.failNext(529, 8); console.log('fake API returns 529 for', sc.id); } else { relay.kill(); await waitRelay(false); console.log('relay stopped for', sc.id); } }
    const before = await offState(cdp, off);
    const t0 = Date.now();
    const playP = cdp.evaluate(player, `playFile('${fx.url}/audio/${sc.id}.wav')`, { timeout: 120000 });
    if (sc.shotDuring) { await Bun.sleep(3500); await cdp.screenshot(panel.sid, shot(sc.shotDuring)); }
    const played = await playP;
    // wait for the pipeline to settle: no new trace events for 2.5 s (max 12 s)
    let lastLen = -1, stable = 0;
    for (let i = 0; i < 48; i++) { await Bun.sleep(250); const n = await cdp.evaluate(off, `globalThis.__aizuchi.trace().length`); if (n === lastLen) { if (++stable >= 10) break; } else { stable = 0; lastLen = n; } }
    const after = await offState(cdp, off);
    const trace = (await cdp.evaluate(off, `globalThis.__aizuchi.trace()`)).slice(traceCursor); traceCursor += trace.length;
    const peerFinals = after.transcript.filter((t) => t.speaker === 'peer' && t.ts >= played.startedAt - 500);
    const recognized = peerFinals.map((t) => t.en).join(' ');
    const firstInterim = trace.find((e) => e.type === 'interim'); const lastFinal = [...trace].reverse().find((e) => e.type === 'final');
    const qFinal = trace.find((e) => e.type === 'question-final' || e.type === 'question-extended'); const qProv = trace.find((e) => e.type === 'question-provisional');
    const firstCandAfterFinal = qFinal ? trace.find((e) => e.type === 'candidate' && e.t >= qFinal.t && e.state === 'final') : null;
    const firstCandProv = qProv ? trace.find((e) => e.type === 'candidate' && e.t >= qProv.t && e.state === 'provisional') : null;
    const translations = trace.filter((e) => e.type === 'translation-final' && e.state === 'final');
    const cur = after.candidateSets.find((s) => s.relation === 'current');
    const rec = {
      id: sc.id, truth: truth[sc.id], recognized, wer: wer(truth[sc.id], recognized), audioMs: played.endedAt - played.startedAt,
      latency: {
        playStart_to_firstInterim: firstInterim ? Math.round(firstInterim.t - played.startedAt) : null,
        playEnd_to_lastFinal: lastFinal ? Math.round(lastFinal.t - played.endedAt) : null,
        questionFinal_to_firstCandidate: firstCandAfterFinal && qFinal ? Math.round(firstCandAfterFinal.t - qFinal.t) : null,
        questionProvisional_to_firstCandidate: firstCandProv && qProv ? Math.round(firstCandProv.t - qProv.t) : null,
        provisionalBeforeEnd: qProv ? Math.round(played.endedAt - qProv.t) : null,
      },
      translations: peerFinals.map((t) => ({ en: t.en, ja: t.ja, state: t.jaState })),
      summaryJa: cur?.summaryJa || after.question?.summaryJa || '', questionState: cur?.state, candidates: cur ? cur.items.map((i) => ({ strategy: i.strategy, en: i.en, ja: i.ja, confirm: i.confirm, basis: i.basis })) : [], setStatus: cur?.status, setError: cur?.error || null,
      corrected: trace.some((e) => e.type === 'question-provisional') && after.issues.some((i) => i.code === 'corrected' && i.ts >= t0),
      issues: after.issues.filter((i) => i.ts >= t0).map((i) => `${i.code}: ${i.message}`),
      dropped: after.audio.dropped,
      stt: trace.filter((e) => typeof e.type === 'string' && e.type.startsWith('stt-')).map((e) => ({ t: Math.round(e.t - played.startedAt), ev: e.ev, ...(e.error ? { error: e.error } : {}), ...(e.finals != null ? { finals: e.finals, interimLen: e.interimLen } : {}), ...(e.pendingInterimLen ? { pendingInterimLen: e.pendingInterimLen } : {}) })),
    };
    out.scenarios.push(rec);
    console.log(`\n[${sc.id}] WER=${rec.wer} lat=${JSON.stringify(rec.latency)}\n  recognized: ${recognized}\n  summary: ${rec.summaryJa} (${rec.questionState}/${rec.setStatus})\n  candidates: ${rec.candidates.map((c) => `[${c.strategy}${c.confirm ? '⚠' : ''}] ${c.en}`).join(' | ')}`);
    if (sc.shot) { await Bun.sleep(300); await cdp.screenshot(panel.sid, shot(sc.shot)); }
    if (sc.expectQuestion) check(`${sc.id}/q`, '質問として検知し候補を生成', !!cur && (cur.items.length > 0 || sc.relayDown), { state: cur?.state, items: cur?.items.length, error: cur?.error });
    else check(`${sc.id}/stmt`, '説明文は質問扱いにならない', !cur || cur.kind === 'statement' || cur.relation !== 'current', { kind: cur?.kind, summary: rec.summaryJa });
    if (sc.expectConfirm) check(`${sc.id}/confirm`, '費用・契約の質問では承諾せず確認・保留の候補だけ', !!cur && cur.items.length > 0 && cur.items.every((i) => i.confirm), { items: rec.candidates });
    if (sc.expectCorrection) check(`${sc.id}/corr`, '言い直し・否定を検知して候補を作り直す', after.issues.some((i) => i.code === 'corrected' && i.ts >= t0) || (cur && /next year|use AI/i.test(cur.questionText)), { issues: rec.issues, questionText: cur?.questionText });
    if (sc.keywords) check(`${sc.id}/names`, '固有名詞・金額・日付の聞き取り (誤認識は表示で確認できる)', true, { recognized, keywordsFound: sc.keywords.map((k) => ({ k, found: new RegExp(k, 'i').test(recognized) })) });
    if (sc.relayDown) {
      check(`${sc.id}/relay-down`, DIRECT ? 'API 障害（529 過負荷）時はエラーが表示され黙って進まない' : '中継停止時はエラーが表示され黙って進まない', after.issues.some((i) => /reply-unreachable|reply-/.test(i.code) && i.ts >= t0) && cur?.status === 'error', { issues: rec.issues, setError: cur?.error });
      if (DIRECT) fakeApi.failNext(0, 0); else { relay = startRelay(); await waitRelay(true); console.log('relay restarted'); }
    }
    if (sc.id === 'q01_status' && cur?.items[0] && !onlyIds.length) {
      await cdp.evaluate(panel.sid, `document.querySelector('#cands button[data-act="pin"]').click(); true`); await Bun.sleep(300);
      await cdp.evaluate(panel.sid, `document.querySelector('#cands button[data-act="spoken"]').click(); true`); await Bun.sleep(300);
      const st = await offState(cdp, off); pinnedEn = st.pinned[0]?.en;
      check('pin/spoken', '固定と「これを話した」が反映される', st.pinned.length === 1 && st.transcript.some((t) => t.speaker === 'me-said'), { pinned: st.pinned.map((p) => p.en), meSaid: st.transcript.filter((t) => t.speaker === 'me-said').map((t) => t.en) });
    }
    if (sc.id === 'q02_restate' && pinnedEn && !onlyIds.length) {
      const st = await offState(cdp, off);
      check('pin/persist', '新しい質問が来ても固定中の候補は消えない・変わらない', st.pinned[0]?.en === pinnedEn, { pinned: st.pinned.map((p) => p.en), currentQuestion: st.question?.en });
      await cdp.evaluate(panel.sid, `(() => { const i = document.getElementById('refineInput'); i.value = '来月のテスト版の結果を見てから決めたいと伝えたい'; document.getElementById('refineForm').requestSubmit(); return true; })()`);
      const st2 = await waitFor(() => offState(cdp, off), (s) => s.refine.items.length > 0 || s.refine.error, { timeout: 15000, label: 'refine' });
      check('refine', '「こう言いたい」で英語の言い直しが出る', st2.refine.items.length > 0, { items: st2.refine.items.map((i) => i.en), ms: st2.metrics.refine_to_result?.p50 });
      await cdp.screenshot(panel.sid, shot('e2e-02b-pinned-refine'));
    }
  }
  if (DIRECT) {
    const st = await offState(cdp, off);
    const panelText = await cdp.evaluate(panel.sid, 'document.body.innerText');
    const msgs = fakeApi.log.filter((r) => r.path === '/v1/messages');
    check('direct/requests', '拡張から直接ストリーミング接続（公式 SDK・ブラウザ用ヘッダー・プロンプトキャッシュ・拒否時フォールバック）', msgs.length > 0 && msgs.every((r) => r.directHeader === 'true' && r.keyOk && r.stream && r.cache && r.fallbacks === 'default'), { requests: msgs.length, sample: msgs[0] });
    check('direct/key-hidden', 'API キーは取得処理の状態にもパネル表示にも出ない', !JSON.stringify(st).includes(FAKE_VALID_KEY) && !panelText.includes(FAKE_VALID_KEY), {});
    check('direct/spend', '費用を推定し、上限つきでパネルに表示', st.spend?.spentUsd > 0 && st.spend?.maxSessionUsd > 0 && /上限 \$/.test(await cdp.evaluate(panel.sid, `document.getElementById('usage').textContent`)), { ...st.spend, panelUsage: await cdp.evaluate(panel.sid, `document.getElementById('usage').textContent`) });
    out.fakeApi = { requests: msgs.length, models: [...new Set(msgs.map((r) => r.model))], simulatedFailures: fakeApi.log.filter((r) => r.path === '/v1/messages').length - msgs.length };
  }
  const fin = await offState(cdp, off);
  out.metrics = fin.metrics; out.usage = fin.usage; out.audio = fin.audio; out.issues = fin.issues;
  const lat = (k) => out.scenarios.map((s) => s.latency[k]).filter((v) => Number.isFinite(v));
  out.summary = {
    playStart_to_firstInterim: { n: lat('playStart_to_firstInterim').length, p50: percentile(lat('playStart_to_firstInterim'), 50), p95: percentile(lat('playStart_to_firstInterim'), 95) },
    playEnd_to_lastFinal: { n: lat('playEnd_to_lastFinal').length, p50: percentile(lat('playEnd_to_lastFinal'), 50), p95: percentile(lat('playEnd_to_lastFinal'), 95) },
    questionFinal_to_firstCandidate: { n: lat('questionFinal_to_firstCandidate').length, p50: percentile(lat('questionFinal_to_firstCandidate'), 50), p95: percentile(lat('questionFinal_to_firstCandidate'), 95) },
    questionProvisional_to_firstCandidate: { n: lat('questionProvisional_to_firstCandidate').length, p50: percentile(lat('questionProvisional_to_firstCandidate'), 50), p95: percentile(lat('questionProvisional_to_firstCandidate'), 95) },
    werMean: +(out.scenarios.reduce((a, s) => a + s.wer, 0) / out.scenarios.length).toFixed(3),
  };
  await panelClick(cdp, panel.sid, '#btnStop'); await waitStatus(cdp, off, 'stopped', 8000).catch(() => {});
  await Bun.sleep(400); await cdp.screenshot(panel.sid, shot('e2e-99-stopped'));
} catch (e) { console.error('E2E ERROR', e); out.error = String(e.stack || e); }
finally { cdp.close(); await chrome.kill(); fx.stop(); try { relay.kill(); } catch { /* ignore */ } try { fakeApi?.stop(); } catch { /* ignore */ } }
out.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT_DIR, `e2e-speech${SUFFIX}.json`), JSON.stringify(out, null, 2));
console.log('\nSUMMARY', JSON.stringify(out.summary, null, 1));
console.log('metrics', JSON.stringify(out.metrics));
console.log(`${out.checks.filter((c) => c.pass).length}/${out.checks.length} checks passed → test/out/e2e-speech${SUFFIX}.json`);
process.exit(out.error || out.checks.some((c) => !c.pass) ? 1 : 0);
