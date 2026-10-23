// Scripted recogniser for tests/demos. events: [{at: ms, interim: '...'} | {at: ms, final: '...'}]
export function createMockStt({ label = 'peer', onUpdate = () => {}, onState = () => {}, now = () => Date.now() } = {}) {
  let timers = [], state = 'idle', queue = [];
  function setState(s) { state = s; onState({ provider: 'mock', label, state: s }); }
  function play(events, base = now()) {
    for (const ev of events) {
      const t = setTimeout(() => {
        onUpdate({ finals: ev.final ? [ev.final] : [], interim: ev.final ? '' : (ev.interim || ''), ts: now(), label });
      }, Math.max(0, ev.at));
      timers.push(t);
    }
  }
  return {
    info() { return { name: 'mock', label: 'モック認識 (送信なし)', external: false, supported: true, state }; },
    start() { setState('listening'); if (queue.length) { const q = queue; queue = []; play(q); } },
    stop() { for (const t of timers) clearTimeout(t); timers = []; setState('stopped'); },
    inject(events) { if (state === 'listening') play(events); else queue.push(...events); },
    get state() { return state; },
  };
}
