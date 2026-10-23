// Offscreen document: owns the capture session (audio graph, STT, metrics) and hosts the Pipeline.
import { DEFAULT_SETTINGS, describeDestinations } from './lib/constants.js';
import { Metrics } from './lib/metrics.js';
import { Pipeline } from './lib/pipeline.js';
import { RelayClient } from './lib/relay-client.js';
import { createWebSpeechStt } from './lib/providers/stt-webspeech.js';
import { createMockStt } from './lib/providers/stt-mock.js';
import { createChromeTranslator } from './lib/providers/translate-chrome.js';
import { createRelayTranslator } from './lib/providers/translate-relay.js';
import { createMockTranslator } from './lib/providers/translate-mock.js';
import { createRelayReply } from './lib/providers/reply-relay.js';
import { createMockReply } from './lib/providers/reply-mock.js';
import { createChromePromptReply } from './lib/providers/reply-chrome-prompt.js';
import { createDirectReply } from './lib/providers/reply-direct.js';
import { createDirectTranslator } from './lib/providers/translate-direct.js';
import { SpendGuard } from './lib/spend.js';

const now = () => performance.timeOrigin + performance.now();
let session = null;
let lastSnapshot = null; // final snapshot kept for the panel after stop (session memory itself is wiped)

function broadcast(state) { chrome.runtime.sendMessage({ target: 'panel', type: 'state', state }).catch(() => {}); }

class Session {
  constructor({ tabId, tabTitle, tabUrl, settings, profile, relayToken, anthropicKey }) {
    this.tabId = tabId; this.tabTitle = tabTitle || ''; this.tabUrl = tabUrl || '';
    this.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    this.relayToken = relayToken || '';
    this.apiKey = anthropicKey || ''; // memory only; never in snapshots or logs
    this.status = 'starting'; this.reason = ''; this.startedAt = now();
    this.metrics = new Metrics();
    this.issues = [];
    this.audio = { level: 0, speaking: false, trackState: 'none', ctxState: 'none', dropped: { count: 0, ms: 0 }, noiseFloor: 0.004 };
    this.mic = { enabled: false, state: 'off', stream: null, stt: null };
    this.providerStates = {};
    this.broadcastTimer = null;
    this.buildProviders();
    this.pipeline = new Pipeline({ settings: this.settings, profile, translator: this.translator, replier: this.replier, metrics: this.metrics, now, onChange: () => this.scheduleBroadcast(), onIssue: (i) => this.pushIssue(i.level, i.code, i.message) });
  }
  buildProviders() {
    const s = this.settings;
    this.relay = new RelayClient({ baseUrl: s.relayUrl, token: this.relayToken });
    this.guard = new SpendGuard({ maxSessionUsd: s.maxSessionUsd, maxReqPerMin: s.maxReqPerMin });
    const direct = { getKey: () => this.apiKey, model: s.replyModel, baseURL: s.anthropicBaseUrl || undefined, guard: this.guard };
    const onState = (info) => { this.providerStates[info.provider] = info; this.scheduleBroadcast(); };
    this.stt = s.sttProvider === 'mock'
      ? createMockStt({ onUpdate: (u) => this.onSttUpdate(u), onState })
      : createWebSpeechStt({ lang: s.sttLang, processLocally: s.sttProcessLocally, onUpdate: (u) => this.onSttUpdate(u), onState, onIssue: (i) => this.onSttIssue(i), onEvent: (e) => this.onSttEvent(e), now });
    this.translator = s.translateProvider === 'direct' ? createDirectTranslator({ ...direct, onState })
      : s.translateProvider === 'relay' ? createRelayTranslator({ client: this.relay, onState })
      : s.translateProvider === 'mock' ? createMockTranslator({})
      : createChromeTranslator({ onState });
    this.replier = s.replyProvider === 'mock' ? createMockReply({ delayMs: s.mockReplyDelayMs })
      : s.replyProvider === 'chrome-prompt' ? createChromePromptReply({ onState })
      : s.replyProvider === 'direct' ? createDirectReply({ ...direct, effort: s.replyEffort, onState })
      : createRelayReply({ client: this.relay, onState });
    if ((s.replyProvider === 'direct' || s.translateProvider === 'direct') && !this.apiKey) this.pushIssue('warn', 'no-key', 'API キーが未設定のため、返答候補は出ません。設定画面の「Anthropic API」でキーを入れてください（訳は使えます）。');
    if (s.translateProvider === 'chrome' && !this.translator.info().supported) this.pushIssue('error', 'translator-missing', 'Chrome Translator API がこの環境にありません。設定で翻訳を「ローカル中継」か「モック」にしてください。');
  }

