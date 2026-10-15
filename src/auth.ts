import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function newKey(): { key: string; hash: string } {
  const key = randomBytes(32).toString('base64url')
  return { key, hash: hashKey(key) }
}

export function keyMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashKey(presented), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function bearer(header: string | undefined): string | null {
  const m = /^Bearer (.+)$/.exec(header ?? '')
  return m ? m[1].trim() : null
}

/** After 10 bad keys within a minute, bad keys get 429 for 15 minutes. A good key is never blocked. */
export class BadKeyThrottle {
  private failures: number[] = []
  private blockedUntil = 0
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** Records a bad key. Returns true when bad keys are currently throttled. */
  fail(): boolean {
    const t = this.now()
    if (t < this.blockedUntil) return true
    this.failures = this.failures.filter((x) => t - x < 60_000)
    this.failures.push(t)
    if (this.failures.length >= 10) {
      this.blockedUntil = t + 15 * 60_000
      this.failures = []
    }
    return false
  }
}
