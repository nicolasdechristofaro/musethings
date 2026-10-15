export type ListName = 'inbox' | 'today' | 'evening' | 'upcoming' | 'anytime' | 'someday' | 'logbook' | 'trash'
export type ReadableList = 'inbox' | 'today' | 'upcoming' | 'anytime' | 'someday' | 'logbook'
export const READABLE_LISTS: readonly ReadableList[] = ['inbox', 'today', 'upcoming', 'anytime', 'someday', 'logbook']
export type Status = 'open' | 'completed' | 'canceled'
export type Kind = 'todo' | 'project' | 'heading' | 'template'

export type Ref = { id: string; title: string }
export type ChecklistItem = { id: string; title: string; done: boolean }

export type Todo = {
  id: string
  title: string
  notes: string
  status: Status
  list: ListName
  when: string | null
  reminder: string | null
  deadline: string | null
  tags: string[]
  project: Ref | null
  area: Ref | null
  heading: Ref | null
  checklist: ChecklistItem[]
  repeating: boolean
  created_at: string | null
  modified_at: string | null
  completed_at: string | null
}

export type Project = Omit<Todo, 'checklist' | 'heading' | 'project' | 'repeating'> & {
  todos_open: number
  headings: Ref[]
}
export type ProjectDetail = Project & { groups: { heading: Ref | null; todos: Todo[] }[] }

export type Area = { id: string; title: string; tags: string[] }
export type AreaDetail = Area & { projects: Project[]; todos: Todo[] }
export type Tag = { id: string; title: string; parent: string | null }
