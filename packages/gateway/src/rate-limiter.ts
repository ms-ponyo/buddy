/**
 * Token-bucket rate limiter for Slack API calls.
 *
 * Slack rate limits are per-method tier:
 *   Tier 1: ~1 req/sec       (e.g. admin methods)
 *   Tier 2: ~20 req/min      (e.g. conversations.list)
 *   Tier 3: ~50 req/min      (e.g. chat.postMessage, chat.update)
 *   Tier 4: ~100+ req/min    (e.g. auth.test)
 *
 * This limiter applies a global cap across all methods, defaulting to Tier 3
 * (~50/min ≈ ~1 per 1.2s). When a 429 Retry-After is encountered, the limiter
 * pauses all outgoing calls for the specified duration.
 */

export class SlackRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private pauseUntil = 0;
  private waitQueue: Array<() => void> = [];

  constructor(
    private readonly maxTokens: number = 40,
    private readonly refillIntervalMs: number = 60_000,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Wait until a token is available, then consume it.
   * Resolves immediately if tokens are available and no pause is active.
   */
  async acquire(): Promise<void> {
    // Respect 429 pause
    const now = Date.now();
    if (now < this.pauseUntil) {
      await this.sleep(this.pauseUntil - now);
    }

    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // No tokens available — wait for the next refill cycle
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
      // Schedule a drain attempt at next refill
      const waitMs = this.refillIntervalMs - (Date.now() - this.lastRefill);
      setTimeout(() => this.drainWaiters(), Math.max(waitMs, 100));
    });
  }

  /**
   * Call this when a Slack API response includes a 429 with Retry-After header.
   * Pauses all future acquires for the specified duration.
   */
  onRateLimited(retryAfterSec: number): void {
    this.pauseUntil = Date.now() + retryAfterSec * 1000;
    this.tokens = 0;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.refillIntervalMs) {
      const cycles = Math.floor(elapsed / this.refillIntervalMs);
      this.tokens = Math.min(this.maxTokens, this.tokens + this.maxTokens * cycles);
      this.lastRefill += cycles * this.refillIntervalMs;
    }
  }

  private drainWaiters(): void {
    this.refill();
    while (this.tokens >= 1 && this.waitQueue.length > 0) {
      this.tokens -= 1;
      const resolve = this.waitQueue.shift()!;
      resolve();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
