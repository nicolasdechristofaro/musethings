import { ApiError, notFound } from '../errors.ts'
import type { Audit } from '../audit.ts'
import { Queue } from '../queue.ts'
import type { ThingsScripts } from './applescript.ts'
import { planTodoChange, type ChangePlan, type Lookup, type TodoFields, type TodoInput } from './changes.ts'
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
    if (plan.toInbox) await this.d.things.moveToInbox(id)
    if (plan.tags) await this.d.things.setTags(kind, id, plan.tags)
    if (Object.keys(plan.url).length) {
      await this.d.openUrl(thingsUrl(kind === 'todo' ? 'update' : 'update-project', id, plan.url, this.d.authToken))
    }
    return this.confirm(read, plan.expect, what)
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

  createTodo(input: TodoInput): Promise<Todo> {
    return this.run(async () => {
      const plan = planTodoChange(input, null, this.d.reader, this.d.now())
      delete plan.url.title // AppleScript sets the title when it creates the to-do
      const id = await this.d.things.createTodo(input.title)
      const after = await this.apply('todo', id, plan, () => this.d.reader.getTodo(id), 'the new to-do')
      this.d.audit({ op: 'create_todo', id, before: null, after })
      return after
    })
  }

  updateTodo(id: string, fields: TodoFields): Promise<Todo> {
    return this.run(async () => {
      const before = this.existingTodo(id)
      const plan = planTodoChange(fields, before, this.d.reader, this.d.now())
      const after = await this.apply('todo', id, plan, () => this.d.reader.getTodo(id), 'the change')
      this.d.audit({ op: 'update_todo', id, before, after })
      return after
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
      const after = await this.apply('todo', id, plan, () => this.d.reader.getTodo(id), `the to-do as ${target}`)
      this.d.audit({ op: `${action}_todo`, id, before, after })
      return after
    })
  }

  trashTodo(id: string): Promise<Todo> {
    return this.run(async () => {
      const before = this.existingTodo(id)
      if (before.list === 'trash') return before
      await this.d.things.trashTodo(id)
      const after = await this.confirm(() => this.d.reader.getTodo(id), { lists: ['trash'] }, 'the move to Trash')
      this.d.audit({ op: 'trash_todo', id, before, after })
      return after
    })
  }
}
