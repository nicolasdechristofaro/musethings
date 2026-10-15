import { describe, it, expect, beforeAll } from 'vitest'
import { Fixture } from './helpers/fixture.ts'
import { ThingsDb } from '../src/things/db.ts'
import { packDate, packTime } from '../src/things/dates.ts'

const NOW = new Date(2026, 9, 15, 12, 0) // 2026-10-15 noon, local time
const TODAY = packDate('2026-10-15')
const YESTERDAY = packDate('2026-10-14')
const TOMORROW = packDate('2026-10-16')
const RULE = new Uint8Array([1])

let db: ThingsDb
const ids = (todos: { id: string }[]) => todos.map((t) => t.id)

beforeAll(() => {
  const f = new Fixture()
  f.area('A1', 'Home')
    .task({ uuid: 'P1', type: 1, title: 'Errands', area: 'A1' })
    .task({ uuid: 'P2', type: 1, title: 'Old', trashed: 1 })
    .task({ uuid: 'P3', type: 1, title: 'Maybe later', start: 2 })
    .task({ uuid: 'H1', type: 2, title: 'Shops', project: 'P1' })
    .task({ uuid: 'inbox1', start: 0, title: 'Inbox item' })
    .task({ uuid: 'overdue', start: 1, startDate: YESTERDAY, todayIndex: 1 })
    .task({
      uuid: 'today1', title: 'Call the dentist', notes: 'ask about Friday', start: 1, startDate: TODAY,
      todayIndex: 2, reminderTime: packTime('09:30'), deadline: TOMORROW, creationDate: 1760000000,
    })
    .task({ uuid: 'unconfirmed', start: 2, startDate: TODAY, todayIndex: 3 })
    .task({ uuid: 'instance1', start: 1, startDate: TODAY, todayIndex: 4, rt1_repeatingTemplate: 'template1' })
    .task({ uuid: 'evening1', start: 1, startDate: TODAY, startBucket: 1, todayIndex: 0 })
    .task({ uuid: 'dueToday', start: 1, deadline: TODAY, todayIndex: 5 })
    .task({ uuid: 'dueOverdue', start: 1, deadline: YESTERDAY, todayIndex: 6 })
    .task({ uuid: 'dueSuppressed', start: 1, deadline: YESTERDAY, deadlineSuppressionDate: TODAY })
    .task({ uuid: 'dueLater', start: 1, deadline: TOMORROW })
    .task({ uuid: 'template1', start: 1, startDate: TODAY, rt1_recurrenceRule: RULE })
    .task({ uuid: 'template2', start: 1, repeater: RULE })
    .task({ uuid: 'upcoming1', start: 2, startDate: TOMORROW })
    .task({ uuid: 'anytime1', start: 1, index: 1 })
    .task({ uuid: 'underHeading', start: 1, heading: 'H1', index: 2 })
    .task({ uuid: 'inTrashedProject', start: 1, project: 'P2' })
    .task({ uuid: 'inSomedayProject', start: 1, project: 'P3' })
    .task({ uuid: 'someday1', start: 2 })
    .task({ uuid: 'done1', status: 3, stopDate: 1760600000 }) // 2025-10-16 07:33 UTC
    .task({ uuid: 'canceled1', status: 2, stopDate: 1760400000 })
    .task({ uuid: 'trashed1', start: 1, trashed: 1 })
    .task({ uuid: 'weird', type: 4003, start: 1 })
    .tag('T1', 'phone')
    .tagTask('today1', 'T1')
    .checklist('C1', 'today1', 'Find insurance card', true, 0)
    .checklist('C2', 'today1', 'Check calendar', false, 1)
  f.close()
  db = new ThingsDb(f.path, () => NOW)
})

