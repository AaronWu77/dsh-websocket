/** Route-owned SSE cooling and single-flight WebSocket recovery, without background inference. */
export class Circuit {
  failures = 0
  sseUntil = 0
  private probing = false
  constructor(private readonly threshold: number, private readonly cooldownMs: number, private readonly now = Date.now) {}
  admit(): { mode: 'auto' | 'sse'; settle: (result: 'success' | 'failure' | 'neutral') => void } {
    const cooling = this.sseUntil > this.now()
    const probe = this.sseUntil > 0 && !cooling && !this.probing
    const mode = cooling || this.probing ? 'sse' : 'auto'
    if (probe) this.probing = true
    let settled = false
    return { mode, settle: result => {
      if (settled) return
      settled = true
      if (probe) this.probing = false
      if (mode === 'sse') return
      if (result === 'success') { this.failures = 0; this.sseUntil = 0 }
      else if (result === 'failure' && this.threshold > 0) {
        this.failures++
        if (probe || this.failures >= this.threshold) this.sseUntil = this.now() + this.cooldownMs
      }
    } }
  }
  reset(): void { this.failures = 0; this.sseUntil = 0 }
  snapshot() { return { failures: this.failures, sseUntil: this.sseUntil, probing: this.probing } }
}
