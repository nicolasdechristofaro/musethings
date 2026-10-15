import { describe, it, expect, beforeEach } from 'vitest'
import { Fixture } from './helpers/fixture.ts'
import { FakeThings } from './helpers/fake-things.ts'
import { ThingsDb } from '../src/things/db.ts'
import { Writer } from '../src/things/writer.ts'
import type { AuditEntry } from '../src/audit.ts'

const NOW = new Date(2026, 9, 15, 12, 0)
let fake: FakeThings
let reader: ThingsDb
let writer: Writer
let audit: AuditEntry[]

beforeEach(() => {
  const f = new Fixture()
  f.area('A1', 'Home')
    .task({ uuid: 'P1', type: 1, title: 'Errands', area: 'A1' })
    .task({ uuid: 'c1', title: 'Buy milk', project: 'P1' })
    .task({ uuid: 'x1', title: 'Water plants' })
  fake = new FakeThings(f, () => NOW)
  reader = new ThingsDb(f.path, () => NOW)
  audit = []
  writer = new Writer({
    reader, things: fake, openUrl: (u) => fake.openUrl(u), authToken: 'tok',
    audit: (e) => audit.push(e), now: () => NOW, pollMs: 5, timeoutMs: 1000,
  })
})

describe('projects', () => {
  it('creates a project with to-dos, area, schedule, deadline and tags', async () => {
    const p = await writer.createProject({
      title: 'Trip', notes: 'Lisbon', area_id: 'A1', when: 'someday', deadline: '2026-11-01',
      tags: ['travel'], todos: ['Book flights', 'Pack'],
    })
    expect(p).toMatchObject({
      title: 'Trip', notes: 'Lisbon', area: { id: 'A1' }, list: 'someday', deadline: '2026-11-01',
      tags: ['travel'], todos_open: 2,
    })
    expect(fake.urls[0]).toMatch(/^things:\/\/\/update-project\?id=/)
    expect(fake.urls[0]).toContain('area-id=A1')
    expect(audit[0]).toMatchObject({ op: 'create_project', id: p.id, before: null })
  })

  it('rejects bad input before touching Things', async () => {
    const bad: [object, RegExp][] = [
      [{ title: 'a', when: 'evening' }, /This Evening/],
      [{ title: 'a', area_id: 'P1' }, /not an area/],
      [{ title: 'a', todos: ['x\ny'] }, /single line/],
      [{ title: 'a', when: '2026-01-01' }, /past/],
    ]
    for (const [input, message] of bad) {
      await expect(writer.createProject(input as never)).rejects.toMatchObject({
        code: 'invalid_request', message: expect.stringMatching(message),
      })
    }
    expect(fake.log).toEqual([])
  })

  it('updates title, schedule and tags', async () => {
    expect(await writer.updateProject('P1', { title: 'Weekend errands', when: '2026-10-20', add_tags: ['home'] }))
      .toMatchObject({ title: 'Weekend errands', when: '2026-10-20', list: 'upcoming', tags: ['home'] })
  })

  it('completing a project completes its open to-dos', async () => {
    expect((await writer.setProjectStatus('P1', 'complete')).status).toBe('completed')
    expect(reader.getTodo('c1')!.status).toBe('completed')
    expect(audit.at(-1)).toMatchObject({ op: 'complete_project', id: 'P1' })
  })

  it('cancels and trashes', async () => {
    expect((await writer.setProjectStatus('P1', 'cancel')).status).toBe('canceled')
    expect((await writer.trashProject('P1')).list).toBe('trash')
    expect(audit.at(-1)).toMatchObject({ op: 'trash_project', id: 'P1' })
  })

  it('tells to-dos and projects apart', async () => {
    await expect(writer.updateProject('x1', { title: 'a' })).rejects.toMatchObject({
      status: 404, message: expect.stringContaining('/todos/x1'),
    })
    await expect(writer.trashProject('nope')).rejects.toMatchObject({ status: 404 })
  })
})
