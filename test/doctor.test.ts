import { describe, it, expect } from 'vitest'
import { Fixture } from './helpers/fixture.ts'
import { FakeThings } from './helpers/fake-things.ts'
import { DEFAULTS } from '../src/config.ts'
import { ApiError } from '../src/errors.ts'
import { ThingsDb } from '../src/things/db.ts'
import { Writer } from '../src/things/writer.ts'
import { report, runChecks, type DoctorDeps } from '../src/doctor.ts'

const now = () => new Date(2026, 9, 15, 12, 0)

function setup(over: Partial<DoctorDeps> = {}) {
  const f = new Fixture()
  const fake = new FakeThings(f, now)
  const d: DoctorDeps = {
    config: { ...DEFAULTS, keyHash: 'h', thingsAuthToken: 't', publicUrl: 'https://mac.example.ts.net' },
    openDb: () => new ThingsDb(f.path, now),
    sys: { thingsRunning: async () => true, launchThings: async () => {} },
    things: fake,
    makeWriter: (reader) => new Writer({
      reader, things: fake, openUrl: (u) => fake.openUrl(u), authToken: 't', audit: () => {}, now, pollMs: 5, timeoutMs: 300,
    }),
    httpOk: async () => true,
    funnelStatus: async () => 'https://mac.example.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:8787',
    ...over,
  }
  return { d, fake }
}

describe('doctor', () => {
  it('all green on a finished setup, and cleans up its test to-do', async () => {
    const { d, fake } = setup()
    const { text, ok } = report(await runChecks(d))
    expect(ok).toBe(true)
    expect(text).not.toContain('✘')
    expect(text).toContain('✔ Things URL token works')
    expect(fake.log.some((l) => l.startsWith('trash:'))).toBe(true)
  })

  it('says what to fix on a fresh Mac and skips checks that depend on them', async () => {
    const { d } = setup({
      config: { ...DEFAULTS },
      things: { ping: async () => { throw new ApiError(503, 'setup_required', "macOS hasn't allowed MuseThings to control Things.") } },
      httpOk: async () => false,
      funnelStatus: async () => null,
    })
    const { text, ok } = report(await runChecks(d))
    expect(ok).toBe(false)
    expect(text).toContain('✘ API key: run: node src/cli.ts keygen')
    expect(text).toContain('✘ Control of Things (Automation): macOS hasn')
    expect(text).toContain('– Things URL token works: skipped')
    expect(text).toContain('✘ Tailscale Funnel: tailscale CLI not found')
    expect(text).toContain('✘ Public URL: run: node src/cli.ts config set publicUrl')
  })

  it('catches a wrong Things auth token', async () => {
    const { d, fake } = setup()
    fake.ignoreUrls = true
    const { text, ok } = report(await runChecks(d))
    expect(ok).toBe(false)
    expect(text).toMatch(/✘ Things URL token works: .*copy the token again/)
  })

  it('launches Things when it is not running', async () => {
    let launched = false
    const { d } = setup({ sys: { thingsRunning: async () => launched, launchThings: async () => { launched = true } } })
    const { text } = report(await runChecks(d))
    expect(launched).toBe(true)
    expect(text).toContain('✔ Things running')
  })
})
