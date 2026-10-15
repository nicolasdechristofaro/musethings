import { unpackDate, unpackTime, unixToIso } from './dates.ts'
import type { ChecklistItem, ListName, Ref, Status, Todo } from './types.ts'

/** Columns every task query selects (see TASK_SELECT in db.ts). */
export type TaskRow = {
  uuid: string
  title: string | null
  notes: string | null
  status: number
  trashed: number
  start: number
  startDate: number | null
  startBucket: number | null
  reminderTime: number | null
  deadline: number | null
  deadlineSuppressionDate: number | null
  creationDate: number | null
  userModificationDate: number | null
  stopDate: number | null
  rt1_repeatingTemplate: string | null
  headingId: string | null
  headingTitle: string | null
  projectId: string | null
  projectTitle: string | null
  areaId: string | null
  areaTitle: string | null
}

export function statusName(n: number): Status {
  return n === 3 ? 'completed' : n === 2 ? 'canceled' : 'open'
}

export function listOf(r: TaskRow, today: number): ListName {
  if (r.trashed) return 'trash'
  if (r.status !== 0) return 'logbook'
  if (r.start === 0) return 'inbox'
  // Things shows an unscheduled to-do in Today once its deadline comes, unless dismissed.
  if (r.startDate == null && r.deadline != null && r.deadline <= today && r.deadlineSuppressionDate == null) return 'today'
  if (r.startDate != null && r.startDate <= today) return r.startBucket === 1 ? 'evening' : 'today'
  if (r.startDate != null) return 'upcoming'
  if (r.start === 2) return 'someday'
  return 'anytime'
}

const ref = (id: string | null, title: string | null): Ref | null => (id ? { id, title: title ?? '' } : null)

export function toTodo(r: TaskRow, tags: string[], checklist: ChecklistItem[], today: number): Todo {
  return {
    id: r.uuid,
    title: r.title ?? '',
    notes: r.notes ?? '',
    status: statusName(r.status),
    list: listOf(r, today),
    when: unpackDate(r.startDate),
    reminder: unpackTime(r.reminderTime),
    deadline: unpackDate(r.deadline),
    tags,
    project: ref(r.projectId, r.projectTitle),
    area: ref(r.areaId, r.areaTitle),
    heading: ref(r.headingId, r.headingTitle),
    checklist,
    repeating: r.rt1_repeatingTemplate != null,
    created_at: unixToIso(r.creationDate),
    modified_at: unixToIso(r.userModificationDate),
    completed_at: r.status === 0 ? null : unixToIso(r.stopDate),
  }
}
