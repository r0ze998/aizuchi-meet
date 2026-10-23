// Launch a dedicated Chrome for Testing profile with the unpacked extension (Bun script).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dir, '..', '..');
export const EXT_DIR = path.join(ROOT, 'extension');
export const EXT_ID = fs.readFileSync(path.join(ROOT, '.dev', 'extension-id.txt'), 'utf8').trim();
export const OUT_DIR = path.join(ROOT, 'test', 'out');
export const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots');

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(ROOT, '.dev', 'browsers', 'chrome');
  if (fs.existsSync(base)) {
    for (const v of fs.readdirSync(base).sort().reverse()) {
      const p = path.join(base, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('Chrome for Testing not found. Run: npx @puppeteer/browsers install chrome@stable --path .dev/browsers');
}
export function chromeVersion() { try { return require('node:child_process').execFileSync(findChrome(), ['--version']).toString().trim(); } catch { return 'unknown'; } }

async function waitForDevtools(port, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); const j = await r.json(); if (j.webSocketDebuggerUrl) return j; } catch { /* retry */ }
    await Bun.sleep(200);
  }
  throw new Error('DevTools endpoint not reachable');
}

export async function launchChrome({ port = 9333, allowlist = true, headless = false, url = 'about:blank', fakeMedia = false, extraArgs = [], keepProfile = false } = {}) {
  const profileDir = path.join(ROOT, '.chrome-profile', `p${port}`);
  if (!keepProfile) fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
    `--load-extension=${EXT_DIR}`, `--remote-debugging-port=${port}`,
    '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900', '--lang=ja',
  ];
  if (allowlist) args.push(`--allowlisted-extension-id=${EXT_ID}`);
  if (headless) args.push('--headless=new');
  if (fakeMedia) args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream');
  args.push(...extraArgs, url);
  const proc = spawn(findChrome(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  proc.stderr.on('data', (d) => { logs.push(String(d)); if (logs.length > 500) logs.shift(); });
  proc.stdout.on('data', (d) => { logs.push(String(d)); });
  const version = await waitForDevtools(port, 25000);
  return {
    proc, port, profileDir, logs, wsUrl: version.webSocketDebuggerUrl, browser: version.Browser, allowlist,
    kill: () => new Promise((res) => { if (proc.exitCode !== null) return res(); proc.once('exit', res); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 3000); }),
  };
}
