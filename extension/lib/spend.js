// Spending guard for direct API use: a per-meeting cost cap and a per-minute request cap.
function codeError(code, message) { const e = new Error(message); e.code = code; return e; }

export class SpendGuard {
  constructor({ maxSessionUsd = 1, maxReqPerMin = 30, now = () => Date.now() } = {}) {
    this.maxSessionUsd = Number(maxSessionUsd) > 0 ? Number(maxSessionUsd) : 1;
    this.maxReqPerMin = Number(maxReqPerMin) > 0 ? Number(maxReqPerMin) : 30;
    this.now = now; this.spentUsd = 0; this.requests = 0; this.window = [];
  }
  // Call before each request. Throws budget-exceeded / rate-limited.
  check() {
    const t = this.now();
    this.window = this.window.filter((x) => t - x < 60000);
    if (this.spentUsd >= this.maxSessionUsd) throw codeError('budget-exceeded', `この会議の費用上限 ($${this.maxSessionUsd.toFixed(2)}) に達しました`);
    if (this.window.length >= this.maxReqPerMin) throw codeError('rate-limited', `1 分あたりの上限 (${this.maxReqPerMin} 回) に達しました`);
    this.window.push(t);
  }
  add(costUsd) { this.requests++; if (Number.isFinite(costUsd) && costUsd > 0) this.spentUsd += costUsd; return Number(this.spentUsd.toFixed(6)); }
  setLimits({ maxSessionUsd, maxReqPerMin } = {}) {
    if (Number(maxSessionUsd) > 0) this.maxSessionUsd = Number(maxSessionUsd);
    if (Number(maxReqPerMin) > 0) this.maxReqPerMin = Number(maxReqPerMin);
  }
  snapshot() { return { spentUsd: Number(this.spentUsd.toFixed(6)), requests: this.requests, maxSessionUsd: this.maxSessionUsd, maxReqPerMin: this.maxReqPerMin }; }
}
