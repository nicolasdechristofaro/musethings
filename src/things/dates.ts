const pad = (n: number) => String(n).padStart(2, '0')

export function packDate(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return (y << 16) | (m << 12) | (d << 7)
}

export function unpackDate(n: number | null | undefined): string | null {
  if (!n) return null
  return `${n >> 16}-${pad((n >> 12) & 0xf)}-${pad((n >> 7) & 0x1f)}`
}

export function packTime(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h << 26) | (m << 20)
}

export function unpackTime(n: number | null | undefined): string | null {
  if (n == null) return null
  return `${pad((n >> 26) & 0x1f)}:${pad((n >> 20) & 0x3f)}`
}

export function unixToIso(s: number | null | undefined): string | null {
  return s == null ? null : new Date(s * 1000).toISOString()
}

/** Local midnight of an ISO date, as Unix seconds. */
export function isoDateToUnix(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).getTime() / 1000
}

export function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function todayIso(now: Date = new Date()): string {
  return localIsoDate(now)
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return localIsoDate(new Date(y, m - 1, d + n))
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  return localIsoDate(new Date(y, m - 1, d)) === s
}

export function isTime(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
}
