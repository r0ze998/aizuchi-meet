// HTTP client for the local relay (127.0.0.1). Bearer token pairing, SSE parsing, abortable.
export class RelayError extends Error {
  constructor(code, message, status) { super(message); this.name = 'RelayError'; this.code = code; this.status = status; }
}

function mapStatus(status) {
  if (status === 401) return 'unpaired';
  if (status === 403) return 'origin-rejected';
  if (status === 402) return 'budget-exceeded';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'upstream-error';
  return 'request-failed';
}

export class RelayClient {
  constructor({ baseUrl, token }) { this.baseUrl = String(baseUrl || '').replace(/\/+$/, ''); this.token = token || ''; }
  headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }
  async request(path, body, { signal } = {}) {
    let res;
    try {
      res = await fetch(this.baseUrl + path, { method: body ? 'POST' : 'GET', headers: this.headers(), body: body ? JSON.stringify(body) : undefined, signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new RelayError('unreachable', `中継に接続できません (${this.baseUrl})`, 0);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error || ''; } catch { /* ignore */ }
      throw new RelayError(mapStatus(res.status), detail || `relay HTTP ${res.status}`, res.status);
    }
    return res;
  }
  async health({ signal } = {}) { return (await this.request('/v1/health', null, { signal })).json(); }
  async translate({ text, context }, { signal } = {}) { return (await this.request('/v1/translate', { text, context }, { signal })).json(); }
  async *reply(payload, { signal } = {}) {
    const res = await this.request('/v1/reply', payload, { signal });
    yield* readSse(res, signal);
  }
}

export async function* readSse(res, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let event = 'message'; const data = [];
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        let parsed = null;
        try { parsed = JSON.parse(data.join('\n')); } catch { parsed = { raw: data.join('\n') }; }
        yield { event, data: parsed };
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
    if (signal?.aborted) { try { await res.body.cancel(); } catch { /* ignore */ } }
  }
}
