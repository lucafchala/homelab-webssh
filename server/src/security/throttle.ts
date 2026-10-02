/**
 * In-memory sliding-window failure counter, used to slow down brute force per
 * client IP (per-account lockout lives in the users table).
 */
export class FailureThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private recent(key: string, now: number): number[] {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
    return arr;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  /** Seconds until the key is no longer blocked. */
  retryAfter(key: string, now = Date.now()): number {
    const arr = this.recent(key, now);
    if (arr.length < this.max) return 0;
    return Math.ceil((arr[arr.length - this.max] + this.windowMs - now) / 1000);
  }

  fail(key: string, now = Date.now()): void {
    const arr = this.recent(key, now);
    arr.push(now);
    this.hits.set(key, arr);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  sweep(now = Date.now()): void {
    for (const key of this.hits.keys()) this.recent(key, now);
  }
}

/** Small TTL map for short-lived secrets (WebAuthn challenges, pending TOTP enrolments). */
export class TtlMap<V> {
  private readonly map = new Map<string, { v: V; exp: number }>();
  constructor(private readonly ttlMs: number) {}

  set(key: string, v: V): void {
    this.map.set(key, { v, exp: Date.now() + this.ttlMs });
    if (this.map.size > 10_000) this.sweep();
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.v;
  }

  /** Get and delete — for single-use values such as challenges. */
  take(key: string): V | undefined {
    const v = this.get(key);
    this.map.delete(key);
    return v;
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  sweep(): void {
    const t = Date.now();
    for (const [k, e] of this.map) if (e.exp < t) this.map.delete(k);
  }
}
