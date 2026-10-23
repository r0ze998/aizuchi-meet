// Print the saved pairing token (so you can re-copy it without restarting the relay).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.RELAY_TOKEN_FILE || path.join(here, 'relay-token');
try { process.stdout.write(fs.readFileSync(file, 'utf8').trim() + '\n'); }
catch { console.error('トークンがまだありません。先に `npm start` で中継を一度起動してください。'); process.exit(1); }