  // ---------- lifecycle ----------
  async start(streamId) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
    this.track = this.stream.getAudioTracks()[0];
    this.audio.trackState = this.track.readyState;
    this.track.addEventListener('ended', () => this.onTrackEnded());
    this.track.addEventListener('mute', () => { this.audio.trackState = 'muted'; this.markDrop('音声トラックがミュートされました'); });
    this.track.addEventListener('unmute', () => { this.audio.trackState = 'live'; this.scheduleBroadcast(); });
    this.ctx = new AudioContext();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.2;
    this.source.connect(this.analyser);
    this.source.connect(this.ctx.destination); // keep the meeting audible for the user; the mic is never connected here
    this.passthroughConnected = true;
    try { await this.ctx.resume(); } catch { /* ignore */ }
    this.audio.ctxState = this.ctx.state;
    this.ctx.addEventListener('statechange', () => { this.audio.ctxState = this.ctx.state; if (this.ctx.state !== 'running' && this.status === 'capturing') this.markDrop(`AudioContext が ${this.ctx.state} になりました`); });
    this.timeData = new Float32Array(this.analyser.fftSize);
    this.freqData = new Float32Array(this.analyser.frequencyBinCount);
    this.levelTimer = setInterval(() => this.sampleLevel(), 50);
    this.tickTimer = setInterval(() => this.pipeline.tick(now()), 200);
    if (this.settings.translateProvider === 'chrome' && this.translator.info().supported) {
      this.translator.ensure().catch((e) => this.pushIssue('warn', 'translator-prepare', `翻訳モデルがまだ使えません（${e?.name || ''} ${e?.message || e}）。サイドパネルの「開始」でモデルを準備中なら、終わり次第自動で訳が出ます。`));
    }
    this.stt.start(this.track);
    this.status = 'capturing';
    this.broadcastNow();
  }
  pause() { if (this.status !== 'capturing') return; this.stt.stop(); this.status = 'paused'; this.pipeline.cancelAll(); this.broadcastNow(); }
  resume() { if (this.status !== 'paused') return; this.stt.start(this.track); this.status = 'capturing'; this.broadcastNow(); }
  onTrackEnded() { this.audio.trackState = 'ended'; if (this.status === 'capturing' || this.status === 'paused') { this.pushIssue('error', 'track-ended', '音声トラックが終了しました（タブ終了・権限取消・別の取得の開始）。取得を停止します。'); this.stop('track-ended'); } }
  async stop(reason = 'user') {
    if (this.status === 'stopped' || this.status === 'stopping') return;
    this.status = 'stopping'; this.reason = reason;
    try { this.stt.stop(); } catch { /* ignore */ }
    this.disableMic();
    clearInterval(this.levelTimer); clearInterval(this.tickTimer);
    this.pipeline.cancelAll();
    try { this.track?.stop(); } catch { /* ignore */ }
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { this.source?.disconnect(); } catch { /* ignore */ }
    this.passthroughConnected = false;
    try { await this.ctx?.close(); } catch { /* ignore */ }
    try { this.translator.destroy?.(); } catch { /* ignore */ }
    this.audio.trackState = 'ended'; this.audio.ctxState = 'closed'; this.audio.level = 0; this.audio.speaking = false;
    this.status = 'stopped';
    const finalSnap = this.snapshot(); finalSnap.ended = true;
    lastSnapshot = finalSnap;
    broadcast(finalSnap);
    if (!this.settings.persistSession) this.pipeline.wipe();
  }

  // ---------- audio level / VAD / drop detection ----------
  sampleLevel() {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.timeData);
    let sum = 0; for (let i = 0; i < this.timeData.length; i++) sum += this.timeData[i] * this.timeData[i];
    const rms = Math.sqrt(sum / this.timeData.length);
    this.audio.level = Math.min(1, rms * 8);
    const a = this.audio;
    if (rms < a.noiseFloor * 2) a.noiseFloor = a.noiseFloor * 0.98 + rms * 0.02;
    const threshold = Math.max(0.008, a.noiseFloor * 3.5);
    const t = now();
    if (rms > threshold) {
      this.lastLoudTs = t; this.pipeline.noteLoud(t);
      if (!a.speaking) { a.speaking = true; this.pipeline.speechStart(t); }
    } else if (a.speaking && t - (this.lastLoudTs || 0) > this.settings.silenceMs) {
      a.speaking = false; this.pipeline.speechEnd(t, this.lastLoudTs); this.scheduleBroadcast();
    }
  }
  markDrop(message) { this.audio.dropped.count++; this.pushIssue('warn', 'audio-drop', message); }
  audioStats() {
    if (!this.analyser || !this.ctx) return null;
    this.analyser.getFloatFrequencyData(this.freqData);
    let maxI = 1, maxV = -Infinity;
    for (let i = 1; i < this.freqData.length; i++) if (this.freqData[i] > maxV) { maxV = this.freqData[i]; maxI = i; }
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const peaks = [];
    for (let i = 2; i < this.freqData.length - 1; i++) if (this.freqData[i] > -70 && this.freqData[i] >= this.freqData[i - 1] && this.freqData[i] >= this.freqData[i + 1]) peaks.push({ hz: Math.round(i * binHz), db: Math.round(this.freqData[i]) });
    peaks.sort((x, y) => y.db - x.db);
    return { dominantHz: Math.round(maxI * binHz), dominantDb: Math.round(maxV), rms: this.audio.level / 8, peaks: peaks.slice(0, 6), sampleRate: this.ctx.sampleRate, ctxState: this.ctx.state, passthroughConnected: !!this.passthroughConnected, trackState: this.track?.readyState, trackLabel: this.track?.label, micActive: !!this.mic.stream };
  }

  // ---------- STT ----------
  onSttUpdate(u) { this.pipeline.feedStt(u); }
  onSttEvent(e) {
    const { type, ...rest } = e; this.pipeline.log(`stt-${type}`, { ev: type, ...rest });
    if (e.type === 'end' && this.audio.speaking && this.status === 'capturing') {
      this.audio.dropped.count++;
      const t = now();
      if (!this.lastRestartWarn || t - this.lastRestartWarn > 30000) { this.lastRestartWarn = t; this.pushIssue('warn', 'stt-restart-while-speaking', '話の途中で音声認識が区切り直しました（途切れない音声では約1分ごとに起きます）。前後の数語を取りこぼした可能性があります。'); }
    }
  }
  onSttIssue(i) { this.pushIssue(i.level, i.code, i.message); if (i.gapMs) { this.audio.dropped.count++; this.audio.dropped.ms += i.gapMs; } }

  // ---------- optional own microphone ----------
  async enableMic() {
    if (this.mic.stream) return { ok: true };
    try { this.mic.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
    catch (e) { this.mic.state = 'denied'; this.pushIssue('warn', 'mic-denied', `マイクを取得できません (${e?.name || e})。先に「マイク許可」ページで許可してください。`); return { ok: false, code: 'mic-denied' }; }
    this.mic.enabled = true; this.mic.state = 'on';
    this.mic.stt = createWebSpeechStt({ lang: this.settings.sttLang, processLocally: this.settings.sttProcessLocally, label: 'me-mic', onUpdate: (u) => this.onSttUpdate(u), onState: () => this.scheduleBroadcast(), onIssue: (i) => this.pushIssue(i.level, `mic-${i.code}`, `(自分のマイク) ${i.message}`), now });
    this.mic.stt.start(this.mic.stream.getAudioTracks()[0]);
    this.scheduleBroadcast();
    return { ok: true };
  }
  disableMic() {
    try { this.mic.stt?.stop(); } catch { /* ignore */ }
    try { this.mic.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    this.mic = { enabled: false, state: 'off', stream: null, stt: null };
    this.scheduleBroadcast();
  }

  // ---------- misc ----------
  pushIssue(level, code, message) { this.issues.push({ ts: now(), level, code, message }); if (this.issues.length > 60) this.issues.shift(); this.scheduleBroadcast(); }
  updateConfig({ settings, profile, relayToken, anthropicKey }) {
    if (profile !== undefined) this.pipeline.setProfile(profile);
    if (relayToken !== undefined) { this.relayToken = relayToken; this.relay.token = relayToken; }
    if (anthropicKey !== undefined) this.apiKey = anthropicKey;
    if (settings) this.guard.setLimits({ maxSessionUsd: settings.maxSessionUsd, maxReqPerMin: settings.maxReqPerMin });
    if (settings) { this.settings = { ...DEFAULT_SETTINGS, ...settings }; this.pushIssue('info', 'settings', '設定を変更しました。提供元の変更は次回の開始から有効です。'); }
    this.scheduleBroadcast();
  }
  scheduleBroadcast() { if (this.broadcastTimer) return; this.broadcastTimer = setTimeout(() => { this.broadcastTimer = null; this.broadcastNow(); }, 80); }
  broadcastNow() { if (this.status === 'stopped') return; broadcast(this.snapshot()); }
  snapshot() {
    return {
      status: this.status, reason: this.reason, tabId: this.tabId, tabTitle: this.tabTitle, tabUrl: this.tabUrl, startedAt: this.startedAt, now: now(),
      audio: { level: this.audio.level, speaking: this.audio.speaking, trackState: this.audio.trackState, ctxState: this.audio.ctxState, dropped: { ...this.audio.dropped } },
      providers: { stt: this.stt.info(), translate: this.translator.info(), reply: this.replier.info(), states: this.providerStates },
      destinations: describeDestinations(this.settings),
      ...this.pipeline.snapshot(),
      metrics: this.metrics.snapshot(), issues: this.issues.slice(-20),
      mic: { enabled: this.mic.enabled, state: this.mic.state },
      settings: { sttProvider: this.settings.sttProvider, translateProvider: this.settings.translateProvider, replyProvider: this.settings.replyProvider, replyModel: this.settings.replyModel, persistSession: this.settings.persistSession },
      spend: this.guard.snapshot(),
    };
  }
}

async function handle(msg) {
  switch (msg.type) {
    case 'start-capture': {
      if (session && session.status !== 'stopped') await session.stop('restart');
      session = new Session(msg);
      try { await session.start(msg.streamId); } catch (e) { session.pushIssue('error', 'start-failed', `音声取得に失敗: ${e?.message || e}`); await session.stop('start-failed'); return { ok: false, error: String(e?.message || e) }; }
      return { ok: true };
    }
    case 'stop': if (session) await session.stop(msg.reason || 'user'); return { ok: true };
    case 'pause': session?.pause(); return { ok: true };
    case 'resume': session?.resume(); return { ok: true };
    case 'get-state': return { ok: true, state: session && session.status !== 'stopped' ? session.snapshot() : lastSnapshot };
    case 'clear-ended': lastSnapshot = null; return { ok: true };
    case 'pin': return { ok: !!(msg.itemId ? session?.pipeline.pin(msg.itemId) : msg.text && session?.pipeline.pinText(msg.text)) };
    case 'unpin': session?.pipeline.unpin(msg.pinId); return { ok: true };
    case 'spoken': return { ok: !!session?.pipeline.markSpoken(msg.itemId, msg.text) };
    case 'refine': session?.pipeline.refineText(msg.text); return { ok: true };
    case 'mic-enable': return session ? session.enableMic() : { ok: false, code: 'no-session' };
    case 'mic-disable': session?.disableMic(); return { ok: true };
    case 'config-updated': session?.updateConfig(msg); return { ok: true };
    case 'capture-status': if (session && msg.info?.tabId === session.tabId && (msg.info.status === 'stopped' || msg.info.status === 'error') && session.status === 'capturing') session.pushIssue('warn', 'capture-status', `タブ取得の状態が ${msg.info.status} になりました`); return { ok: true };
    case 'mock-stt': if (session?.stt?.inject) { session.stt.inject(msg.events || []); return { ok: true }; } return { ok: false, error: 'mock STT is not active' };
    default: return { ok: false, error: `unknown offscreen message ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return undefined;
  handle(msg).then((r) => sendResponse(r ?? { ok: true }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// Harness hooks (reachable only through DevTools / CDP).
globalThis.__aizuchi = {
  getState: () => (session ? session.snapshot() : lastSnapshot),
  audioStats: () => session?.audioStats() || null,
  micActive: () => !!session?.mic?.stream,
  status: () => session?.status || 'idle',
  injectStt: (events) => session?.stt?.inject?.(events),
  metricsEvents: () => session?.metrics?.events || [],
  trace: () => session?.pipeline?.trace || [],
  features: () => ({ speechRecognition: !!(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition), speechAvailable: typeof (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition)?.available === 'function', translator: typeof globalThis.Translator !== 'undefined', languageModel: typeof globalThis.LanguageModel !== 'undefined', userAgent: navigator.userAgent }),
};
