import { randomUUID } from 'node:crypto'
import type { ThingsScripts } from '../../src/things/applescript.ts'
import { packDate, packTime, todayIso } from '../../src/things/dates.ts'
import type { Fixture, TaskRow } from './fixture.ts'

/**
 * Plays Things for writer tests: applies AppleScript calls and things:/// URLs to a fixture
 * database the way Things does. URLs apply after `urlDelayMs`, like the real app.
 * `log` records what happened, in order; `urls` keeps every URL opened.
 */
export class FakeThings implements ThingsScripts {
  readonly log: string[] = []
  readonly urls: string[] = []
  ignoreUrls = false
  urlDelayMs = 20
  private readonly f: Fixture
  private readonly now: () => Date

  constructor(f: Fixture, now: () => Date) {
    this.f = f
    this.now = now
  }

  private stamp(): number {
    return this.now().getTime() / 1000
  }

  private touch(id: string, fields: Record<string, unknown>) {
    this.f.set(id, { ...fields, userModificationDate: this.stamp() } as Partial<TaskRow>)
  }

  async ping() {
    return 'Things3'
  }

  async createTodo(title: string) {
    const id = randomUUID()
    this.log.push(`create:${title}`)
    this.f.task({ uuid: id, title, start: 0 })
    return id
  }

  async createProject(title: string, todoTitles: string[]) {
    const id = randomUUID()
    this.log.push(`createProject:${title}`)
    this.f.task({ uuid: id, type: 1, title, start: 1 })
    todoTitles.forEach((t, i) => this.f.task({ uuid: randomUUID(), title: t, project: id, start: 1, index: i }))
    return id
  }

  async trashTodo(id: string) {
    this.log.push(`trash:${id}`)
    this.touch(id, { trashed: 1 })
  }

  async trashProject(id: string) {
    this.log.push(`trashProject:${id}`)
    this.touch(id, { trashed: 1 })
  }

  async moveToInbox(id: string) {
    this.log.push(`inbox:${id}`)
    this.touch(id, { start: 0, startDate: null, startBucket: 0, project: null, heading: null, area: null })
  }

  async setTags(_kind: 'todo' | 'project', id: string, tags: string[]) {
    this.log.push(`tags:${id}`)
    this.f.db.prepare('DELETE FROM TMTaskTag WHERE tasks = ?').run(id)
    for (const name of tags) {
      let tag = this.f.db.prepare('SELECT uuid FROM TMTag WHERE title = ? COLLATE NOCASE').get(name) as { uuid: string } | undefined
      if (!tag) {
        const { n } = this.f.db.prepare('SELECT COALESCE(max("index"), -1) + 1 AS n FROM TMTag').get() as { n: number }
        tag = { uuid: randomUUID() }
        this.f.tag(tag.uuid, name, null, n)
      }
      this.f.tagTask(id, tag.uuid)
    }
  }

  async createArea(title: string) {
    const id = randomUUID()
    this.f.area(id, title)
    return id
  }

  async deleteArea(id: string) {
    this.f.db.prepare('DELETE FROM TMArea WHERE uuid = ?').run(id)
  }

  async openUrl(url: string) {
    const u = new URL(url)
    const id = u.searchParams.get('id')!
    this.urls.push(url)
    this.log.push(`open:${id}`)
    if (this.ignoreUrls) return
    setTimeout(() => {
      this.apply(u.pathname.replace(/^\/+/, ''), u.searchParams)
      this.log.push(`apply:${id}`)
    }, this.urlDelayMs)
  }

  private apply(command: string, p: URLSearchParams) {
    const id = p.get('id')!
    const today = todayIso(this.now())
    const set: Record<string, unknown> = {}
    if (p.has('title')) set.title = p.get('title')
    if (p.has('notes')) set.notes = p.get('notes')
    if (p.has('deadline')) set.deadline = p.get('deadline') ? packDate(p.get('deadline')!) : null
    if (p.has('when')) {
      const w = p.get('when')!
      if (w === 'evening') Object.assign(set, { start: 1, startDate: packDate(today), startBucket: 1, reminderTime: null })
      else if (w === 'anytime') Object.assign(set, { start: 1, startDate: null, startBucket: 0, reminderTime: null })
      else if (w === 'someday') Object.assign(set, { start: 2, startDate: null, startBucket: 0, reminderTime: null })
      else {
        const [date, time] = w.split('@')
        Object.assign(set, {
          start: date <= today ? 1 : 2,
          startDate: packDate(date),
          startBucket: 0,
          // Like real Things (seen 2026-10-15): a date without @time keeps any existing reminder.
          ...(time ? { reminderTime: packTime(time) } : {}),
        })
      }
    }
    const listId = p.get('list-id') ?? p.get('area-id')
    if (listId) {
      const isArea = !!this.f.db.prepare('SELECT 1 FROM TMArea WHERE uuid = ?').get(listId)
      Object.assign(set, isArea ? { area: listId, project: null, heading: null } : { project: listId, area: null, heading: null })
      const row = this.f.db.prepare('SELECT start FROM TMTask WHERE uuid = ?').get(id) as { start: number }
      if (row.start === 0 && set.start === undefined) set.start = 1
    }
    if (p.has('heading-id')) Object.assign(set, { heading: p.get('heading-id'), project: null })
    if (p.get('completed') === 'true') Object.assign(set, { status: 3, stopDate: this.stamp() })
    if (p.get('completed') === 'false' || p.get('canceled') === 'false') Object.assign(set, { status: 0, stopDate: null })
    if (p.get('canceled') === 'true') Object.assign(set, { status: 2, stopDate: this.stamp() })
    if (Object.keys(set).length) this.touch(id, set)
    if (command === 'update-project' && (set.status === 2 || set.status === 3)) {
      this.f.db.prepare('UPDATE TMTask SET status = ?, stopDate = ? WHERE project = ? AND status = 0').run(set.status, this.stamp(), id)
    }
    if (p.has('checklist-items')) this.f.db.prepare('DELETE FROM TMChecklistItem WHERE task = ?').run(id)
    const items = p.get('checklist-items') ?? p.get('append-checklist-items')
    if (items) {
      const { n } = this.f.db.prepare('SELECT count(*) AS n FROM TMChecklistItem WHERE task = ?').get(id) as { n: number }
      items.split('\n').forEach((title, i) => this.f.checklist(randomUUID(), id, title, false, n + i))
    }
  }
}
