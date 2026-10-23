// Probe Chrome built-in AI APIs in the extension context, one call at a time with its own timeout.
import { launchChrome } from './chrome.mjs';
import { connect, pageSession, extUrl } from './common.mjs';
const chrome = await launchChrome({ port: 9336, allowlist: true, url: 'about:blank' });
const cdp = await connect(chrome);
const race = (expr, ms = 8000) => `Promise.race([(async () => (${expr}))(), new Promise((_, r) => setTimeout(() => r(new Error('timeout ${ms}ms')), ${ms}))]).then(v => ({ ok: true, v }), e => ({ ok: false, e: e.name + ': ' + e.message }))`;
try {
  const opt = await pageSession(cdp, extUrl('options.html'), { width: 900, height: 900 });
  await Bun.sleep(600);
  const calls = {
    translatorSupported: `typeof Translator !== 'undefined'`,
    translatorAvailability: `Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ja' })`,
    speechAvailableFn: `typeof (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition)?.available === 'function'`,
    speechLocal: `(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition).available({ langs: ['en-US'], processLocally: true })`,
    speechServer: `(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition).available({ langs: ['en-US'], processLocally: false })`,
    languageModelSupported: `typeof LanguageModel !== 'undefined'`,
    languageModelAvailability: `LanguageModel.availability({ expectedOutputs: [{ type: 'text', languages: ['ja', 'en'] }] })`,
  };
  const res = {};
  for (const [k, expr] of Object.entries(calls)) { res[k] = await cdp.evaluate(opt.sid, race(expr), { timeout: 12000 }).catch((e) => ({ ok: false, e: 'cdp ' + e.message })); console.log(k, JSON.stringify(res[k])); }
  const create = `(async () => {
    const log = []; const t0 = Date.now();
    try {
      const tr = await Promise.race([
        Translator.create({ sourceLanguage: 'en', targetLanguage: 'ja', monitor(m) { m.addEventListener('downloadprogress', (e) => log.push([Date.now() - t0, +e.loaded.toFixed(3)])); } }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('create timeout 75s')), 75000)),
      ]);
      const s = await tr.translate('Which chain are you on, and why did you choose it over the alternatives?');
      return { ok: true, ms: Date.now() - t0, sample: s, log: log.slice(0, 4).concat(log.slice(-3)) };
    } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.name + ': ' + e.message, log: log.slice(-5) }; }
  })()`;
  console.log('translator.create', JSON.stringify(await cdp.evaluate(opt.sid, create, { userGesture: true, timeout: 80000 }).catch((e) => ({ cdp: e.message }))));
  console.log('availability after', JSON.stringify(await cdp.evaluate(opt.sid, race(calls.translatorAvailability), { timeout: 12000 }).catch((e) => e.message)));
  console.log('chrome stderr tail:', chrome.logs.join('').split('\n').filter((l) => /translat|optimization|component|model/i.test(l)).slice(-8).join('\n'));
} catch (e) { console.error('PROBE ERROR', e); }
finally { cdp.close(); await chrome.kill(); }
