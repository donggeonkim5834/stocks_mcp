// Rate limiter for API calls (Token Bucket 방식)
export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // tokens per second
  private lastRefill: number;

  constructor(maxTokens: number, refillIntervalMs: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = maxTokens / (refillIntervalMs / 1000);
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitTime = Math.ceil((1 - this.tokens) / this.refillRate * 1000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.refill();
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = this.tokens + elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, newTokens);
    this.lastRefill = now;
  }
}

// Massive.com: 5 calls/min = 12초 간격
export const massiveRateLimiter = new RateLimiter(5, 60000);

