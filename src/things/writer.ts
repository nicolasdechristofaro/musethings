import { ApiError, notFound } from '../errors.ts'
import type { Audit } from '../audit.ts'
import { Queue } from '../queue.ts'
import type { ThingsScripts } from './applescript.ts'
import {
  checkTitle, planProjectChange, planTodoChange,
  type ChangePlan, type Lookup, type ProjectFields, type ProjectInput, type TodoFields, type TodoInput,
} from './changes.ts'
import { mismatches, type Expectation } from './expect.ts'
import { thingsUrl } from './urlscheme.ts'
import type { Project, Status, Todo } from './types.ts'

export type Reader = Lookup & {
  getTodo(id: string): Todo | null
  getProject(id: string): Project | null
}

export type WriterDeps = {
  reader: Reader
  things: ThingsScripts
  openUrl: (url: string) => Promise<void>
  authToken: string
  audit: Audit
  /** Called before each write; `serve` passes one that launches Things if it isn't running. */
  ensureThings?: () => Promise<void>
  now?: () => Date
  pollMs?: number
  timeoutMs?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class Writer {
  private readonly d: Required<WriterDeps>
  private readonly queue = new Queue()

  constructor(deps: WriterDeps) {
    this.d = { ensureThings: async () => {}, now: () => new Date(), pollMs: 100, timeoutMs: 5000, ...deps }
  }

  /** Every write goes through here: one at a time, Things running first. */
  protected run<T>(job: () => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      await this.d.ensureThings()
      return job()
    })
  }

  /** Re-reads until the item matches, or fails with write_not_confirmed. */
  private async confirm<T extends Todo | Project>(read: () => T | null, expect: Expectation, what: string): Promise<T> {
    const deadline = Date.now() + this.d.timeoutMs
    for (;;) {
      const item = read()
      if (item && mismatches(item, expect).length === 0) return item
      if (Date.now() >= deadline) {
        const still = item ? mismatches(item, expect).join(', ') : 'the item itself'
        throw new ApiError(503, 'write_not_confirmed',
          `Things didn't confirm ${what} within ${this.d.timeoutMs / 1000} s (still different: ${still}). ` +
          'On the Mac, run `node src/cli.ts doctor`.')
      }
      await sleep(this.d.pollMs)
    }
  }

  private async apply<T extends Todo | Project>(
    kind: 'todo' | 'project', id: string, plan: ChangePlan, read: () => T | null, what: string,
  ): Promise<T> {
    const command = kind === 'todo' ? 'update' : 'update-project'
    if (plan.clearReminderFirst) {
      await this.d.openUrl(thingsUrl(command, id, { when: 'anytime' }, this.d.authToken))
      await this.confirm(read, { when: null, reminder: null }, 'clearing the reminder')
    }
    if (plan.toInbox) await this.d.things.moveToInbox(id)
    if (plan.tags) await this.d.things.setTags(kind, id, plan.tags)
    if (Object.keys(plan.url).length) {
      await this.d.openUrl(thingsUrl(command, id, plan.url, this.d.authToken))
    }
    return this.confirm(read, plan.expect, what)
  }

  /** Runs one write and audits it, failures included. A failed create names the item it left behind. */
  private async audited<T extends Todo | Project>(
    op: string, id: string, before: T | null, read: () => T | null, work: () => Promise<T>,
  ): Promise<T> {
    try {
      const after = await work()
      this.d.audit({ op, id, before, after })
      return after
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.d.audit({ op, id, before, after: read(), error: message })
      if (before === null && err instanceof ApiError) {
        throw new ApiError(err.status, err.code,
          `The new item was created in Things (id ${id}), but not every detail was applied. ${message} ` +
          "Don't create it again; finish it using its id.")
      }
      throw err
    }
  }

  private existingTodo(id: string): Todo {
    const todo = this.d.reader.getTodo(id)
    if (todo) return todo
    const kind = this.d.reader.kindOf(id)
    if (kind === 'template') {
      throw new ApiError(409, 'repeating_not_supported',
        "That's the template of a repeating to-do; MuseThings can't change repeat rules. Change the current copy instead.")
    }
    if (kind === 'project') throw notFound(`${id} is a project, not a to-do; use /projects/${id}`)
    throw notFound(`No to-do with id ${id}`)
  }

  private readTodo(id: string) {
    return () => this.d.reader.getTodo(id)
  }

  private readProject(id: string) {
    return () => this.d.reader.getProject(id)
  }

  createTodo(input: TodoInput): Promise<Todo> {
    return this.run(async () => {
      const plan = planTodoChange(input, null, this.d.reader, this.d.now())
      delete plan.url.title // AppleScript sets the title when it creates the to-do
      const id = await this.d.things.createTodo(input.title)
      const read = this.readTodo(id)
      return this.audited('create_todo', id, null, read, () => this.apply('todo', id, plan, read, 'the new to-do'))
    })
  }

  updateTodo(id: string, fields: TodoFields): Promise<Todo> {
    return this.run(async () => {
      const before = this.existingTodo(id)
      const plan = planTodoChange(fields, before, this.d.reader, this.d.now())
      const read = this.readTodo(id)
      return this.audited('update_todo', id, before, read, () => this.apply('todo', id, plan, read, 'the change'))
    })
  }

  setTodoStatus(id: string, action: 'complete' | 'cancel' | 'reopen'): Promise<Todo> {
    return this.run(async () => {
      const before = this.existingTodo(id)
      const target: Status = action === 'complete' ? 'completed' : action === 'cancel' ? 'canceled' : 'open'
      if (before.status === target) return before
      const url: Record<string, boolean> =
        action === 'complete' ? { completed: true }
        : action === 'cancel' ? { canceled: true }
        : before.status === 'canceled' ? { canceled: false }
        : { completed: false }
      const plan: ChangePlan = { url, tags: null, toInbox: false, expect: { status: target } }
      const read = this.readTodo(id)
      return this.audited(`${action}_todo`, id, before, read,
        () => this.apply('todo', id, plan, read, `the to-do as ${target}`))
    })
  }

  trashTodo(id: string): Promise<Todo> {
    return this.run(async () => {
      const before = this.existingTodo(id)
      if (before.list === 'trash') return before
      const read = this.readTodo(id)
      return this.audited('trash_todo', id, before, read, async () => {
        await this.d.things.trashTodo(id)
        return this.confirm(read, { lists: ['trash'] }, 'the move to Trash')
      })
    })
  }

  private existingProject(id: string): Project {
    const project = this.d.reader.getProject(id)
    if (project) return project
    if (this.d.reader.kindOf(id) === 'todo') throw notFound(`${id} is a to-do, not a project; use /todos/${id}`)
    throw notFound(`No project with id ${id}`)
  }

  createProject(input: ProjectInput): Promise<Project> {
    return this.run(async () => {
      const { todos = [], ...fields } = input
      const plan = planProjectChange(fields, null, this.d.reader, this.d.now())
      for (const t of todos) checkTitle(t)
      delete plan.url.title // AppleScript sets the title when it creates the project
      const id = await this.d.things.createProject(input.title, todos)
      const read = this.readProject(id)
      return this.audited('create_project', id, null, read, () => this.apply('project', id, plan, read, 'the new project'))
    })
  }

  updateProject(id: string, fields: ProjectFields): Promise<Project> {
    return this.run(async () => {
      const before = this.existingProject(id)
      const plan = planProjectChange(fields, before, this.d.reader, this.d.now())
      const read = this.readProject(id)
      return this.audited('update_project', id, before, read, () => this.apply('project', id, plan, read, 'the change'))
    })
  }

  setProjectStatus(id: string, action: 'complete' | 'cancel'): Promise<Project> {
    return this.run(async () => {
      const before = this.existingProject(id)
      const target: Status = action === 'complete' ? 'completed' : 'canceled'
      if (before.status === target) return before
      const url: Record<string, boolean> = action === 'complete' ? { completed: true } : { canceled: true }
      const plan: ChangePlan = { url, tags: null, toInbox: false, expect: { status: target } }
      const read = this.readProject(id)
      return this.audited(`${action}_project`, id, before, read,
        () => this.apply('project', id, plan, read, `the project as ${target}`))
    })
  }

  trashProject(id: string): Promise<Project> {
    return this.run(async () => {
      const before = this.existingProject(id)
      if (before.list === 'trash') return before
      const read = this.readProject(id)
      return this.audited('trash_project', id, before, read, async () => {
        await this.d.things.trashProject(id)
        return this.confirm(read, { lists: ['trash'] }, 'the move to Trash')
      })
    })
  }
}
