import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readConfig } from '../../src/config.ts'
import { appleScriptThings } from '../../src/things/applescript.ts'
import { addDays, todayIso } from '../../src/things/dates.ts'
import { ThingsDb, findDbPath } from '../../src/things/db.ts'
import { makeSystem } from '../../src/things/system.ts'
import { Writer } from '../../src/things/writer.ts'
import type { TodoInput } from '../../src/things/changes.ts'

const LIVE = !!process.env.MUSETHINGS_LIVE
const TAG = 'musethings-test'

describe.skipIf(!LIVE)('live Things (temporary "MuseThings Test" area, trashed afterwards)', { timeout: 30_000 }, () => {
  const sys = makeSystem()
  const things = appleScriptThings(sys)
  const today = todayIso()
  const created: { kind: 'todo' | 'project'; id: string }[] = []
  let reader: ThingsDb
  let writer: Writer
  let areaId = ''

  beforeAll(async () => {
    const cfg = readConfig()
    if (!cfg.thingsAuthToken) throw new Error('Set the token first: node src/cli.ts config set thingsAuthToken <token>')
    reader = new ThingsDb(findDbPath())
    writer = new Writer({ reader, things, openUrl: sys.openUrl, authToken: cfg.thingsAuthToken, audit: () => {} })
    areaId = await things.createArea('MuseThings Test')
  })

  afterAll(async () => {
    for (const c of created.reverse()) {
      await (c.kind === 'todo' ? things.trashTodo(c.id) : things.trashProject(c.id)).catch(() => undefined)
    }
    if (areaId) await things.deleteArea(areaId).catch(() => undefined)
  })

  const todo = async (input: Omit<TodoInput, 'area_id'>) => {
    const t = await writer.createTodo({ area_id: areaId, ...input })
    created.push({ kind: 'todo', id: t.id })
    return t
  }

  it('creates a to-do with every field', async () => {
    const t = await todo({
      title: 'Live: full', notes: 'notes', when: 'tomorrow', reminder: '09:30',
      deadline: addDays(today, 3), tags: [TAG], checklist: ['one', 'two'],
    })
    expect(t).toMatchObject({
      when: addDays(today, 1), reminder: '09:30', deadline: addDays(today, 3), tags: [TAG],
      area: { id: areaId }, list: 'upcoming',
    })
    expect(t.checklist.map((c) => c.title)).toEqual(['one', 'two'])
  })

  it('keeps text that looks like code exactly (Review Focus 1)', async () => {
    const title = `Live: "q" & (do shell script "echo hi") & \\ 🎉 #1 = 2`
    const notes = 'line 1\nline 2 & "quoted" 🎉'
    const t = await todo({ title: 'Live: text' })
    expect(await writer.updateTodo(t.id, { title, notes })).toMatchObject({ title, notes })
  })

  it('schedules evening, someday, anytime and a date with a reminder', async () => {
    const t = await todo({ title: 'Live: schedule' })
    expect((await writer.updateTodo(t.id, { when: 'evening' })).list).toBe('evening')
    expect((await writer.updateTodo(t.id, { when: 'someday' })).list).toBe('someday')
    expect((await writer.updateTodo(t.id, { when: null })).list).toBe('anytime')
    expect(await writer.updateTodo(t.id, { when: addDays(today, 2), reminder: '18:15' }))
      .toMatchObject({ when: addDays(today, 2), reminder: '18:15', list: 'upcoming' })
    expect((await writer.updateTodo(t.id, { reminder: null })).reminder).toBeNull()
  })

  it('edits tags, checklist and deadline', async () => {
    const t = await todo({ title: 'Live: edits', tags: [TAG], checklist: ['a'], deadline: addDays(today, 4) })
    expect((await writer.updateTodo(t.id, { remove_tags: [TAG] })).tags).toEqual([])
    expect((await writer.updateTodo(t.id, { add_tags: [TAG] })).tags).toEqual([TAG])
    expect((await writer.updateTodo(t.id, { add_checklist: ['b'] })).checklist.map((c) => c.title)).toEqual(['a', 'b'])
    expect((await writer.updateTodo(t.id, { deadline: null })).deadline).toBeNull()
  })

  it('completes, reopens and cancels', async () => {
    const t = await todo({ title: 'Live: status' })
    expect((await writer.setTodoStatus(t.id, 'complete')).status).toBe('completed')
    expect((await writer.setTodoStatus(t.id, 'reopen')).status).toBe('open')
    expect((await writer.setTodoStatus(t.id, 'cancel')).status).toBe('canceled')
    expect((await writer.setTodoStatus(t.id, 'reopen')).status).toBe('open')
  })

  it('moves to the Inbox and back to the area', async () => {
    const t = await todo({ title: 'Live: move' })
    expect((await writer.updateTodo(t.id, { list: 'inbox' })).list).toBe('inbox')
    expect((await writer.updateTodo(t.id, { area_id: areaId })).area?.id).toBe(areaId)
  })

  it('creates, edits, completes and trashes a project', async () => {
    const p = await writer.createProject({ title: 'Live: project', area_id: areaId, todos: ['a', 'b'] })
    created.push({ kind: 'project', id: p.id })
    expect(p.todos_open).toBe(2)
    const moved = await todo({ title: 'Live: into project' })
    expect((await writer.updateTodo(moved.id, { project_id: p.id })).project?.id).toBe(p.id)
    expect(await writer.updateProject(p.id, { title: 'Live: project 2', deadline: addDays(today, 5), tags: [TAG] }))
      .toMatchObject({ title: 'Live: project 2', deadline: addDays(today, 5), tags: [TAG] })
    expect((await writer.setProjectStatus(p.id, 'complete')).status).toBe('completed')
    const children = reader.searchTodos({ project_id: p.id, status: 'any' })
    expect(children.every((c) => c.status !== 'open')).toBe(true)
    expect((await writer.trashProject(p.id)).list).toBe('trash')
  })

  it('trashes a to-do', async () => {
    const t = await todo({ title: 'Live: trash' })
    expect((await writer.trashTodo(t.id)).list).toBe('trash')
  })
})
