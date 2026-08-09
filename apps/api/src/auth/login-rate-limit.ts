export type RateLimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

type AttemptBucket = {
  attempts: number;
  resetAt: number;
};

export class LoginRateLimiter {
  private readonly buckets = new Map<string, AttemptBucket>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  consume(key: string): RateLimitResult {
    const now = this.now();
    const current = this.buckets.get(key);
    const bucket =
      !current || current.resetAt <= now
        ? { attempts: 0, resetAt: now + this.windowMs }
        : current;

    if (bucket.attempts >= this.maxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((bucket.resetAt - now) / 1_000),
        ),
      };
    }

    bucket.attempts += 1;
    this.buckets.set(key, bucket);
    this.pruneExpired(now);
    return { allowed: true };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private pruneExpired(now: number): void {
    if (this.buckets.size < 1_000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
