// Technical verification of tab capture in a dedicated Chrome for Testing profile (run: bun test/harness/verify-capture.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, OUT_DIR, SHOT_DIR, EXT_ID } from './chrome.mjs';
import { startFixtures } from './fixtures-server.mjs';
import { connect, swSession, offscreenSession, pageSession, setSettings, activeTabId, setInvokedTab, capturedTabs, panelStart, panelClick, offState, offStatus, audioStats, waitStatus, extUrl, panelNotice, pressShortcutViaOsascript } from './common.mjs';
import { waitFor } from './cdp.mjs';

fs.mkdirSync(OUT_DIR, { recursive: true }); fs.mkdirSync(SHOT_DIR, { recursive: true });
const results = [];
const check = (id, name, pass, detail) => { results.push({ id, name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} ${detail ? JSON.stringify(detail).slice(0, 260) : ''}`); };
const note = (id, name, detail) => { results.push({ id, name, pass: null, detail }); console.log(`NOTE ${id} ${name} ${JSON.stringify(detail).slice(0, 260)}`); };
const near = (a, b, tol = 12) => Math.abs(a - b) <= tol;

const fx = startFixtures(0);
const report = { startedAt: new Date().toISOString(), browser: null, extensionId: EXT_ID, phases: {} };

// ---------- Phase A: allowlisted (test-only bypass of the "extension invoked" gate) ----------
async function phaseA() {
  const chrome = await launchChrome({ port: 9333, allowlist: true, url: `${fx.url}/tone-a.html` });
  report.browser = chrome.browser;
  console.log('browser', chrome.browser, 'allowlist=on');
  const cdp = await connect(chrome);
  try {
    const tabA = await cdp.waitForTarget((t) => t.type === 'page' && t.url.endsWith('/tone-a.html'), 10000, 'tone-a');
    const a = await cdp.attach(tabA.targetId);
    const tabBId = await cdp.openTab(`${fx.url}/tone-b.html`, { background: true });
    const b = await cdp.attach(tabBId);
    await cdp.activate(tabA.targetId);
    const sw = await swSession(cdp);
    await setSettings(cdp, sw, { sttProvider: 'webspeech', translateProvider: 'mock', replyProvider: 'mock' });
    await cdp.activate(tabA.targetId); await Bun.sleep(400);
    const aId = await activeTabId(cdp, sw);
    await setInvokedTab(cdp, sw, aId, 'Tone A (capture target)');
    const toneA = await cdp.evaluate(a, 'startTone(440)', { userGesture: true });
    note('A0', '対象タブでトーン再生開始', { toneA, tabId: aId });
    const panel = await pageSession(cdp, extUrl('sidepanel.html'), { width: 420, height: 900 });
    await Bun.sleep(600);
    const startRes = await panelStart(cdp, panel.sid);
    note('A0b', 'パネルの開始操作（同意画面経由）', startRes);
    const off = await offscreenSession(cdp, 15000);
    const features = await cdp.evaluate(off, 'globalThis.__aizuchi.features()');
    note('F', 'offscreen で使える API', features);
    try { await waitStatus(cdp, off, 'capturing', 15000); }
    catch (e) { const n = await panelNotice(cdp, panel.sid); check('C1', 'Meet(対象)タブの音声を取得できる', false, { error: String(e.message), panelNotice: n, state: await offState(cdp, off) }); return; }
    await Bun.sleep(1800);
    const st1 = await audioStats(cdp, off); const cap1 = await capturedTabs(cdp, sw);
    check('C1', '対象タブの音声を取得できる (440Hz トーンを offscreen で検出)', near(st1.dominantHz, 440) && st1.rms > 0.003 && cap1.some((c) => c.tabId === aId && c.status === 'active'), { dominantHz: st1.dominantHz, dominantDb: st1.dominantDb, rms: +st1.rms.toFixed(4), captured: cap1, trackLabel: st1.trackLabel });
    const s1 = await offState(cdp, off);
    const sttState = s1.providers.states?.webspeech?.state; const sttIssues = s1.issues.filter((i) => /stt/.test(i.code)).map((i) => `${i.code}:${i.message}`);
    check('C1b', 'Web Speech API が tab 音声トラック入力で起動 (マイク要求なし)', ['listening', 'restarting'].includes(sttState) && !sttIssues.some((i) => /stt-start|stt-denied|stt-unsupported/.test(i)), { sttState, sttIssues });
    const toneAState = await cdp.evaluate(a, 'toneState()');
    check('C2', '元のタブ音声を再生し続ける経路 (取得ストリーム→AudioContext.destination) が有効', st1.passthroughConnected && st1.ctxState === 'running' && toneAState.ctx === 'running', { passthrough: st1.passthroughConnected, offscreenCtx: st1.ctxState, tabCtx: toneAState.ctx, note: 'スピーカー出力の聴感は自動計測不可。実通話で要確認' });
    await cdp.evaluate(b, 'startTone(880, 0.7)', { userGesture: true });
    await Bun.sleep(1800);
    const st3 = await audioStats(cdp, off);
    const peak880 = st3.peaks.find((p) => near(p.hz, 880));
    check('C3', '別タブ (880Hz) の音声が混ざらない', near(st3.dominantHz, 440) && (!peak880 || peak880.db < st3.dominantDb - 30), { dominantHz: st3.dominantHz, dominantDb: st3.dominantDb, peak880: peak880 || null, peaks: st3.peaks });
    await cdp.evaluate(a, 'startTone(523)', { userGesture: true }); await Bun.sleep(1500);
    const st3b = await audioStats(cdp, off);
    check('C3b', '取得音声は対象タブに追従する (440→523Hz)', near(st3b.dominantHz, 523), { dominantHz: st3b.dominantHz });
    await cdp.evaluate(b, 'stopTone()');
    const mic = await cdp.evaluate(off, 'globalThis.__aizuchi.micActive()');
    check('C4', '任意マイクを有効にしない限り自分のマイクを取得しない', mic === false && s1.mic.enabled === false && !/mic|マイク/i.test(st1.trackLabel || ''), { micActive: mic, micState: s1.mic, trackLabel: st1.trackLabel });
    await cdp.screenshot(panel.sid, path.join(SHOT_DIR, 'capture-verify-panel-capturing.png'));
    // pause / resume
    await panelClick(cdp, panel.sid, '#btnPause'); await waitStatus(cdp, off, 'paused', 5000);
    const stP = await audioStats(cdp, off);
    await panelClick(cdp, panel.sid, '#btnResume'); await waitStatus(cdp, off, 'capturing', 5000);
    check('C8', '一時停止中も会議音声の再生経路は維持され、再開できる', stP.passthroughConnected && stP.ctxState === 'running', { pausedPassthrough: stP.passthroughConnected, ctx: stP.ctxState });
    // stop
    await panelClick(cdp, panel.sid, '#btnStop');
    await waitStatus(cdp, off, 'stopped', 10000); await Bun.sleep(600);
    const cap5 = await capturedTabs(cdp, sw); const s5 = await offState(cdp, off); const toneAfter = await cdp.evaluate(a, 'toneState()');
    check('C5', '停止すると取得が止まる (トラック終了・capture 状態解除)、タブ側の再生は継続', !cap5.some((c) => c.tabId === aId && c.status === 'active') && s5.audio.trackState === 'ended' && s5.audio.ctxState === 'closed' && toneAfter.ctx === 'running', { captured: cap5, trackState: s5.audio.trackState, ctxState: s5.audio.ctxState, tabStillPlaying: toneAfter, wiped: s5.transcript.length === 0 });
    let okRepeat = true; const repeatDetail = [];
    for (let i = 0; i < 3; i++) {
      await panelStart(cdp, panel.sid);
      try { await waitStatus(cdp, off, 'capturing', 10000); } catch (e) { okRepeat = false; repeatDetail.push(`start#${i}: ${e.message.slice(0, 120)}`); break; }
      await Bun.sleep(900);
      const st = await audioStats(cdp, off); repeatDetail.push({ i, hz: st.dominantHz });
      await panelClick(cdp, panel.sid, '#btnStop');
      try { await waitStatus(cdp, off, 'stopped', 10000); } catch (e) { okRepeat = false; repeatDetail.push(`stop#${i}: ${e.message.slice(0, 120)}`); break; }
      await Bun.sleep(300);
    }
    check('C6', '開始／停止を 3 回繰り返せる', okRepeat && repeatDetail.filter((d) => typeof d === 'object').every((d) => near(d.hz, 523)), { repeatDetail });
    await panelStart(cdp, panel.sid); await waitStatus(cdp, off, 'capturing', 10000); await Bun.sleep(600);
    await cdp.closeTab(tabA.targetId);
    let s7 = null;
    try { await waitStatus(cdp, off, 'stopped', 8000); s7 = await offState(cdp, off); } catch (e) { s7 = { error: e.message }; }
    check('C7', '対象タブを閉じると取得が止まる', s7 && ['tab-closed', 'track-ended'].includes(s7.reason), { reason: s7?.reason, issues: s7?.issues?.slice(-3).map((i) => i.code), error: s7?.error });
    await Bun.sleep(300);
    await cdp.screenshot(panel.sid, path.join(SHOT_DIR, 'capture-verify-panel-stopped.png'));
    report.phases.A = { ok: true };
  } catch (e) {
    console.error('PHASE A ERROR', e); results.push({ id: 'A-ERR', name: 'harness error (phase A)', pass: false, detail: String(e.stack || e) });
  } finally { cdp.close(); await chrome.kill(); }
}

