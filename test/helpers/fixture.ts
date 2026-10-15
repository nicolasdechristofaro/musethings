import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCHEMA = fs.readFileSync(new URL('../fixtures/things-schema.sql', import.meta.url), 'utf8')

type Value = string | number | null | Uint8Array

export type TaskRow = {
  uuid: string
  type?: number
  status?: number
  trashed?: number
  title?: string
  notes?: string
  start?: number
  startDate?: number | null
  startBucket?: number
  reminderTime?: number | null
  deadline?: number | null
  deadlineSuppressionDate?: number | null
  index?: number
  todayIndex?: number
  area?: string | null
  project?: string | null
  heading?: string | null
  creationDate?: number
  userModificationDate?: number
  stopDate?: number | null
  rt1_repeatingTemplate?: string | null
  rt1_recurrenceRule?: Uint8Array | null
  repeater?: Uint8Array | null
}

const TASK_DEFAULTS: Omit<TaskRow, 'uuid'> = {
  type: 0, status: 0, trashed: 0, title: '', notes: '', start: 1, startDate: null, startBucket: 0,
  reminderTime: null, deadline: null, deadlineSuppressionDate: null, index: 0, todayIndex: 0, area: null, project: null, heading: null,
  creationDate: 1760000000, userModificationDate: 1760000000, stopDate: null,
  rt1_repeatingTemplate: null, rt1_recurrenceRule: null, repeater: null,
}

/** A throwaway Things database with the real schema and synthetic rows. */
export class Fixture {
  readonly path: string
  readonly db: DatabaseSync

  constructor() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-db-'))
    this.path = path.join(dir, 'main.sqlite')
    this.db = new DatabaseSync(this.path)
    this.db.exec(SCHEMA)
  }

  private insert(table: string, row: Record<string, Value | undefined>) {
    const cols = Object.keys(row)
    const sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    this.db.prepare(sql).run(...cols.map((c) => row[c] ?? null))
  }

  task(row: TaskRow): this {
    this.insert('TMTask', { ...TASK_DEFAULTS, ...row })
    return this
  }

  set(uuid: string, fields: Partial<TaskRow>): this {
    const cols = Object.keys(fields)
    const values = cols.map((c) => (fields as Record<string, Value | undefined>)[c] ?? null)
    this.db.prepare(`UPDATE TMTask SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE uuid = ?`).run(...values, uuid)
    return this
  }

  area(uuid: string, title: string, index = 0): this {
    this.insert('TMArea', { uuid, title, visible: 1, index })
    return this
  }

  tag(uuid: string, title: string, parent: string | null = null, index = 0): this {
    this.insert('TMTag', { uuid, title, parent, index })
    return this
  }

  tagTask(task: string, tag: string): this {
    this.insert('TMTaskTag', { tasks: task, tags: tag })
    return this
  }

  tagArea(area: string, tag: string): this {
    this.insert('TMAreaTag', { areas: area, tags: tag })
    return this
  }

  checklist(uuid: string, task: string, title: string, done = false, index = 0): this {
    this.insert('TMChecklistItem', { uuid, task, title, status: done ? 3 : 0, index })
    return this
  }

  close() {
    this.db.close()
  }
}