describe('lists', () => {
  it('inbox', () => {
    expect(ids(db.listTodos('inbox'))).toEqual(['inbox1'])
  })

  it('today: overdue and unconfirmed included, evening last, templates excluded', () => {
    expect(ids(db.listTodos('today'))).toEqual(['overdue', 'today1', 'unconfirmed', 'instance1', 'dueToday', 'dueOverdue', 'evening1'])
  })

  it('today: unscheduled to-dos whose deadline has come, unless dismissed', () => {
    const today = ids(db.listTodos('today'))
    expect(today).not.toContain('dueSuppressed')
    expect(today).not.toContain('dueLater')
    expect(db.getTodo('dueToday')!.list).toBe('today')
    expect(db.getTodo('dueSuppressed')!.list).toBe('anytime')
  })

  it('upcoming', () => {
    expect(ids(db.listTodos('upcoming'))).toEqual(['upcoming1'])
  })

  it('anytime: excludes someday, templates, trashed and someday projects', () => {
    const anytime = ids(db.listTodos('anytime'))
    expect(anytime).toEqual(expect.arrayContaining(['anytime1', 'underHeading', 'today1', 'overdue', 'evening1']))
    for (const id of ['someday1', 'template1', 'template2', 'inTrashedProject', 'inSomedayProject', 'trashed1', 'weird', 'P1']) {
      expect(anytime).not.toContain(id)
    }
  })

  it('someday', () => {
    expect(ids(db.listTodos('someday'))).toEqual(['someday1'])
  })

  it('logbook: newest first, since filters', () => {
    expect(ids(db.listTodos('logbook'))).toEqual(['done1', 'canceled1'])
    expect(ids(db.listTodos('logbook', { since: '2025-10-15' }))).toEqual(['done1'])
  })

  it('limit', () => {
    expect(db.listTodos('today', { limit: 2 })).toHaveLength(2)
  })
})

describe('getTodo', () => {
  it('returns the full object', () => {
    expect(db.getTodo('today1')).toEqual({
      id: 'today1',
      title: 'Call the dentist',
      notes: 'ask about Friday',
      status: 'open',
      list: 'today',
      when: '2026-10-15',
      reminder: '09:30',
      deadline: '2026-10-16',
      tags: ['phone'],
      project: null,
      area: null,
      heading: null,
      checklist: [
        { id: 'C1', title: 'Find insurance card', done: true },
        { id: 'C2', title: 'Check calendar', done: false },
      ],
      repeating: false,
      created_at: '2025-10-09T08:53:20.000Z',
      modified_at: '2025-10-09T08:53:20.000Z',
      completed_at: null,
    })
  })

  it('a to-do under a heading reports its project and area (Review Focus 3)', () => {
    const t = db.getTodo('underHeading')!
    expect(t.heading).toEqual({ id: 'H1', title: 'Shops' })
    expect(t.project).toEqual({ id: 'P1', title: 'Errands' })
    expect(t.area).toEqual({ id: 'A1', title: 'Home' })
  })

  it('derives list and flags', () => {
    expect(db.getTodo('evening1')!.list).toBe('evening')
    expect(db.getTodo('upcoming1')!.list).toBe('upcoming')
    expect(db.getTodo('someday1')!.list).toBe('someday')
    expect(db.getTodo('trashed1')!.list).toBe('trash')
    expect(db.getTodo('done1')).toMatchObject({ list: 'logbook', status: 'completed' })
    expect(db.getTodo('canceled1')!.status).toBe('canceled')
    expect(db.getTodo('instance1')!.repeating).toBe(true)
  })

  it('returns null for non-to-dos and unknown ids', () => {
    for (const id of ['P1', 'H1', 'weird', 'nope']) expect(db.getTodo(id)).toBeNull()
  })

  it('kindOf tells projects, headings and templates apart', () => {
    expect(db.kindOf('today1')).toBe('todo')
    expect(db.kindOf('P1')).toBe('project')
    expect(db.kindOf('H1')).toBe('heading')
    expect(db.kindOf('template1')).toBe('template')
    expect(db.kindOf('template2')).toBe('template')
    expect(db.kindOf('weird')).toBeNull()
    expect(db.kindOf('nope')).toBeNull()
  })
})
