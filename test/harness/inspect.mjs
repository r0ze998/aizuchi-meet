// Inspect a running harness browser: bun test/harness/inspect.mjs 9335
import { CDP } from './cdp.mjs';
import { EXT_ID } from './chrome.mjs';
const port = process.argv[2] || '9335';
const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const cdp = await CDP.connect(v.webSocketDebuggerUrl);
const targets = await cdp.targets();
console.log(targets.map((t) => `${t.type} ${t.url}`).join('\n'));
const off = targets.find((t) => t.url === `chrome-extension://${EXT_ID}/offscreen.html`);
if (off) {
  const sid = await cdp.attach(off.targetId);
  const st = await cdp.evaluate(sid, `(() => { const s = globalThis.__aizuchi.getState(); return s && { status: s.status, transcript: s.transcript.length, sets: s.candidateSets.length, issues: s.issues.slice(-5), providers: s.providers.states, translate: s.providers.translate, audio: s.audio, metrics: s.metrics }; })()`);
  console.log('OFFSCREEN', JSON.stringify(st, null, 1));
  const tr = await cdp.evaluate(sid, `globalThis.__aizuchi.trace().slice(-8)`);
  console.log('TRACE tail', JSON.stringify(tr));
}
const pl = targets.find((t) => t.url.includes('speech-player'));
if (pl) { const sid = await cdp.attach(pl.targetId); console.log('PLAYER', JSON.stringify(await cdp.evaluate(sid, 'playerState()')), (await cdp.evaluate(sid, 'document.getElementById("log").textContent')).slice(-400)); }
const opt = targets.find((t) => t.url.includes('options.html'));
if (opt) { const sid = await cdp.attach(opt.targetId); console.log('OPTIONS translator:', await cdp.evaluate(sid, `Translator.availability({sourceLanguage:'en',targetLanguage:'ja'})`), 'stt local:', await cdp.evaluate(sid, `(globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition).available({langs:['en-US'],processLocally:true})`)); }
cdp.close();
