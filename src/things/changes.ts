import { invalid } from '../errors.ts'
import { addDays, isIsoDate, isTime, todayIso } from './dates.ts'
import type { ThingsDb } from './db.ts'
import type { Expectation } from './expect.ts'
import type { Project, Todo } from './types.ts'

/** 'today' | 'evening' | 'tomorrow' | 'anytime' | 'someday' | 'YYYY-MM-DD' */
export type When = string

export type TodoFields = {
  title?: string
  notes?: string | null
  when?: When | null
  reminder?: string | null
  deadline?: string | null
  list?: 'inbox'
  tags?: string[]
  add_tags?: string[]
  remove_tags?: string[]
  project_id?: string
  area_id?: string
  heading_id?: string
  checklist?: string[]
  add_checklist?: string[]
}

export type TodoInput = Omit<TodoFields, 'title' | 'list' | 'add_tags' | 'remove_tags' | 'add_checklist'> & { title: string }

export type Lookup = Pick<ThingsDb, 'kindOf' | 'getHeading' | 'areaExists'>

/** What one write sends to Things, and what the item should look like afterwards. */
export type ChangePlan = {
  url: Record<string, string | boolean>
  tags: string[] | null
  toInbox: boolean
  expect: Expectation
}

const WHEN_HELP = 'when must be today, evening, tomorrow, anytime, someday, a date like 2026-10-17, or null'

export function checkTitle(title: string) {
  if (!title.trim()) throw invalid("title can't be empty")
  if (/[\r\n]/.test(title)) throw invalid('title must be a single line; put details in notes')
}

export function checkTagNames(tags: string[], field: string) {
  for (const t of tags) {
    if (!t.trim()) throw invalid(`${field} can't contain empty tag names`)
    if (t.includes(',')) throw invalid(`${field}: tag names can't contain commas ("${t}")`)
  }
}

/** The full tag list after a change, or null when tags aren't being changed. */
export function tagPlan(f: Pick<TodoFields, 'tags' | 'add_tags' | 'remove_tags'>, current: { tags: string[] } | null): string[] | null {
  const editing = f.add_tags !== undefined || f.remove_tags !== undefined
  if (f.tags !== undefined && editing) throw invalid('use tags, or add_tags/remove_tags, not both')
  if (f.tags !== undefined) {
    checkTagNames(f.tags, 'tags')
    return f.tags
  }
  if (!editing) return null
  checkTagNames(f.add_tags ?? [], 'add_tags')
  checkTagNames(f.remove_tags ?? [], 'remove_tags')
  const remove = new Set((f.remove_tags ?? []).map((t) => t.toLowerCase()))
  const kept = (current?.tags ?? []).filter((t) => !remove.has(t.toLowerCase()))
  const have = new Set(kept.map((t) => t.toLowerCase()))
  return [...kept, ...(f.add_tags ?? []).filter((t) => !have.has(t.toLowerCase()))]
}

/** Fills plan.url.when and the when/reminder/list expectations. Shared by to-dos and projects. */
export function planWhen(
  f: { when?: When | null; reminder?: string | null },
  current: { when: string | null } | null,
  today: string,
  plan: ChangePlan,
) {
  if (f.when === undefined && f.reminder === undefined) return
  if (f.reminder != null && !isTime(f.reminder)) throw invalid('reminder must be a time like 09:30')
  // Changing only the reminder keeps the current date.
  const when = f.when === undefined ? (current?.when ?? null) : f.when

  if (when === null || when === 'anytime' || when === 'someday') {
    if (f.reminder) throw invalid('a reminder needs a date: set when to today, tomorrow or a date')
    if (f.when === undefined) return
    plan.url.when = when ?? 'anytime'
    plan.expect.when = null
    plan.expect.lists = [when === 'someday' ? 'someday' : 'anytime']
    return
  }
  if (when === 'evening') {
    if (f.reminder) throw invalid("This Evening can't have a reminder; use when: today with a reminder time")
    plan.url.when = 'evening'
    plan.expect.when = today
    plan.expect.lists = ['evening']
    return
  }
  const date = when === 'today' ? today : when === 'tomorrow' ? addDays(today, 1) : when
  if (!isIsoDate(date)) throw invalid(WHEN_HELP)
  if (date < today) throw invalid(`when can't be in the past (today is ${today})`)
  plan.url.when = f.reminder ? `${date}@${f.reminder}` : date
  plan.expect.when = date
  if (f.reminder !== undefined) plan.expect.reminder = f.reminder
}

