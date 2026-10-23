// Shared steps for the harness scripts: find extension contexts, drive the side panel UI, collect state.
import { CDP, waitFor } from './cdp.mjs';
import { EXT_ID } from './chrome.mjs';

export const extUrl = (p) => `chrome-extension://${EXT_ID}/${p}`;

export async function connect(chrome) {
  const cdp = await CDP.connect(chrome.wsUrl);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  return cdp;
}
export async function swSession(cdp) {
  // The service worker can be (re)starting right after launch; retry until the extension API is injected.
  const isOurs = (x) => x.type === 'service_worker' && x.url.startsWith(`chrome-extension://${EXT_ID}/`);
  for (let attempt = 0; attempt < 6; attempt++) {
    let t = (await cdp.targets()).find(isOurs);
    if (!t) {
      const tid = await cdp.openTab(extUrl('sidepanel.html'), { background: true });
      t = await cdp.waitForTarget(isOurs, 15000, 'service worker');
      await cdp.closeTab(tid).catch(() => {});
    }
    const sid = await cdp.attach(t.targetId).catch(() => null);
    if (sid && (await cdp.evaluate(sid, `typeof chrome !== 'undefined' && !!chrome.storage`).catch(() => false)) === true) return sid;
    await Bun.sleep(500);
  }
  throw new Error('service worker never became ready');
}
export async function offscreenSession(cdp, timeout = 15000) {
  const t = await cdp.waitForTarget((x) => x.url === extUrl('offscreen.html'), timeout, 'offscreen document');
  const sid = await cdp.attach(t.targetId);
  await waitFor(() => cdp.evaluate(sid, `typeof globalThis.__aizuchi !== 'undefined'`).catch(() => false), (ok) => ok === true, { timeout: 8000, label: 'offscreen __aizuchi hook' });
  return sid;
}
export async function pageSession(cdp, url, { width, height } = {}) {
  const tid = await cdp.openTab(url);
  const sid = await cdp.attach(tid);
  if (width) await cdp.emulate(sid, { width, height });
  await Bun.sleep(400);
  return { tid, sid };
}
export async function setSettings(cdp, sw, settings) {
  return cdp.evaluate(sw, `chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }).then(() => chrome.storage.local.get('settings'))`);
}
export async function setProfile(cdp, sw, profile) { return cdp.evaluate(sw, `chrome.storage.local.set({ profile: ${JSON.stringify(profile)} }).then(() => true)`); }
export async function setToken(cdp, sw, token) { return cdp.evaluate(sw, `chrome.storage.local.set({ relayToken: ${JSON.stringify(token)} }).then(() => true)`); }
export async function activeTabId(cdp, sw) { return cdp.evaluate(sw, `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(t => t[0]?.id ?? null)`); }
export async function setInvokedTab(cdp, sw, tabId, title) { return cdp.evaluate(sw, `chrome.storage.session.set({ invokedTab: { tabId: ${tabId}, title: ${JSON.stringify(title)}, url: '', at: Date.now() } }).then(() => true)`); }
export async function capturedTabs(cdp, sw) { return cdp.evaluate(sw, `chrome.tabCapture.getCapturedTabs()`); }
export async function panelClick(cdp, panel, selector) { return cdp.evaluate(panel, `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return 'missing'; if (b.hidden || b.disabled) return 'hidden-or-disabled'; b.click(); return 'clicked'; })()`); }
export async function panelStart(cdp, panel) {
  const r1 = await panelClick(cdp, panel, '#btnStart');
  await Bun.sleep(300);
  const consentVisible = await cdp.evaluate(panel, `!document.getElementById('consent').hidden`);
  if (consentVisible) {
    await cdp.evaluate(panel, `(() => { const c = document.getElementById('consentAck'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()`);
    await Bun.sleep(100);
    await panelClick(cdp, panel, '#btnConsentStart');
  }
  return { r1, consentVisible };
}
export async function offState(cdp, off) { return cdp.evaluate(off, `globalThis.__aizuchi.getState()`); }
export async function offStatus(cdp, off) { return cdp.evaluate(off, `globalThis.__aizuchi.status()`); }
export async function audioStats(cdp, off) { return cdp.evaluate(off, `globalThis.__aizuchi.audioStats()`); }
export async function waitStatus(cdp, off, status, timeout = 10000) { return waitFor(() => offStatus(cdp, off), (s) => s === status, { timeout, label: `offscreen status ${status}` }); }
export async function panelNotice(cdp, panel) { return cdp.evaluate(panel, `(() => { const n = document.getElementById('notice'); return n.hidden ? '' : n.textContent; })()`); }
export function pressShortcutViaOsascript(appName = 'Google Chrome for Testing') {
  const { spawnSync } = require('node:child_process');
  const script = `tell application "${appName}" to activate\ndelay 0.6\ntell application "System Events" to keystroke "y" using {command down, shift down}`;
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 15000 });
  return { ok: r.status === 0, stderr: (r.stderr || '').trim(), stdout: (r.stdout || '').trim() };
}
