import { describe, it, expect, beforeEach } from 'vitest'
import { Fixture } from './helpers/fixture.ts'
import { FakeThings } from './helpers/fake-things.ts'
import { ThingsDb } from '../src/things/db.ts'
import { Writer } from '../src/things/writer.ts'
import { packDate } from '../src/things/dates.ts'
import type { AuditEntry } from '../src/audit.ts'

const NOW = new Date(2026, 9, 15, 12, 0)
let f: Fixture
let fake: FakeThings
let writer: Writer
let audit: AuditEntry[]

function makeWriter(timeoutMs = 1000) {
  return new Writer({
    reader: new ThingsDb(f.path, () => NOW),
    things: fake,
    openUrl: (url) => fake.openUrl(url),
    authToken: 'tok',
    audit: (e) => audit.push(e),
    now: () => NOW,
    pollMs: 5,
    timeoutMs,
  })
}

beforeEach(() => {
  f = new Fixture()
  f.area('A1', 'Home')
    .task({ uuid: 'P1', type: 1, title: 'Errands', area: 'A1' })
    .task({ uuid: 'P2', type: 1, title: 'Trip' })
    .task({ uuid: 'H1', type: 2, title: 'Shops', project: 'P1' })
    .task({ uuid: 'H9', type: 2, title: 'Packing', project: 'P2' })
    .task({ uuid: 'x1', title: 'Water plants', start: 1 })
    .task({ uuid: 'x2', title: 'Pay rent', start: 1, startDate: packDate('2026-10-15') })
    .task({ uuid: 'x3', title: 'Old idea', start: 1, status: 2, stopDate: 1760000000 })
    .task({ uuid: 'tpl', title: 'Weekly review', start: 1, rt1_recurrenceRule: new Uint8Array([1]) })
    .tag('T1', 'Errands', null, 0)
    .tagTask('x1', 'T1')
    .checklist('C1', 'x1', 'Kitchen', false, 0)
  fake = new FakeThings(f, () => NOW)
  audit = []
  writer = makeWriter()
})

describe('createTodo', () => {
  it('creates with every field and confirms it', async () => {
    const todo = await writer.createTodo({
      title: 'Call the dentist', notes: 'ask about Friday', when: 'tomorrow', reminder: '09:30',
      deadline: '2026-10-17', tags: ['phone'], project_id: 'P1', checklist: ['Find card'],
    })
    expect(todo).toMatchObject({
      title: 'Call the dentist', notes: 'ask about Friday', list: 'upcoming', when: '2026-10-16',
      reminder: '09:30', deadline: '2026-10-17', tags: ['phone'], project: { id: 'P1' }, area: { id: 'A1' },
      checklist: [{ title: 'Find card', done: false }],
    })
    expect(fake.urls[0]).not.toContain('title=')
    expect(audit).toEqual([{ op: 'create_todo', id: todo.id, before: null, after: todo }])
  })

  it('a bare title goes to the Inbox without a URL call', async () => {
    const todo = await writer.createTodo({ title: 'Just a thought' })
    expect(todo.list).toBe('inbox')
    expect(fake.urls).toEqual([])
  })

  it('rejects bad input before touching Things', async () => {
    const bad: [object, RegExp][] = [
      [{ title: 'a', when: '2026-10-01' }, /past/],
      [{ title: 'a', when: 'someday', reminder: '09:00' }, /reminder needs a date/],
      [{ title: 'a', when: 'evening', reminder: '19:00' }, /This Evening/],
      [{ title: 'a', when: 'next week' }, /when must be/],
      [{ title: 'a', when: 'today', reminder: '9am' }, /reminder must be a time/],
      [{ title: 'a', project_id: 'A1' }, /not a project/],
      [{ title: 'a', area_id: 'P1' }, /not an area/],
      [{ title: 'a', project_id: 'P1', heading_id: 'H9' }, /different project/],
      [{ title: 'a', project_id: 'P1', area_id: 'A1' }, /not both/],
      [{ title: 'a', tags: ['one, two'] }, /commas/],
      [{ title: 'two\nlines' }, /single line/],
      [{ title: '  ' }, /empty/],
      [{ title: 'a', checklist: ['x\ny'] }, /single lines/],
    ]
    for (const [input, message] of bad) {
      await expect(writer.createTodo(input as never)).rejects.toMatchObject({
        status: 400, code: 'invalid_request', message: expect.stringMatching(message),
      })
    }
    expect(fake.log).toEqual([])
  })

  it('stores text that looks like code exactly as typed (Review Focus 1)', async () => {
    const title = `Milk & eggs = 2 #1 "quoted" \\ back`
    const notes = `line1\nline2 🎉 " & (do shell script "x") & "`
    const created = await writer.createTodo({ title: 'temp', notes })
    const updated = await writer.updateTodo(created.id, { title })
    expect(updated.title).toBe(title)
    expect(updated.notes).toBe(notes)
  })
})

