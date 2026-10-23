// Reply candidates through the local relay (which holds the API key and talks to Claude).
import { isAbort } from '../scheduler.js';

export function createRelayReply({ client, onState = () => {} } = {}) {
  let state = 'idle';
  return {
    info() { return { name: 'relay', label: '候補: ローカル中継 → Anthropic', external: true, supported: true, state }; },
    async generate(payload, { signal, onSummary = () => {}, onCandidate = () => {}, onDone = () => {}, onError = () => {} } = {}) {
      state = 'busy'; onState({ provider: 'relay', state });
      try {
        for await (const ev of client.reply(payload, { signal })) {
          if (ev.event === 'summary') onSummary(ev.data?.summary_ja || '');
          else if (ev.event === 'candidate') onCandidate(ev.data?.index, ev.data?.candidate || {}, { partial: !!ev.data?.partial });
          else if (ev.event === 'done') { onDone(ev.data || {}); }
          else if (ev.event === 'error') { onError(ev.data || { message: 'relay error' }); }
        }
        state = 'ready';
      } catch (e) {
        state = isAbort(e) ? 'ready' : 'error';
        if (!isAbort(e)) onError({ code: e?.code || 'error', message: e?.message || String(e) });
        else throw e;
      } finally { onState({ provider: 'relay', state }); }
    },
  };
}
