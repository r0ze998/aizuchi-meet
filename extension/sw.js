// Service worker: action click / shortcut → side panel + activeTab grant; tab capture stream id; offscreen lifecycle; tab close.
import { DEFAULT_SETTINGS, STORAGE_KEYS } from './lib/constants.js';

const OFFSCREEN_URL = 'offscreen.html';
let creating = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creating) return creating;
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Meet タブの音声を取得して認識・翻訳し、スピーカーへ再生し続けるため',
  }).finally(() => { creating = null; });
  return creating;
}

function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
}
function broadcast(msg) { chrome.runtime.sendMessage({ target: 'panel', ...msg }).catch(() => {}); }

chrome.runtime.onInstalled.addListener(() => {
  // Side panel opens from our own onClicked handler so that the click also grants activeTab on that tab.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  const invokedTab = { tabId: tab.id, windowId: tab.windowId, title: tab.title || '', url: tab.url || '', at: Date.now() };
  await chrome.storage.session.set({ invokedTab });
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (e) { console.warn('sidePanel.open failed', e); }
  broadcast({ type: 'invoked', invokedTab });
});

async function startCapture(tabId) {
  const { invokedTab } = await chrome.storage.session.get('invokedTab');
  tabId = tabId ?? invokedTab?.tabId;
  if (tabId == null) return { ok: false, code: 'no-tab', error: 'Meet タブでツールバーのアイコンをクリックしてください' };
  await ensureOffscreen();
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    const m = String(e?.message || e);
    const code = /not been invoked|activeTab|invoke/i.test(m) ? 'needs-invoke' : /already|in use|being captured/i.test(m) ? 'already-captured' : /No tab with id|not found/i.test(m) ? 'tab-gone' : 'capture-failed';
    return { ok: false, code, error: m };
  }
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.profile, STORAGE_KEYS.relayToken, STORAGE_KEYS.anthropicKey]);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
  const res = await sendToOffscreen({
    type: 'start-capture', streamId, tabId,
    tabTitle: invokedTab?.tabId === tabId ? invokedTab.title : '',
    tabUrl: invokedTab?.tabId === tabId ? invokedTab.url : '',
    settings, profile: stored[STORAGE_KEYS.profile] || null, relayToken: stored[STORAGE_KEYS.relayToken] || '', anthropicKey: stored[STORAGE_KEYS.anthropicKey] || '',
  });
  if (res?.ok) await chrome.storage.session.set({ capturingTabId: tabId });
  return res;
}

async function handle(msg) {
  switch (msg.type) {
    case 'start': return startCapture(msg.tabId);
    case 'get-invoked': return (await chrome.storage.session.get('invokedTab')).invokedTab || null;
    case 'ensure-offscreen': await ensureOffscreen(); return { ok: true };
    case 'has-offscreen': return { ok: true, has: await hasOffscreen() };
    case 'open-options': await chrome.runtime.openOptionsPage(); return { ok: true };
    case 'open-mic-permission': await chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') }); return { ok: true };
    case 'captured-tabs': return { ok: true, tabs: await chrome.tabCapture.getCapturedTabs() };
    default: return { ok: false, error: `unknown message ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'sw') return undefined;
  handle(msg).then((r) => sendResponse(r ?? { ok: true }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { capturingTabId } = await chrome.storage.session.get('capturingTabId');
  if (capturingTabId === tabId) {
    await sendToOffscreen({ type: 'stop', reason: 'tab-closed' });
    await chrome.storage.session.remove('capturingTabId');
  }
});

chrome.tabCapture.onStatusChanged.addListener((info) => {
  sendToOffscreen({ type: 'capture-status', info });
  if (info.status === 'stopped' || info.status === 'error') chrome.storage.session.remove('capturingTabId');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const upd = {};
  if (changes[STORAGE_KEYS.settings]) upd.settings = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEYS.settings].newValue || {}) };
  if (changes[STORAGE_KEYS.profile]) upd.profile = changes[STORAGE_KEYS.profile].newValue || null;
  if (changes[STORAGE_KEYS.relayToken]) upd.relayToken = changes[STORAGE_KEYS.relayToken].newValue || '';
  if (changes[STORAGE_KEYS.anthropicKey]) upd.anthropicKey = changes[STORAGE_KEYS.anthropicKey].newValue || '';
  if (Object.keys(upd).length) sendToOffscreen({ type: 'config-updated', ...upd });
});

// Harness hook (only reachable through DevTools / CDP).
globalThis.__aizuchiDebug = { startCapture, ensureOffscreen, hasOffscreen };
