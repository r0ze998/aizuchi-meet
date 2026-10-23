// Shared constants for the extension and the relay.
export const RELAY_DEFAULT_URL = 'http://127.0.0.1:47231';

export const DEFAULT_SETTINGS = Object.freeze({
  relayUrl: RELAY_DEFAULT_URL,
  sttProvider: 'webspeech',      // webspeech | mock
  sttLang: 'en-US',
  sttProcessLocally: false,      // Web Speech on-device mode (needs a language pack)
  translateProvider: 'chrome',   // chrome | direct | relay | mock
  replyProvider: 'direct',       // direct | relay | chrome-prompt | mock
  replyModel: 'claude-opus-5-5', // direct: claude-opus-5-5 | claude-sonnet-5-5 | claude-haiku-5-5
  replyEffort: 'low',
  maxSessionUsd: 1.0,            // direct: cost cap per meeting (estimated from API usage)
  maxReqPerMin: 30,
  anthropicBaseUrl: '',          // tests only (points the SDK at a local fake API)
  stableMs: 700,                 // interim text unchanged for this long => "partial stable"
  translateDebounceMs: 350,
  silenceMs: 900,                // energy below threshold for this long => speech ended
  turnEndMs: 1500,               // no STT activity for this long => turn closed
  provisionalMinWords: 5,
  maxCandidateSets: 6,
  maxTranscript: 80,
  maxQueue: 24,
  persistSession: false,         // keep transcript after stop (explicit opt-in)
  ownMic: false,                 // separate optional microphone input
  mockReplyDelayMs: 250,
});

export const STORAGE_KEYS = Object.freeze({
  settings: 'settings',
  profile: 'profile',
  relayToken: 'relayToken',
  anthropicKey: 'anthropicKey',
});

// Human-readable description of where data goes for a given configuration.
export function describeDestinations(settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const out = [];
  if (s.sttProvider === 'webspeech') {
    out.push(s.sttProcessLocally
      ? { stage: '音声認識', label: '端末内 (Chrome オンデバイス)', external: false }
      : { stage: '音声認識', label: 'Google 音声認識サーバー (Chrome Web Speech API)', external: true, who: 'Google' });
  } else {
    out.push({ stage: '音声認識', label: 'モック (送信なし)', external: false });
  }
  if (s.translateProvider === 'chrome') out.push({ stage: '日本語訳', label: '端末内 (Chrome Translator API)', external: false });
  else if (s.translateProvider === 'direct') out.push({ stage: '日本語訳', label: `Anthropic に直接 (${s.replyModel})`, external: true, who: 'Anthropic' });
  else if (s.translateProvider === 'relay') out.push({ stage: '日本語訳', label: `ローカル中継 (${s.relayUrl}) → Anthropic`, external: true, who: 'Anthropic' });
  else out.push({ stage: '日本語訳', label: 'モック (送信なし)', external: false });
  if (s.replyProvider === 'direct') out.push({ stage: '返答候補', label: `Anthropic に直接 (${s.replyModel})`, external: true, who: 'Anthropic' });
  else if (s.replyProvider === 'relay') out.push({ stage: '返答候補', label: `ローカル中継 (${s.relayUrl}) → Anthropic`, external: true, who: 'Anthropic' });
  else if (s.replyProvider === 'chrome-prompt') out.push({ stage: '返答候補', label: '端末内 (Chrome Prompt API / Gemini Nano)', external: false });
  else out.push({ stage: '返答候補', label: 'モック (送信なし)', external: false });
  return out;
}
