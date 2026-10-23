// Speech-to-text via Chrome's Web Speech API fed with a MediaStreamTrack (tab audio).
// Default mode sends audio to Google's speech servers; processLocally keeps it on device (language pack required).
export function createWebSpeechStt({ lang = 'en-US', processLocally = false, label = 'peer', onUpdate = () => {}, onState = () => {}, onIssue = () => {}, onEvent = () => {}, now = () => Date.now() } = {}) {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  let rec = null, track = null, running = false, restartTimer = null, lastEndTs = 0, networkErrors = 0, state = 'idle', startedTs = 0, gotResultSince = false, pendingInterim = '', sessions = 0;

  function setState(s, detail) { state = s; onState({ provider: 'webspeech', label, state: s, detail }); }

  function build() {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.maxAlternatives = 1;
    if (processLocally) { try { r.processLocally = true; } catch { /* older Chrome */ } }
    r.onstart = () => {
      const ts = now();
      if (lastEndTs && ts - lastEndTs > 600) onIssue({ level: 'warn', code: 'stt-gap', message: `認識の再開に ${ts - lastEndTs} ms かかりました（この間の音声は取りこぼした可能性があります）`, gapMs: ts - lastEndTs });
      startedTs = ts; gotResultSince = false; pendingInterim = ''; sessions++; onEvent({ type: 'start', ts, session: sessions }); setState('listening');
    };
    r.onresult = (e) => {
      const finals = []; let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res[0]?.transcript || '';
        if (res.isFinal) finals.push(t); else interim += t;
      }
      gotResultSince = true; networkErrors = 0;
      pendingInterim = finals.length ? '' : interim;
      onEvent({ type: 'result', ts: now(), resultIndex: e.resultIndex, results: e.results.length, finals: finals.length, interimLen: interim.length });
      onUpdate({ finals, interim, ts: now(), label });
    };
    r.onerror = (e) => {
      const err = e.error;
      onEvent({ type: 'error', ts: now(), error: err });
      if (err === 'no-speech') return; // benign; onend will restart
      if (err === 'aborted') return;
      if (err === 'network') {
        networkErrors++;
        onIssue({ level: networkErrors >= 3 ? 'error' : 'warn', code: 'stt-network', message: `音声認識のネットワークエラー (${networkErrors}回目)` });
        if (networkErrors >= 5) { running = false; setState('error', 'network'); }
        return;
      }
      if (err === 'not-allowed' || err === 'service-not-allowed') { running = false; setState('error', err); onIssue({ level: 'error', code: 'stt-denied', message: `音声認識が許可されていません (${err})` }); return; }
      if (err === 'language-not-supported') { running = false; setState('error', err); onIssue({ level: 'error', code: 'stt-lang', message: processLocally ? 'オンデバイス認識の言語パックがありません。設定画面で準備するか、オンデバイスをオフにしてください。' : `言語 ${lang} が未対応です` }); return; }
      if (err === 'audio-capture') { onIssue({ level: 'error', code: 'stt-audio', message: '認識器が音声を取得できません' }); return; }
      onIssue({ level: 'warn', code: 'stt-error', message: `音声認識エラー: ${err}` });
    };
    r.onend = () => {
      lastEndTs = now();
      onEvent({ type: 'end', ts: lastEndTs, pendingInterimLen: pendingInterim.length, running });
      if (pendingInterim) {
        // The recogniser ended without finalising what it had heard: surface it instead of dropping it silently.
        const text = pendingInterim; pendingInterim = '';
        onUpdate({ finals: [text], interim: '', ts: lastEndTs, label, unconfirmed: true });
        onIssue({ level: 'warn', code: 'stt-unconfirmed', message: `認識が途中で終了したため、未確定のまま表示しました: "${text.slice(0, 40)}…"` });
      }
      if (!running) { setState('stopped'); return; }
      const delay = networkErrors ? Math.min(4000, 300 * 2 ** networkErrors) : 0;
      setState('restarting');
      restartTimer = setTimeout(() => { restartTimer = null; if (running) startRec(); }, delay);
    };
    return r;
  }

  function startRec() {
    try {
      rec = build();
      if (track) rec.start(track); else rec.start();
    } catch (e) {
      running = false; setState('error', String(e?.message || e));
      onIssue({ level: 'error', code: 'stt-start', message: `音声認識を開始できません: ${e?.message || e}` });
    }
  }

  return {
    info() { return { name: 'webspeech', label: processLocally ? 'Chrome 音声認識 (端末内)' : 'Chrome 音声認識 (Google サーバー)', external: !processLocally, supported: !!SR, state }; },
    start(t) {
      if (!SR) { setState('error', 'unsupported'); onIssue({ level: 'error', code: 'stt-unsupported', message: 'この環境では Web Speech API が使えません' }); return; }
      track = t || null; running = true; networkErrors = 0; lastEndTs = 0;
      startRec();
    },
    stop() {
      running = false;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      try { rec?.abort(); } catch { /* ignore */ }
      rec = null; setState('stopped');
    },
    get state() { return state; },
  };
}

export async function webSpeechLocalAvailability(lang = 'en-US') {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!SR || typeof SR.available !== 'function') return 'unsupported';
  try { return await SR.available({ langs: [lang], processLocally: true }); } catch { return 'unsupported'; }
}
export async function webSpeechLocalInstall(lang = 'en-US') {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!SR || typeof SR.install !== 'function') return false;
  return SR.install({ langs: [lang], processLocally: true });
}
