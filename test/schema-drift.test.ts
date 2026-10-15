import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { findDbPath } from '../src/things/db.ts'
import { Fixture } from './helpers/fixture.ts'

let real: string | null = null
try {
  real = findDbPath()
} catch {
  real = null
}

const TABLES = ['TMTask', 'TMArea', 'TMTag', 'TMTaskTag', 'TMAreaTag', 'TMChecklistItem']
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

describe.skipIf(!real)('fixture schema vs the installed Things', () => {
  it('every column the fixture has still exists in Things', () => {
    const fixture = new Fixture()
    const live = new DatabaseSync(real!, { readOnly: true })
    for (const table of TABLES) {
      const liveCols = columns(live, table)
      const missing = columns(fixture.db, table).filter((c) => !liveCols.includes(c))
      expect(missing, `${table}: columns gone from Things — update the fixture and queries`).toEqual([])
    }
    live.close()
    fixture.close()
  })
})