// ---------- Phase B: real invocation path (no allowlist): the gate must block until the user invokes the extension ----------
async function phaseB() {
  const chrome = await launchChrome({ port: 9334, allowlist: false, url: `${fx.url}/tone-a.html` });
  console.log('browser', chrome.browser, 'allowlist=off');
  const cdp = await connect(chrome);
  try {
    const tabA = await cdp.waitForTarget((t) => t.type === 'page' && t.url.endsWith('/tone-a.html'), 10000, 'tone-a');
    const a = await cdp.attach(tabA.targetId);
    await cdp.activate(tabA.targetId);
    const sw = await swSession(cdp);
    await setSettings(cdp, sw, { sttProvider: 'webspeech', translateProvider: 'mock', replyProvider: 'mock' });
    await cdp.activate(tabA.targetId); await Bun.sleep(400);
    const aId = await activeTabId(cdp, sw);
    await cdp.evaluate(a, 'startTone(440)', { userGesture: true });
    // B1: without invocation, capture must be refused
    const r1 = await cdp.evaluate(sw, `globalThis.__aizuchiDebug.startCapture(${aId})`);
    check('B1', '呼び出し前は getMediaStreamId が拒否される (activeTab 型のゲート)', r1 && r1.ok === false && r1.code === 'needs-invoke', r1);
    // B2: invoke through the real keyboard command. Try CDP key events first, then osascript; then capture must work
    const getInv = () => cdp.evaluate(sw, `chrome.storage.session.get('invokedTab').then(r => r.invokedTab || null)`);
    const mods = 4 | 8; // Meta | Shift
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, modifiers: mods, key: 'y', code: 'KeyY', windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89, commands: [] }, a).catch(() => {});
    await Bun.sleep(1000);
    let inv = await getInv(); let via = inv ? 'cdp-key' : null; let key = null;
    if (!inv) { key = pressShortcutViaOsascript('Google Chrome for Testing'); await Bun.sleep(1200); inv = await getInv(); if (inv) via = 'osascript'; }
    if (!inv) { note('B2', '実経路 (ショートカット ⌘⇧Y → action.onClicked) は自動で再現できず未検証', { cdpKey: 'no effect', osascript: key, invokedTab: inv, manual: 'Meet タブでアイコンをクリック → パネルの開始 を手動で確認してください' }); return; }
    note('B2a', '拡張の呼び出し経路', { via, invokedTab: inv });
    const r2 = await cdp.evaluate(sw, `globalThis.__aizuchiDebug.startCapture(${inv.tabId})`);
    const off = await offscreenSession(cdp, 15000);
    let ok = false, st = null;
    try { await waitStatus(cdp, off, 'capturing', 15000); await Bun.sleep(1500); st = await audioStats(cdp, off); ok = near(st.dominantHz, 440); } catch (e) { st = { error: e.message }; }
    check('B2', '実経路: ショートカットで拡張を呼び出した後は対象タブを取得できる (サイドパネルも開く)', r2?.ok && ok, { startResult: r2, invokedTab: inv, dominantHz: st?.dominantHz, error: st?.error });
    const sidePanelTarget = (await cdp.targets()).find((t) => t.url === extUrl('sidepanel.html'));
    note('B3', '実サイドパネルが開いたか (CDP ターゲットに sidepanel.html が存在)', { opened: !!sidePanelTarget, type: sidePanelTarget?.type });
    if (sidePanelTarget) { try { const sid = await cdp.attach(sidePanelTarget.targetId); await Bun.sleep(800); await cdp.screenshot(sid, path.join(SHOT_DIR, 'capture-verify-real-sidepanel.png')); } catch (e) { note('B3b', 'サイドパネルのスクリーンショット失敗', String(e.message)); } }
    await cdp.evaluate(sw, `chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop', reason: 'user' })`);
    await waitStatus(cdp, off, 'stopped', 8000).catch(() => {});
    report.phases.B = { ok: true };
  } catch (e) {
    console.error('PHASE B ERROR', e); results.push({ id: 'B-ERR', name: 'harness error (phase B)', pass: false, detail: String(e.stack || e) });
  } finally { cdp.close(); await chrome.kill(); }
}

