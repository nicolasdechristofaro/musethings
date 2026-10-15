import { hashKey } from '../../src/auth.ts'
import { buildApp } from '../../src/server/app.ts'
import { ThingsDb } from '../../src/things/db.ts'
import { Writer } from '../../src/things/writer.ts'
import { FakeThings } from './fake-things.ts'
import type { Fixture } from './fixture.ts'

export const KEY = 'test-key'
export const auth = { authorization: `Bearer ${KEY}` }

/** The real app over a fixture database, with FakeThings standing in for Things. */
export async function testApp(f: Fixture) {
  const now = new Date(2026, 9, 15, 12, 0)
  const reader = new ThingsDb(f.path, () => now)
  const fake = new FakeThings(f, () => now)
  const writer = new Writer({
    reader, things: fake, openUrl: (u) => fake.openUrl(u), authToken: 'tok',
    audit: () => {}, now: () => now, pollMs: 5, timeoutMs: 1000,
  })
  const app = await buildApp({
    reader, writer, keyHash: hashKey(KEY), thingsRunning: async () => true,
    publicUrl: 'https://mac.example.ts.net',
  })
  return { app, fake, reader }
}
