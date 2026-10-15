import { describe, it, expect, afterEach } from 'vitest'
import {
  packDate, unpackDate, packTime, unpackTime, unixToIso, isoDateToUnix,
  localIsoDate, todayIso, addDays, isIsoDate, isTime,
} from '../src/things/dates.ts'

const originalTz = process.env.TZ
afterEach(() => { process.env.TZ = originalTz })

describe('packed dates', () => {
  it('matches a value read from a real Things database', () => {
    expect(unpackDate(132818688)).toBe('2026-10-14')
    expect(packDate('2026-10-14')).toBe(132818688)
  })

  it('round-trips year, month and day edges', () => {
    for (const iso of ['2026-01-01', '2026-12-31', '2028-02-29', '2099-09-30']) {
      expect(unpackDate(packDate(iso))).toBe(iso)
    }
  })

  it('treats null and 0 as no date', () => {
    expect(unpackDate(null)).toBeNull()
    expect(unpackDate(0)).toBeNull()
  })
})

describe('packed times', () => {
  it('matches a value read from a real Things database', () => {
    expect(unpackTime(1543503872)).toBe('23:00')
  })

  it('round-trips', () => {
    for (const t of ['00:00', '09:30', '18:05', '23:59']) expect(unpackTime(packTime(t))).toBe(t)
    expect(unpackTime(null)).toBeNull()
  })
})

describe('local dates', () => {
  it('uses the Mac timezone, not UTC, for today (Review Focus 2)', () => {
    process.env.TZ = 'America/Los_Angeles'
    const earlyUtc = new Date('2026-10-15T05:30:00Z') // 22:30 on the 14th in LA
    expect(todayIso(earlyUtc)).toBe('2026-10-14')
    expect(localIsoDate(earlyUtc)).toBe('2026-10-14')
    expect(addDays(todayIso(earlyUtc), 1)).toBe('2026-10-15')
  })

  it('adds days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('converts Unix seconds and local midnight', () => {
    expect(unixToIso(1760000000)).toBe('2025-10-09T08:53:20.000Z')
    expect(unixToIso(null)).toBeNull()
    process.env.TZ = 'UTC'
    expect(isoDateToUnix('2026-10-15')).toBe(Date.UTC(2026, 9, 15) / 1000)
  })
})

describe('validation', () => {
  it('accepts only real calendar dates', () => {
    expect(isIsoDate('2026-10-15')).toBe(true)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('2026-1-5')).toBe(false)
    expect(isIsoDate('tomorrow')).toBe(false)
  })

  it('accepts only HH:MM 24-hour times', () => {
    expect(isTime('09:30')).toBe(true)
    expect(isTime('24:00')).toBe(false)
    expect(isTime('9:30')).toBe(false)
  })
})