function planLocation(f: TodoFields, lookup: Lookup, plan: ChangePlan) {
  if (f.project_id && f.area_id) throw invalid('give project_id or area_id, not both')
  if (f.heading_id) {
    if (f.area_id) throw invalid("heading_id can't be combined with area_id")
    const h = lookup.getHeading(f.heading_id)
    if (!h) throw invalid(`heading_id ${f.heading_id} is not a heading in Things`)
    if (f.project_id && f.project_id !== h.projectId) throw invalid('heading_id belongs to a different project than project_id')
    plan.url['list-id'] = h.projectId
    plan.url['heading-id'] = h.id
    plan.expect.project = h.projectId
    plan.expect.heading = h.id
    return
  }
  if (f.project_id) {
    if (lookup.kindOf(f.project_id) !== 'project') throw invalid(`project_id ${f.project_id} is not a project in Things`)
    plan.url['list-id'] = f.project_id
    plan.expect.project = f.project_id
    plan.expect.heading = null
  } else if (f.area_id) {
    if (!lookup.areaExists(f.area_id)) throw invalid(`area_id ${f.area_id} is not an area in Things`)
    plan.url['list-id'] = f.area_id
    plan.expect.area = f.area_id
    plan.expect.project = null
  }
}

function planChecklist(f: TodoFields, current: Todo | null, plan: ChangePlan) {
  if (f.checklist !== undefined && f.add_checklist !== undefined) throw invalid('use checklist or add_checklist, not both')
  const items = f.checklist ?? f.add_checklist
  if (items === undefined) return
  for (const item of items) {
    if (!item.trim()) throw invalid("checklist items can't be empty")
    if (/[\r\n]/.test(item)) throw invalid('checklist items must be single lines')
  }
  const final = f.checklist ?? [...(current?.checklist.map((c) => c.title) ?? []), ...items]
  if (final.length > 100) throw invalid('Things allows at most 100 checklist items')
  plan.url[f.checklist ? 'checklist-items' : 'append-checklist-items'] = items.join('\n')
  plan.expect.checklist = final
}

/** Title, notes and deadline: the same for to-dos and projects. */
export function planBasics(f: { title?: string; notes?: string | null; deadline?: string | null }, plan: ChangePlan) {
  if (f.title !== undefined) {
    checkTitle(f.title)
    plan.url.title = f.title
    plan.expect.title = f.title
  }
  if (f.notes !== undefined) {
    plan.url.notes = f.notes ?? ''
    plan.expect.notes = f.notes ?? ''
  }
  if (f.deadline !== undefined) {
    if (f.deadline !== null && !isIsoDate(f.deadline)) throw invalid('deadline must be a date like 2026-10-17, or null to clear it')
    plan.url.deadline = f.deadline ?? ''
    plan.expect.deadline = f.deadline
  }
}

/** Validates a to-do change and plans it. Throws invalid_request before anything is sent. */
export function planTodoChange(f: TodoFields, current: Todo | null, lookup: Lookup, now: Date): ChangePlan {
  const plan: ChangePlan = { url: {}, tags: null, toInbox: false, expect: {} }
  planBasics(f, plan)
  planWhen(f, current, todayIso(now), plan)
  plan.tags = tagPlan(f, current)
  if (plan.tags) plan.expect.tags = plan.tags
  planLocation(f, lookup, plan)
  planChecklist(f, current, plan)
  if (f.list === 'inbox') {
    if (f.when !== undefined || f.project_id || f.area_id || f.heading_id) {
      throw invalid('list: "inbox" can\'t be combined with when, project_id, area_id or heading_id')
    }
    plan.toInbox = true
    plan.expect.lists = ['inbox']
  }
  return plan
}

export type ProjectFields = {
  title?: string
  notes?: string | null
  when?: When | null
  deadline?: string | null
  tags?: string[]
  add_tags?: string[]
  remove_tags?: string[]
  area_id?: string
}

export type ProjectInput = Omit<ProjectFields, 'title' | 'add_tags' | 'remove_tags'> & { title: string; todos?: string[] }

export function planProjectChange(f: ProjectFields, current: Project | null, lookup: Lookup, now: Date): ChangePlan {
  const plan: ChangePlan = { url: {}, tags: null, toInbox: false, expect: {} }
  if (f.when === 'evening') throw invalid("projects can't be scheduled for This Evening; use today")
  planBasics(f, plan)
  planWhen({ when: f.when }, current, todayIso(now), plan)
  plan.tags = tagPlan(f, current)
  if (plan.tags) plan.expect.tags = plan.tags
  if (f.area_id !== undefined) {
    if (!lookup.areaExists(f.area_id)) throw invalid(`area_id ${f.area_id} is not an area in Things`)
    plan.url['area-id'] = f.area_id
    plan.expect.area = f.area_id
  }
  return plan
}
