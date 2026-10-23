// Anthropic upstream for the relay. The API key is read by the SDK from the relay process environment only.
import Anthropic from '@anthropic-ai/sdk';
import { PRICES, estimateCost, streamCandidates, translateOnce, classifyError } from '../../extension/lib/claude.js';

export { PRICES, estimateCost };

export function createAnthropicUpstream({ model = 'claude-opus-5-5', translateModel, effort = 'low', fallbacks = true, timeoutMs = 20000 } = {}) {
  const client = new Anthropic({ timeout: timeoutMs, maxRetries: 1 });
  translateModel = translateModel || model;
  const withCode = (e) => { if (!e.code || /^\d+$/.test(String(e.code))) e.code = classifyError(e, Anthropic); return e; };
  return {
    name: 'anthropic', model,
    async reply({ system, user, signal, onLine }) {
      try { return await streamCandidates({ client, model, effort, fallbacks, system, user, signal, onLine }); } catch (e) { throw withCode(e); }
    },
    async translate({ text, context, signal }) {
      try { return await translateOnce({ client, model: translateModel, text, context, signal }); } catch (e) { throw withCode(e); }
    },
  };
}