describe('updateTodo', () => {
  it('schedules: evening, anytime, someday, a date with a reminder', async () => {
    expect((await writer.updateTodo('x1', { when: 'evening' })).list).toBe('evening')
    expect(await writer.updateTodo('x1', { when: null })).toMatchObject({ list: 'anytime', when: null })
    expect((await writer.updateTodo('x1', { when: 'someday' })).list).toBe('someday')
    expect(await writer.updateTodo('x1', { when: '2026-10-20', reminder: '18:00' }))
      .toMatchObject({ list: 'upcoming', when: '2026-10-20', reminder: '18:00' })
  })

  it('changing only the reminder keeps the date', async () => {
    expect(await writer.updateTodo('x2', { reminder: '18:00' }))
      .toMatchObject({ when: '2026-10-15', reminder: '18:00', list: 'today' })
    await expect(writer.updateTodo('x1', { reminder: '18:00' })).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('clears a reminder and keeps the date (Things keeps reminders on date-only updates)', async () => {
    await writer.updateTodo('x1', { when: '2026-10-20', reminder: '18:00' })
    expect(await writer.updateTodo('x1', { reminder: null })).toMatchObject({ when: '2026-10-20', reminder: null })
  })

  it('replaces, adds and removes tags (any case)', async () => {
    expect((await writer.updateTodo('x1', { add_tags: ['phone', 'errands'] })).tags).toEqual(['Errands', 'phone'])
    expect((await writer.updateTodo('x1', { remove_tags: ['ERRANDS'] })).tags).toEqual(['phone'])
    expect((await writer.updateTodo('x1', { tags: [] })).tags).toEqual([])
    await expect(writer.updateTodo('x1', { tags: ['a'], add_tags: ['b'] })).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('moves between heading, area, project and Inbox', async () => {
    expect(await writer.updateTodo('x1', { heading_id: 'H1' })).toMatchObject({ project: { id: 'P1' }, heading: { id: 'H1' } })
    expect(await writer.updateTodo('x1', { area_id: 'A1' })).toMatchObject({ project: null, heading: null, area: { id: 'A1' } })
    expect(await writer.updateTodo('x1', { project_id: 'P2' })).toMatchObject({ project: { id: 'P2' }, area: null })
    expect(await writer.updateTodo('x1', { list: 'inbox' })).toMatchObject({ list: 'inbox', project: null })
    await expect(writer.updateTodo('x1', { list: 'inbox', when: 'today' })).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('sets and clears deadline and notes; appends and replaces the checklist', async () => {
    expect((await writer.updateTodo('x1', { deadline: '2026-10-30', notes: 'n' })).deadline).toBe('2026-10-30')
    expect(await writer.updateTodo('x1', { deadline: null, notes: null })).toMatchObject({ deadline: null, notes: '' })
    expect((await writer.updateTodo('x1', { add_checklist: ['Bathroom'] })).checklist.map((c) => c.title))
      .toEqual(['Kitchen', 'Bathroom'])
    expect((await writer.updateTodo('x1', { checklist: ['Only'] })).checklist.map((c) => c.title)).toEqual(['Only'])
  })

  it('refuses repeating templates, projects and unknown ids', async () => {
    await expect(writer.updateTodo('tpl', { title: 'x' })).rejects.toMatchObject({ status: 409, code: 'repeating_not_supported' })
    await expect(writer.updateTodo('P1', { title: 'x' })).rejects.toMatchObject({
      status: 404, message: expect.stringContaining('/projects/P1'),
    })
    await expect(writer.updateTodo('nope', { title: 'x' })).rejects.toMatchObject({ status: 404 })
  })
})

describe('status and trash', () => {
  it('completes, reopens and cancels; the same status twice is a no-op', async () => {
    const done = await writer.setTodoStatus('x1', 'complete')
    expect(done.status).toBe('completed')
    expect(done.completed_at).not.toBeNull()
    const urlCount = fake.urls.length
    expect((await writer.setTodoStatus('x1', 'complete')).status).toBe('completed')
    expect(fake.urls.length).toBe(urlCount)
    expect((await writer.setTodoStatus('x1', 'reopen')).status).toBe('open')
    expect((await writer.setTodoStatus('x1', 'cancel')).status).toBe('canceled')
    expect((await writer.setTodoStatus('x3', 'reopen')).status).toBe('open')
    expect(fake.urls.at(-1)).toContain('canceled=false')
  })

  it('moves to Trash and records it', async () => {
    const t = await writer.trashTodo('x1')
    expect(t.list).toBe('trash')
    expect(audit.at(-1)).toMatchObject({ op: 'trash_todo', id: 'x1', before: { list: 'anytime' }, after: { list: 'trash' } })
  })
})

describe('confirmation', () => {
  it('fails with write_not_confirmed when Things never applies the change (Review Focus 4)', async () => {
    fake.ignoreUrls = true
    const slow = makeWriter(200)
    const started = Date.now()
    await expect(slow.updateTodo('x1', { title: 'New name' })).rejects.toMatchObject({
      status: 503, code: 'write_not_confirmed', message: expect.stringContaining('title'),
    })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(audit).toEqual([expect.objectContaining({ op: 'update_todo', id: 'x1', error: expect.stringContaining('title') })])
  })

  it('a create Things only half-applies names the new id and is audited, so Muse does not duplicate it', async () => {
    fake.ignoreUrls = true
    const slow = makeWriter(200)
    const err = await slow.createTodo({ title: 'Half', when: 'tomorrow' }).catch((e) => e)
    expect(err).toMatchObject({ code: 'write_not_confirmed' })
    const id = fake.log.find((l) => l.startsWith('open:'))!.slice('open:'.length)
    expect(err.message).toContain(id)
    expect(audit).toEqual([expect.objectContaining({ op: 'create_todo', id, before: null, error: expect.stringContaining('when') })])
  })

  it('runs parallel writes one at a time, each confirmed before the next (Review Focus 5)', async () => {
    const [a, b] = await Promise.all([writer.updateTodo('x1', { title: 'A' }), writer.updateTodo('x2', { title: 'B' })])
    expect([a.title, b.title]).toEqual(['A', 'B'])
    expect(fake.log).toEqual(['open:x1', 'apply:x1', 'open:x2', 'apply:x2'])
  })
})
