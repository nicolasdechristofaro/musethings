import { describe, it, expect } from 'vitest'
import { BadKeyThrottle, bearer, keyMatches, newKey } from '../src/auth.ts'

describe('keys', () => {
  it('generates 32-byte base64url keys and matches only the right one', () => {
    const { key, hash } = newKey()
    expect(Buffer.from(key, 'base64url')).toHaveLength(32)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(keyMatches(key, hash)).toBe(true)
    expect(keyMatches(key + 'x', hash)).toBe(false)
    expect(keyMatches('', hash)).toBe(false)
    expect(newKey().key).not.toBe(key)
  })

  it('reads Bearer headers', () => {
    expect(bearer('Bearer abc')).toBe('abc')
    expect(bearer('Basic abc')).toBeNull()
    expect(bearer(undefined)).toBeNull()
  })
})

describe('BadKeyThrottle', () => {
  it('after 10 bad keys in a minute, throttles bad keys for 15 minutes', () => {
    let t = 0
    const th = new BadKeyThrottle(() => t)
    for (let i = 0; i < 10; i++) expect(th.fail()).toBe(false)
    expect(th.fail()).toBe(true)
    t += 14 * 60_000
    expect(th.fail()).toBe(true)
    t += 2 * 60_000
    expect(th.fail()).toBe(false)
  })

  it('forgets failures older than a minute', () => {
    let t = 0
    const th = new BadKeyThrottle(() => t)
    for (let i = 0; i < 9; i++) th.fail()
    t += 61_000
    expect(th.fail()).toBe(false)
    expect(th.fail()).toBe(false)
  })
})
