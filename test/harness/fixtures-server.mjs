// Serves test/fixtures over 127.0.0.1 (Bun).
import path from 'node:path';
import { ROOT } from './chrome.mjs';
export function startFixtures(port = 0) {
  const dir = path.join(ROOT, 'test', 'fixtures');
  const server = Bun.serve({
    port, hostname: '127.0.0.1',
    async fetch(req) {
      const p = decodeURIComponent(new URL(req.url).pathname);
      const file = Bun.file(path.join(dir, path.normalize(p).replace(/^(\.\.[/\\])+/, '')));
      if (!(await file.exists())) return new Response('not found', { status: 404 });
      return new Response(file, { headers: { 'Cache-Control': 'no-store' } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port, stop: () => server.stop(true) };
}