const only = (process.argv.find((x) => x.startsWith('--phase=')) || '').slice(8).toUpperCase();
try { if (!only || only === 'A') await phaseA(); if (!only || only === 'B') await phaseB(); } finally { fx.stop(); }
report.finishedAt = new Date().toISOString();
report.results = results;
const suffix = only ? `-${only}` : '';
fs.writeFileSync(path.join(OUT_DIR, `capture-verify${suffix}.json`), JSON.stringify(report, null, 2));
const md = ['# tabCapture 検証結果 (自動)', '', `- 実行: ${report.startedAt}`, `- ブラウザ: ${report.browser}（Chrome for Testing。ブランド版 Chrome は \`--load-extension\` を無視するため）`, `- 拡張 ID: ${EXT_ID}`, '', '| ID | 検証項目 | 結果 | 詳細 |', '|---|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.name} | ${r.pass === null ? 'メモ' : r.pass ? 'PASS' : 'FAIL'} | ${JSON.stringify(r.detail).replace(/\|/g, '\\|').slice(0, 400)} |`)].join('\n');
fs.writeFileSync(path.join(OUT_DIR, `capture-verify${suffix}.md`), md);
const fails = results.filter((r) => r.pass === false).length;
console.log(`\n${results.filter((r) => r.pass === true).length} passed, ${fails} failed, ${results.filter((r) => r.pass === null).length} notes → test/out/capture-verify${suffix}.{json,md}`);
process.exit(fails ? 1 : 0);
