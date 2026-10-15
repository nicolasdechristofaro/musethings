import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiError } from '../errors.ts'
import { isoDateToUnix, packDate, todayIso } from './dates.ts'
import { toTodo, type TaskRow } from './map.ts'
import type { ChecklistItem, Kind, ReadableList, Todo } from './types.ts'

const GROUP_CONTAINER = 'Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac'

export function findDbPath(home: string = os.homedir()): string {
  const base = path.join(home, GROUP_CONTAINER)
  let dirs: string[]
  try {
    dirs = fs.readdirSync(base).filter((d) => d.startsWith('ThingsData-'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      throw new ApiError(503, 'setup_required', `macOS blocked access to Things' data at ${base}. Allow it in System Settings → Privacy & Security, then restart MuseThings.`)
    }
    throw new ApiError(503, 'setup_required', `Things database not found under ${base}. Install Things 3 and open it once.`)
  }
  for (const d of dirs) {
    const file = path.join(base, d, 'Things Database.thingsdatabase', 'main.sqlite')
    if (fs.existsSync(file)) return file
  }
  throw new ApiError(503, 'setup_required', `Things database not found under ${base}. Install Things 3 and open it once.`)
}

/** Joins every task query uses. `t` is the to-do; `h`, `p`, `a` its heading, project, area. */
export const TASK_SELECT = `
  SELECT t.uuid, t.title, t.notes, t.status, t.trashed, t.start, t.startDate, t.startBucket,
         t.reminderTime, t.deadline, t.creationDate, t.userModificationDate, t.stopDate,
         t.rt1_repeatingTemplate,
         h.uuid AS headingId, h.title AS headingTitle,
         p.uuid AS projectId, p.title AS projectTitle,
         a.uuid AS areaId, a.title AS areaTitle
  FROM TMTask t
  LEFT JOIN TMTask h ON h.uuid = t.heading
  LEFT JOIN TMTask p ON p.uuid = COALESCE(t.project, h.project)
  LEFT JOIN TMArea a ON a.uuid = COALESCE(t.area, p.area)`

const NOT_TEMPLATE = 't.rt1_recurrenceRule IS NULL AND t.repeater IS NULL'
/** Open, visible to-dos: not trashed, not a template, parent project/heading still open. */
export const OPEN_TODO = `t.type = 0 AND t.status = 0 AND t.trashed = 0 AND ${NOT_TEMPLATE}
  AND (p.uuid IS NULL OR (p.trashed = 0 AND p.status = 0))
  AND (h.uuid IS NULL OR h.trashed = 0)`

const LIST_SQL: Record<Exclude<ReadableList, 'logbook'>, string> = {
  inbox: `${OPEN_TODO} AND t.start = 0 ORDER BY t."index"`,
  today: `${OPEN_TODO} AND t.start IN (1, 2) AND t.startDate IS NOT NULL AND t.startDate <= ?
          ORDER BY t.startBucket, t.todayIndex, t."index"`,
  upcoming: `${OPEN_TODO} AND t.start IN (1, 2) AND t.startDate > ? ORDER BY t.startDate, t.todayIndex`,
  anytime: `${OPEN_TODO} AND t.start = 1 AND (t.startDate IS NULL OR t.startDate <= ?)
            AND (p.uuid IS NULL OR p.start = 1) ORDER BY t."index"`,
  someday: `${OPEN_TODO} AND t.start = 2 AND t.startDate IS NULL ORDER BY t."index"`,
}

export class ThingsDb {
  private readonly db: DatabaseSync
  private readonly now: () => Date

  constructor(file: string, now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(file, { readOnly: true, timeout: 1000 })
    this.now = now
  }

  protected today(): number {
    return packDate(todayIso(this.now()))
  }

  /** Runs a query; turns "database is locked" into a 503 the API can return. */
  protected all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    try {
      return this.db.prepare(sql).all(...params) as T[]
    } catch (err) {
      if (/locked|busy/i.test(String((err as Error).message))) {
        throw new ApiError(503, 'things_unavailable', 'The Things database is busy. Try again in a moment.')
      }
      throw err
    }
  }

  protected hydrate(rows: TaskRow[]): Todo[] {
    const today = this.today()
    return rows.map((r) => toTodo(r, this.tagsOf(r.uuid), this.checklistOf(r.uuid), today))
  }

  protected tagsOf(taskId: string): string[] {
    return this.all<{ title: string }>(
      `SELECT g.title FROM TMTaskTag tt JOIN TMTag g ON g.uuid = tt.tags WHERE tt.tasks = ? ORDER BY g."index"`,
      taskId,
    ).map((r) => r.title)
  }

  private checklistOf(taskId: string): ChecklistItem[] {
    return this.all<{ uuid: string; title: string; status: number }>(
      `SELECT uuid, title, status FROM TMChecklistItem WHERE task = ? ORDER BY "index"`,
      taskId,
    ).map((r) => ({ id: r.uuid, title: r.title ?? '', done: r.status === 3 }))
  }

  listTodos(list: ReadableList, opts: { limit?: number; since?: string } = {}): Todo[] {
    const limit = Math.min(opts.limit ?? 100, 500)
    if (list === 'logbook') {
      const since = opts.since ? isoDateToUnix(opts.since) : 0
      return this.hydrate(this.all<TaskRow>(
        `${TASK_SELECT} WHERE t.type = 0 AND t.status IN (2, 3) AND t.trashed = 0 AND ${NOT_TEMPLATE}
         AND COALESCE(t.stopDate, 0) >= ? ORDER BY t.stopDate DESC LIMIT ?`,
        since, limit,
      ))
    }
    const sql = `${TASK_SELECT} WHERE ${LIST_SQL[list]} LIMIT ?`
    const params: SQLInputValue[] = LIST_SQL[list].includes('?') ? [this.today(), limit] : [limit]
    return this.hydrate(this.all<TaskRow>(sql, ...params))
  }

  /** Any to-do by id, in any list or state; null for projects, headings, templates and unknown ids. */
  getTodo(id: string): Todo | null {
    const rows = this.all<TaskRow>(`${TASK_SELECT} WHERE t.uuid = ? AND t.type = 0 AND ${NOT_TEMPLATE}`, id)
    return rows.length ? this.hydrate(rows)[0] : null
  }

  kindOf(id: string): Kind | null {
    const [row] = this.all<{ type: number; template: number }>(
      `SELECT type, (rt1_recurrenceRule IS NOT NULL OR repeater IS NOT NULL) AS template FROM TMTask WHERE uuid = ?`,
      id,
    )
    if (!row) return null
    if (row.template) return 'template'
    return row.type === 0 ? 'todo' : row.type === 1 ? 'project' : row.type === 2 ? 'heading' : null
  }

  close() {
    this.db.close()
  }
}
