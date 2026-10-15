import type { ListName, Project, Status, Todo } from './types.ts'

/** What an item should look like once Things has applied a write. Unset fields aren't checked. */
export type Expectation = {
  title?: string
  notes?: string
  when?: string | null
  reminder?: string | null
  deadline?: string | null
  lists?: ListName[]
  tags?: string[]
  project?: string | null
  area?: string | null
  heading?: string | null
  checklist?: string[]
  status?: Status
}

const sameTags = (a: string[], b: string[]) =>
  a.length === b.length && a.every((t) => b.some((u) => u.toLowerCase() === t.toLowerCase()))

/** Names of the expected fields the item doesn't match yet; empty when it matches. */
export function mismatches(item: Todo | Project, e: Expectation): string[] {
  const todo = 'checklist' in item ? item : null
  const out: string[] = []
  if (e.title !== undefined && item.title !== e.title) out.push('title')
  if (e.notes !== undefined && item.notes !== e.notes) out.push('notes')
  if (e.when !== undefined && item.when !== e.when) out.push('when')
  if (e.reminder !== undefined && item.reminder !== e.reminder) out.push('reminder')
  if (e.deadline !== undefined && item.deadline !== e.deadline) out.push('deadline')
  if (e.lists && !e.lists.includes(item.list)) out.push('list')
  if (e.tags && !sameTags(item.tags, e.tags)) out.push('tags')
  if (e.area !== undefined && (item.area?.id ?? null) !== e.area) out.push('area')
  if (e.status !== undefined && item.status !== e.status) out.push('status')
  if (e.project !== undefined && (todo?.project?.id ?? null) !== e.project) out.push('project')
  if (e.heading !== undefined && (todo?.heading?.id ?? null) !== e.heading) out.push('heading')
  if (e.checklist && JSON.stringify(todo?.checklist.map((c) => c.title) ?? []) !== JSON.stringify(e.checklist)) {
    out.push('checklist')
  }
  return out
}
