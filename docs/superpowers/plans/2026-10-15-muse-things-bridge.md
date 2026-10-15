# MuseThings Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A small HTTPS API on an always-on Mac that lets Meta's Muse agent read and fully manage Things 3 through a custom connector.

**Architecture:** A Node 24 + Fastify server bound to `127.0.0.1:8787`, published by Tailscale Funnel. Reads query Things' SQLite database opened read-only (`node:sqlite`). Writes go through Things itself: AppleScript (values passed as `argv`) to create and trash items, move them to the Inbox and set tags, and the `things:///update` URL scheme (with Things' auth token) for every other field. Each write is serialized, checked by re-reading the database until the change shows up, and appended to an audit log.

**Tech Stack:** Node ≥ 24 (built-in TypeScript type stripping, `node:sqlite`), TypeScript (type checking only, no build step), Fastify 5, @fastify/swagger 9, vitest 3, `osascript`, macOS `open`, Tailscale Funnel, launchd.

**Spec:** `docs/superpowers/specs/2026-10-15-muse-things-bridge-design.md`

## Global Constraints

- **No git yet.** Nicolas asked for no repo and no commits until he says so. Every task ends with a **Checkpoint** (full test run + typecheck) instead of a commit. Once he approves git, commit after each checkpoint.
- Node **≥ 24**, run TypeScript directly (`node src/cli.ts`). Use only erasable TS syntax: no `enum`, no `namespace`, no constructor parameter properties. Relative imports end in `.ts`.
- Runtime dependencies: only `fastify@5` and `@fastify/swagger@9`. Dev: `typescript@5`, `vitest@3`, `@types/node@24`. No native modules.
- The Things database is opened **read-only**, always. Nothing in MuseThings writes to it.
- **User text never goes into AppleScript source.** Scripts are fixed strings; values arrive as `argv` (`on run argv`). URL-scheme values go through `encodeURIComponent`.
- Server binds `127.0.0.1`, default port `8787`. Only Funnel reaches it.
- API key: 32 random bytes, base64url. Store only its SHA-256 hex. Compare in constant time.
- Every endpoint except `GET /health` and `GET /openapi.json` requires `Authorization: Bearer <key>`. (`/openapi.json` holds no data; Muse reads it to build the connector.)
- Body limit 64 KB. Title ≤ 4,000 characters, notes ≤ 10,000, checklist ≤ 100 items, tag names may not contain commas.
- Every error response is `{"error": {"code", "message"}}`. Codes: `unauthorized` 401, `too_many_requests` 429, `invalid_request` 400, `not_found` 404, `repeating_not_supported` 409, `things_unavailable` 503, `setup_required` 503, `write_not_confirmed` 503, `internal` 500.
- MuseThings' own files live in `~/.musethings/` (override with `MUSETHINGS_HOME`): directory 0700, files 0600.
- Dates are `YYYY-MM-DD` in the Mac's local timezone; times `HH:MM` 24-hour; timestamps ISO 8601 UTC.
- Operation sensitivity goes in OpenAPI `tags`: exactly one of `read`, `write`, `sensitive`.

## Review Focus

Inputs and conditions the spec implies but the feature tests don't naturally hit, most likely to bite first. Each has a pinned test in the task named.

1. **Text that looks like code**: quotes, backslashes, newlines, emoji, `" & (do shell script "…") & "` in a title or notes must be stored exactly as typed, never executed. Pinned in Task 5 (argv) and Task 6 (URL encoding).
2. **"Today" near midnight**: "today", "tomorrow" and the Today list follow the Mac's local date, not UTC. 5:30 UTC is still yesterday in Los Angeles. Pinned in Task 2.
3. **To-dos under a heading**: Things stores them with an empty `project` column; the API must still report their project and area. Pinned in Task 3.
4. **Things doesn't apply a change** (wrong auth token, Things showing a dialog, Things hung): the request must fail with `write_not_confirmed` within a few seconds, not hang and not report success. Pinned in Task 6.
5. **Two writes at once** (Muse fires requests in parallel): both must apply, one after the other, each confirmed. Pinned in Task 6.

## File Structure

```
MuseThings/
  package.json, tsconfig.json, vitest.config.ts, .gitignore
  src/
    errors.ts            ApiError + helpers; the only place error codes are defined
    config.ts            ~/.musethings/config.json read/write/validate
    things/
      types.ts           API object types (Todo, Project, Area, Tag, ListName…)
      dates.ts           Things packed dates/times ⇄ ISO; local "today"
      map.ts             DB row → API object (list derivation, status names)
      db.ts              ThingsDb: find + open DB read-only, all read queries
      system.ts          process boundary: run osascript, open URLs, pgrep
      applescript.ts     fixed AppleScript templates + typed wrappers (argv only)
      urlscheme.ts       build things:/// URLs with the auth token
      changes.ts         validate a write and plan it: URL params, tags, Inbox move, expectation
      writer.ts          to-do + project writes: serialize, apply through Things, confirm, audit
      expect.ts          "has Things applied this yet?" matchers used by writer
    queue.ts             one-at-a-time async queue
    audit.ts             append-only audit.jsonl
    auth.ts              bearer check + bad-key throttle
    server/
      app.ts             buildApp(): Fastify instance, error handler, auth hook, swagger
      schemas.ts         JSON schemas shared by routes and OpenAPI
      read-routes.ts     GET routes
      write-routes.ts    POST/PATCH/DELETE routes
    doctor.ts            setup checks used by `doctor`
    cli.ts               serve | keygen | config set | doctor
  launchd/app.musethings.plist.template
  scripts/install-agent.sh
  test/
    fixtures/things-schema.sql   real Things table DDL, no data
    helpers/fixture.ts           builds a throwaway Things DB with synthetic rows
    helpers/fake-things.ts       plays Things for writer tests (applies scripts/URLs to a fixture)
    *.test.ts                    unit + route tests
    live/live.test.ts            real Things, opt-in (MUSETHINGS_LIVE=1)
  docs/muse-connector.md         what to tell Muse
  README.md                      spare-Mac setup checklist
```

---

### Task 1: Project setup, errors and config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/errors.ts`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `class ApiError extends Error { status: number; code: ErrorCode }`, `type ErrorCode`, `invalid(message): ApiError` (400), `notFound(message): ApiError` (404)
  - `type Config = { port: number; thingsAuthToken: string; keyHash: string; publicUrl: string; timezone: string }`
  - `homeDir(): string`, `readConfig(dir?): Config`, `writeConfig(cfg, dir?): void`, `setConfigValue(key, value, dir?): Config`, `loadServeConfig(dir?): Config`

- [ ] **Step 1: Create the project and install dependencies**

```bash
cd ~/Projects/MuseThings
node -v   # must print v24.x; if not: nvm use 24
cat > package.json <<'EOF'
{
  "name": "musethings",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "serve": "node src/cli.ts serve",
    "test": "vitest run",
    "test:live": "MUSETHINGS_LIVE=1 vitest run test/live",
    "typecheck": "tsc"
  }
}
EOF
npm install fastify@5 @fastify/swagger@9
npm install -D typescript@5 vitest@3 @types/node@24
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], pool: 'forks' },
})
```

`.gitignore`:

```
node_modules/
```

- [ ] **Step 2: Write the failing config test**

`test/config.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readConfig, writeConfig, setConfigValue, loadServeConfig, DEFAULTS } from '../src/config.ts'

let dir: string
beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-cfg-')), 'home')
})

describe('config', () => {
  it('returns defaults when no file exists', () => {
    expect(readConfig(dir)).toEqual(DEFAULTS)
    expect(DEFAULTS.port).toBe(8787)
  })

  it('writes the file owner-only and reads it back', () => {
    writeConfig({ ...DEFAULTS, publicUrl: 'https://x.ts.net' }, dir)
    const file = path.join(dir, 'config.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(readConfig(dir).publicUrl).toBe('https://x.ts.net')
  })

  it('sets known keys and validates port', () => {
    expect(setConfigValue('thingsAuthToken', 'tok', dir).thingsAuthToken).toBe('tok')
    expect(setConfigValue('port', '9000', dir).port).toBe(9000)
    expect(() => setConfigValue('port', '0', dir)).toThrow('port must be 1–65535')
    expect(() => setConfigValue('keyHash', 'x', dir)).toThrow('Unknown setting "keyHash"')
  })

  it('serve config names everything missing', () => {
    expect(() => loadServeConfig(dir)).toThrow(/API key.*Things auth token/)
    writeConfig({ ...DEFAULTS, keyHash: 'h', thingsAuthToken: 't' }, dir)
    expect(loadServeConfig(dir).keyHash).toBe('h')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, cannot find `../src/config.ts`.

- [ ] **Step 4: Implement errors and config**

`src/errors.ts`:

```ts
export type ErrorCode =
  | 'unauthorized'
  | 'too_many_requests'
  | 'invalid_request'
  | 'not_found'
  | 'repeating_not_supported'
  | 'things_unavailable'
  | 'setup_required'
  | 'write_not_confirmed'
  | 'internal'

export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode

  constructor(status: number, code: ErrorCode, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const invalid = (message: string) => new ApiError(400, 'invalid_request', message)
export const notFound = (message: string) => new ApiError(404, 'not_found', message)
```

`src/config.ts`:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type Config = {
  port: number
  thingsAuthToken: string
  keyHash: string
  publicUrl: string
  timezone: string
}

export const DEFAULTS: Config = { port: 8787, thingsAuthToken: '', keyHash: '', publicUrl: '', timezone: '' }

const SETTABLE = ['port', 'thingsAuthToken', 'publicUrl', 'timezone'] as const
type TextKey = Exclude<(typeof SETTABLE)[number], 'port'>

export function homeDir(): string {
  return process.env.MUSETHINGS_HOME ?? path.join(os.homedir(), '.musethings')
}

const configPath = (dir: string) => path.join(dir, 'config.json')

export function readConfig(dir = homeDir()): Config {
  const file = configPath(dir)
  if (!fs.existsSync(file)) return { ...DEFAULTS }
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
}

export function writeConfig(cfg: Config, dir = homeDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(configPath(dir), 0o600)
}

export function setConfigValue(key: string, value: string, dir = homeDir()): Config {
  if (!(SETTABLE as readonly string[]).includes(key)) {
    throw new Error(`Unknown setting "${key}". Settable: ${SETTABLE.join(', ')}`)
  }
  const cfg = readConfig(dir)
  if (key === 'port') {
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1–65535')
    cfg.port = port
  } else {
    cfg[key as TextKey] = value
  }
  writeConfig(cfg, dir)
  return cfg
}

/** The config `serve` needs. Throws one error naming everything missing. */
export function loadServeConfig(dir = homeDir()): Config {
  const cfg = readConfig(dir)
  const missing: string[] = []
  if (!cfg.keyHash) missing.push('API key (run: node src/cli.ts keygen)')
  if (!cfg.thingsAuthToken) {
    missing.push('Things auth token (run: node src/cli.ts config set thingsAuthToken <token>)')
  }
  if (missing.length) throw new Error(`MuseThings isn't set up: missing ${missing.join('; ')}`)
  return cfg
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Checkpoint**

Run: `npm test && npm run typecheck`
Expected: all tests pass, `tsc` prints nothing.

---

### Task 2: Things dates and times

Things stores start dates and deadlines as packed integers `year<<16 | month<<12 | day<<7`, reminder times as `hour<<26 | minute<<20`, and creation/modification/completion times as Unix seconds (REAL). All three were confirmed against a real Things database on 2026-10-15.

**Files:**
- Create: `src/things/dates.ts`
- Test: `test/dates.test.ts`

**Interfaces:**
- Produces: `packDate(iso: string): number`, `unpackDate(n: number | null | undefined): string | null`, `packTime(hhmm: string): number`, `unpackTime(n: number | null | undefined): string | null`, `unixToIso(s: number | null | undefined): string | null`, `isoDateToUnix(iso: string): number` (local midnight), `localIsoDate(d: Date): string`, `todayIso(now?: Date): string`, `addDays(iso: string, n: number): string`, `isIsoDate(s: string): boolean`, `isTime(s: string): boolean`

- [ ] **Step 1: Write the failing test**

`test/dates.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import {
  packDate, unpackDate, packTime, unpackTime, unixToIso, isoDateToUnix,
  localIsoDate, todayIso, addDays, isIsoDate, isTime,
} from '../src/things/dates.ts'

const originalTz = process.env.TZ
afterEach(() => { process.env.TZ = originalTz })

describe('packed dates', () => {
  it('matches a value read from a real Things database', () => {
    expect(unpackDate(132818688)).toBe('2026-10-14')
    expect(packDate('2026-10-14')).toBe(132818688)
  })

  it('round-trips year, month and day edges', () => {
    for (const iso of ['2026-01-01', '2026-12-31', '2028-02-29', '2099-09-30']) {
      expect(unpackDate(packDate(iso))).toBe(iso)
    }
  })

  it('treats null and 0 as no date', () => {
    expect(unpackDate(null)).toBeNull()
    expect(unpackDate(0)).toBeNull()
  })
})

describe('packed times', () => {
  it('matches a value read from a real Things database', () => {
    expect(unpackTime(1543503872)).toBe('23:00')
  })

  it('round-trips', () => {
    for (const t of ['00:00', '09:30', '18:05', '23:59']) expect(unpackTime(packTime(t))).toBe(t)
    expect(unpackTime(null)).toBeNull()
  })
})

describe('local dates', () => {
  it('uses the Mac timezone, not UTC, for today (Review Focus 2)', () => {
    process.env.TZ = 'America/Los_Angeles'
    const earlyUtc = new Date('2026-10-15T05:30:00Z') // 22:30 on the 14th in LA
    expect(todayIso(earlyUtc)).toBe('2026-10-14')
    expect(localIsoDate(earlyUtc)).toBe('2026-10-14')
    expect(addDays(todayIso(earlyUtc), 1)).toBe('2026-10-15')
  })

  it('adds days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('converts Unix seconds and local midnight', () => {
    expect(unixToIso(1760000000)).toBe('2025-10-09T08:53:20.000Z')
    expect(unixToIso(null)).toBeNull()
    process.env.TZ = 'UTC'
    expect(isoDateToUnix('2026-10-15')).toBe(Date.UTC(2026, 9, 15) / 1000)
  })
})

describe('validation', () => {
  it('accepts only real calendar dates', () => {
    expect(isIsoDate('2026-10-15')).toBe(true)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('2026-1-5')).toBe(false)
    expect(isIsoDate('tomorrow')).toBe(false)
  })

  it('accepts only HH:MM 24-hour times', () => {
    expect(isTime('09:30')).toBe(true)
    expect(isTime('24:00')).toBe(false)
    expect(isTime('9:30')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/dates.test.ts`
Expected: FAIL, cannot find `../src/things/dates.ts`.

- [ ] **Step 3: Implement**

`src/things/dates.ts`:

```ts
const pad = (n: number) => String(n).padStart(2, '0')

export function packDate(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return (y << 16) | (m << 12) | (d << 7)
}

export function unpackDate(n: number | null | undefined): string | null {
  if (!n) return null
  return `${n >> 16}-${pad((n >> 12) & 0xf)}-${pad((n >> 7) & 0x1f)}`
}

export function packTime(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h << 26) | (m << 20)
}

export function unpackTime(n: number | null | undefined): string | null {
  if (n == null) return null
  return `${pad((n >> 26) & 0x1f)}:${pad((n >> 20) & 0x3f)}`
}

export function unixToIso(s: number | null | undefined): string | null {
  return s == null ? null : new Date(s * 1000).toISOString()
}

/** Local midnight of an ISO date, as Unix seconds. */
export function isoDateToUnix(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).getTime() / 1000
}

export function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function todayIso(now: Date = new Date()): string {
  return localIsoDate(now)
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return localIsoDate(new Date(y, m - 1, d + n))
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  return localIsoDate(new Date(y, m - 1, d)) === s
}

export function isTime(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/dates.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck`
Expected: all pass, no type errors.

---

### Task 3: Read to-dos from the Things database (lists and single to-do)

How Things' `TMTask` table works (from things.py and checked against a real database):
- `type`: 0 to-do, 1 project, 2 heading. Other values exist (a real database has `4003`); ignore them.
- `status`: 0 open, 2 canceled, 3 completed. `trashed`: 1 if in Trash.
- `start`: 0 Inbox, 1 Anytime, 2 Someday. `startDate`: packed date or NULL. `startBucket`: 1 = This Evening.
- A to-do under a heading has `heading` set and **`project` NULL**; its project is the heading's `project` (Review Focus 3). Its area is its own `area` or its project's.
- Repeating: a template has `rt1_recurrenceRule` or `repeater` set (Things moved between the two; check both). Instances point at their template via `rt1_repeatingTemplate`. Templates never appear in lists.
- Tags: `TMTaskTag(tasks, tags)` → `TMTag(uuid, title, parent, "index")`. Checklist: `TMChecklistItem(task, title, status, "index")`, status 3 = done.
- `index` is an SQL keyword; always quote it: `"index"`.

List rules (things.py's, adjusted for the spec):
- **inbox**: open, `start = 0`, by `"index"`.
- **today**: open, `start IN (1,2)`, `startDate <= today`, by `startBucket, todayIndex, "index"` (evening last). Includes scheduled to-dos Things hasn't moved yet (`start = 2` with a past date) and overdue ones.
- **upcoming**: open, `start IN (1,2)`, `startDate > today`, by `startDate, todayIndex`.
- **anytime**: open, `start = 1`, no date or a date ≤ today, project (if any) not Someday, by `"index"`.
- **someday**: open, `start = 2`, no `startDate`, by `"index"`.
- **logbook**: completed or canceled, not trashed, newest `stopDate` first, optional `since`.
- Every list except logbook drops to-dos whose project or heading is trashed or closed.

**Files:**
- Create: `src/things/types.ts`, `src/things/map.ts`, `src/things/db.ts`, `test/fixtures/things-schema.sql`, `test/helpers/fixture.ts`
- Test: `test/db-lists.test.ts`

**Interfaces:**
- Consumes: `packDate`, `unpackDate`, `unpackTime`, `unixToIso`, `isoDateToUnix`, `todayIso` (Task 2); `ApiError` (Task 1)
- Produces:
  - Types (`src/things/types.ts`): `ListName`, `ReadableList`, `Status`, `Ref`, `ChecklistItem`, `Todo`, `Project`, `ProjectDetail`, `Area`, `AreaDetail`, `Tag`, `Kind`
  - `findDbPath(home?: string): string`
  - `class ThingsDb { constructor(file: string, now?: () => Date); listTodos(list: ReadableList, opts?: { limit?: number; since?: string }): Todo[]; getTodo(id: string): Todo | null; kindOf(id: string): Kind | null; close(): void }`. Task 4 adds the rest.
  - Test helper `class Fixture { path; db; task(row): this; area(uuid, title, index?): this; tag(uuid, title, parent?, index?): this; tagTask(task, tag): this; tagArea(area, tag): this; checklist(uuid, task, title, done?, index?): this; set(uuid, fields): this; close(): void }`

- [ ] **Step 1: Add the real schema as a fixture**

`test/fixtures/things-schema.sql` holds the six tables MuseThings reads, column for column as in Things 3.22 (taken from a real database on 2026-10-15; Task 4's drift test keeps it honest):

```sql
CREATE TABLE TMTask (
  "uuid" TEXT PRIMARY KEY, "leavesTombstone" INTEGER, "creationDate" REAL, "userModificationDate" REAL,
  "type" INTEGER, "status" INTEGER, "stopDate" REAL, "trashed" INTEGER, "title" TEXT, "notes" TEXT,
  "notesSync" INTEGER, "cachedTags" BLOB, "start" INTEGER, "startDate" INTEGER, "startBucket" INTEGER,
  "reminderTime" INTEGER, "lastReminderInteractionDate" REAL, "deadline" INTEGER,
  "deadlineSuppressionDate" INTEGER, "t2_deadlineOffset" INTEGER, "index" INTEGER, "todayIndex" INTEGER,
  "todayIndexReferenceDate" INTEGER, "area" TEXT, "project" TEXT, "heading" TEXT, "contact" TEXT,
  "untrashedLeafActionsCount" INTEGER, "openUntrashedLeafActionsCount" INTEGER,
  "checklistItemsCount" INTEGER, "openChecklistItemsCount" INTEGER, "rt1_repeatingTemplate" TEXT,
  "rt1_recurrenceRule" BLOB, "rt1_instanceCreationStartDate" INTEGER, "rt1_instanceCreationPaused" INTEGER,
  "rt1_instanceCreationCount" INTEGER, "rt1_afterCompletionReferenceDate" INTEGER,
  "rt1_nextInstanceStartDate" INTEGER, "experimental" BLOB, "repeater" BLOB, "repeaterMigrationDate" REAL
);
CREATE TABLE TMArea ("uuid" TEXT PRIMARY KEY, "title" TEXT, "visible" INTEGER, "index" INTEGER, "cachedTags" BLOB, "experimental" BLOB);
CREATE TABLE TMTag ("uuid" TEXT PRIMARY KEY, "title" TEXT, "shortcut" TEXT, "usedDate" REAL, "parent" TEXT, "index" INTEGER, "experimental" BLOB);
CREATE TABLE TMTaskTag ("tasks" TEXT NOT NULL, "tags" TEXT NOT NULL);
CREATE TABLE TMAreaTag ("areas" TEXT NOT NULL, "tags" TEXT NOT NULL);
CREATE TABLE TMChecklistItem (
  "uuid" TEXT PRIMARY KEY, "userModificationDate" REAL, "creationDate" REAL, "title" TEXT, "status" INTEGER,
  "stopDate" REAL, "index" INTEGER, "task" TEXT, "leavesTombstone" INTEGER, "experimental" BLOB
);
```

- [ ] **Step 2: Add the fixture builder**

`test/helpers/fixture.ts`:

```ts
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
  reminderTime: null, deadline: null, index: 0, todayIndex: 0, area: null, project: null, heading: null,
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
```

- [ ] **Step 3: Write the failing test**

`test/db-lists.test.ts`:

```ts
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
    expect(ids(db.listTodos('today'))).toEqual(['overdue', 'today1', 'unconfirmed', 'instance1', 'evening1'])
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
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run test/db-lists.test.ts`
Expected: FAIL, cannot find `../src/things/db.ts`.

- [ ] **Step 5: Implement types, mapping and the reader**

`src/things/types.ts`:

```ts
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
```

`src/things/map.ts`:

```ts
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
```

`src/things/db.ts`:

```ts
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
```

`tagsOf`, `all`, `hydrate` and `today` are `protected` because Task 4 adds more queries in the same class.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/db-lists.test.ts`
Expected: PASS (12 tests). If `today` comes back in another order, check the ORDER BY: `startBucket` first (evening last), then `todayIndex`.

- [ ] **Step 7: Checkpoint**

Run: `npm test && npm run typecheck`
Expected: all pass, no type errors.

---

### Task 4: Read search, projects, areas, tags and headings

**Files:**
- Modify: `src/things/db.ts` (new methods inside `class ThingsDb`, new imports, a `TodoFilter` type)
- Create: `test/schema-drift.test.ts`
- Test: `test/db-more.test.ts`

**Interfaces:**
- Consumes: `TASK_SELECT`, `OPEN_TODO`, `ThingsDb` internals `all`, `hydrate`, `tagsOf`, `today` (Task 3); `toTodo`, `TaskRow` (Task 3); `packDate` (Task 2)
- Produces (all on `ThingsDb`):
  - `type TodoFilter = { q?: string; tag?: string; project_id?: string; area_id?: string; deadline_before?: string; status?: Status | 'any'; limit?: number }`
  - `searchTodos(f: TodoFilter): Todo[]`
  - `listProjects(): Project[]`, `getProject(id): Project | null` (any status), `getProjectDetail(id): ProjectDetail | null`
  - `listAreas(): Area[]`, `getArea(id): AreaDetail | null`, `areaExists(id): boolean`
  - `listTags(): Tag[]`
  - `getHeading(id): { id: string; title: string; projectId: string } | null`

- [ ] **Step 1: Write the failing test**

`test/db-more.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { Fixture } from './helpers/fixture.ts'
import { ThingsDb } from '../src/things/db.ts'
import { packDate } from '../src/things/dates.ts'

const NOW = new Date(2026, 9, 15, 12, 0)
let db: ThingsDb
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

beforeAll(() => {
  const f = new Fixture()
  f.area('A1', 'Home', 0)
    .area('A2', 'Work', 1)
    .tag('T1', 'Phone', null, 0)
    .tag('T2', 'family', null, 1)
    .tag('T3', 'urgent', 'T1', 2)
    .tagArea('A1', 'T2')
    .task({ uuid: 'P1', type: 1, title: 'Errands', area: 'A1', index: 0, deadline: packDate('2026-10-20') })
    .task({ uuid: 'P2', type: 1, title: 'Done project', status: 3, stopDate: 1760000000 })
    .task({ uuid: 'P3', type: 1, title: 'Work stuff', area: 'A2', index: 1 })
    .task({ uuid: 'H1', type: 2, title: 'Shops', project: 'P1', index: 0 })
    .task({ uuid: 'H2', type: 2, title: 'Online', project: 'P1', index: 1 })
    .task({ uuid: 'e1', title: 'Buy milk', project: 'P1', index: 0 })
    .task({ uuid: 'e2', title: 'Buy 100% juice', heading: 'H1', index: 1, deadline: packDate('2026-10-18') })
    .task({ uuid: 'e3', title: 'Order printer ink', heading: 'H2', index: 2 })
    .task({ uuid: 'e4', title: 'Done errand', project: 'P1', status: 3, stopDate: 1760000000 })
    .task({ uuid: 'w1', title: 'Email Sam', area: 'A2' })
    .task({ uuid: 'w2', title: 'Prep deck', notes: 'for the 50_50 review', project: 'P3' })
    .task({ uuid: 'h1', title: 'Fix sink', area: 'A1', deadline: packDate('2026-10-16') })
    .tagTask('e3', 'T1')
  f.close()
  db = new ThingsDb(f.path, () => NOW)
})

describe('searchTodos', () => {
  it('matches title and notes, soonest deadline first', () => {
    expect(ids(db.searchTodos({ q: 'buy' }))).toEqual(['e2', 'e1'])
  })

  it('treats % and _ in the query literally', () => {
    expect(ids(db.searchTodos({ q: '100%' }))).toEqual(['e2'])
    expect(ids(db.searchTodos({ q: '%' }))).toEqual(['e2'])
    expect(ids(db.searchTodos({ q: '50_50' }))).toEqual(['w2'])
  })

  it('filters by tag (any case), project (incl. headings), area (incl. its projects)', () => {
    expect(ids(db.searchTodos({ tag: 'phone' }))).toEqual(['e3'])
    expect(ids(db.searchTodos({ project_id: 'P1' })).sort()).toEqual(['e1', 'e2', 'e3'])
    expect(ids(db.searchTodos({ area_id: 'A1' })).sort()).toEqual(['e1', 'e2', 'e3', 'h1'])
  })

  it('filters by deadline and status', () => {
    expect(ids(db.searchTodos({ deadline_before: '2026-10-17' }))).toEqual(['h1'])
    expect(ids(db.searchTodos({ status: 'completed' }))).toEqual(['e4'])
    expect(ids(db.searchTodos({ project_id: 'P1', status: 'any' })).sort()).toEqual(['e1', 'e2', 'e3', 'e4'])
  })
})

describe('projects', () => {
  it('lists open projects with counts, headings and area', () => {
    const projects = db.listProjects()
    expect(ids(projects)).toEqual(['P1', 'P3'])
    expect(projects[0]).toMatchObject({
      title: 'Errands',
      todos_open: 3,
      headings: [{ id: 'H1', title: 'Shops' }, { id: 'H2', title: 'Online' }],
      area: { id: 'A1', title: 'Home' },
      deadline: '2026-10-20',
      list: 'anytime',
      status: 'open',
    })
    expect(projects[0]).not.toHaveProperty('checklist')
  })

  it('gets any project by id, and only projects', () => {
    expect(db.getProject('P2')!.status).toBe('completed')
    expect(db.getProject('e1')).toBeNull()
  })

  it('groups a project’s open to-dos by heading', () => {
    const detail = db.getProjectDetail('P1')!
    expect(detail.groups.map((g) => [g.heading?.id ?? null, ids(g.todos)])).toEqual([
      [null, ['e1']],
      ['H1', ['e2']],
      ['H2', ['e3']],
    ])
  })
})

describe('areas, tags, headings', () => {
  it('lists areas with tags', () => {
    expect(db.listAreas()).toEqual([
      { id: 'A1', title: 'Home', tags: ['family'] },
      { id: 'A2', title: 'Work', tags: [] },
    ])
  })

  it('gets an area with its projects and loose to-dos', () => {
    const area = db.getArea('A2')!
    expect(ids(area.projects)).toEqual(['P3'])
    expect(ids(area.todos)).toEqual(['w1'])
    expect(db.getArea('nope')).toBeNull()
    expect(db.areaExists('A1')).toBe(true)
    expect(db.areaExists('P1')).toBe(false)
  })

  it('lists tags with parent titles', () => {
    expect(db.listTags()).toEqual([
      { id: 'T1', title: 'Phone', parent: null },
      { id: 'T2', title: 'family', parent: null },
      { id: 'T3', title: 'urgent', parent: 'Phone' },
    ])
  })

  it('gets a heading with its project', () => {
    expect(db.getHeading('H1')).toEqual({ id: 'H1', title: 'Shops', projectId: 'P1' })
    expect(db.getHeading('e1')).toBeNull()
  })
})
```

`test/schema-drift.test.ts` (runs only on a Mac with Things installed; reads table structure, never rows):

```ts
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { findDbPath } from '../src/things/db.ts'
import { Fixture } from './helpers/fixture.ts'

let real: string | null = null
try {
  real = findDbPath()
} catch {
  real = null
}

const TABLES = ['TMTask', 'TMArea', 'TMTag', 'TMTaskTag', 'TMAreaTag', 'TMChecklistItem']
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

describe.skipIf(!real)('fixture schema vs the installed Things', () => {
  it('every column the fixture has still exists in Things', () => {
    const fixture = new Fixture()
    const live = new DatabaseSync(real!, { readOnly: true })
    for (const table of TABLES) {
      const liveCols = columns(live, table)
      const missing = columns(fixture.db, table).filter((c) => !liveCols.includes(c))
      expect(missing, `${table}: columns gone from Things — update the fixture and queries`).toEqual([])
    }
    live.close()
    fixture.close()
  })
})
```

- [ ] **Step 2: Run them to verify the new test fails**

Run: `npx vitest run test/db-more.test.ts test/schema-drift.test.ts`
Expected: `db-more` FAILS (`db.searchTodos is not a function`); `schema-drift` PASSES on a Mac with Things, skips elsewhere.

- [ ] **Step 3: Implement**

In `src/things/db.ts`, change the type import to:

```ts
import type { Area, AreaDetail, ChecklistItem, Kind, Project, ProjectDetail, ReadableList, Ref, Status, Tag, Todo } from './types.ts'
```

Below `LIST_SQL`, add:

```ts
export type TodoFilter = {
  q?: string
  tag?: string
  project_id?: string
  area_id?: string
  deadline_before?: string
  status?: Status | 'any'
  limit?: number
}

const STATUS_CODE: Record<Status, number> = { open: 0, canceled: 2, completed: 3 }

/** Same columns as TASK_SELECT so rows go through toTodo; projects have no heading/project parent. */
const PROJECT_SELECT = `
  SELECT t.uuid, t.title, t.notes, t.status, t.trashed, t.start, t.startDate, t.startBucket,
         t.reminderTime, t.deadline, t.creationDate, t.userModificationDate, t.stopDate,
         NULL AS rt1_repeatingTemplate, NULL AS headingId, NULL AS headingTitle,
         NULL AS projectId, NULL AS projectTitle, a.uuid AS areaId, a.title AS areaTitle
  FROM TMTask t
  LEFT JOIN TMArea a ON a.uuid = t.area`
```

Inside `class ThingsDb`, after `getTodo`, add:

```ts
  searchTodos(f: TodoFilter): Todo[] {
    const where = ['t.type = 0', 't.trashed = 0', NOT_TEMPLATE]
    const params: SQLInputValue[] = []
    const status = f.status ?? 'open'
    if (status !== 'any') {
      where.push('t.status = ?')
      params.push(STATUS_CODE[status])
    }
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      where.push(`(t.title LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')`)
      params.push(like, like)
    }
    if (f.tag) {
      where.push(`EXISTS (SELECT 1 FROM TMTaskTag tt JOIN TMTag g ON g.uuid = tt.tags
                  WHERE tt.tasks = t.uuid AND g.title = ? COLLATE NOCASE)`)
      params.push(f.tag)
    }
    if (f.project_id) {
      where.push('p.uuid = ?')
      params.push(f.project_id)
    }
    if (f.area_id) {
      where.push('a.uuid = ?')
      params.push(f.area_id)
    }
    if (f.deadline_before) {
      where.push('t.deadline IS NOT NULL AND t.deadline <= ?')
      params.push(packDate(f.deadline_before))
    }
    params.push(Math.min(f.limit ?? 100, 500))
    return this.hydrate(this.all<TaskRow>(
      `${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.deadline IS NULL, t.deadline, t."index" LIMIT ?`,
      ...params,
    ))
  }

  private headingsOf(projectId: string): Ref[] {
    return this.all<{ uuid: string; title: string | null }>(
      `SELECT uuid, title FROM TMTask WHERE type = 2 AND project = ? AND trashed = 0 ORDER BY "index"`,
      projectId,
    ).map((r) => ({ id: r.uuid, title: r.title ?? '' }))
  }

  private toProjects(rows: TaskRow[]): Project[] {
    const today = this.today()
    return rows.map((r) => {
      const { checklist: _c, heading: _h, project: _p, repeating: _r, ...base } = toTodo(r, this.tagsOf(r.uuid), [], today)
      const [{ n }] = this.all<{ n: number }>(
        `SELECT count(*) AS n FROM TMTask t LEFT JOIN TMTask h ON h.uuid = t.heading
         WHERE t.type = 0 AND t.status = 0 AND t.trashed = 0 AND ${NOT_TEMPLATE}
           AND COALESCE(t.project, h.project) = ?`,
        r.uuid,
      )
      return { ...base, todos_open: n, headings: this.headingsOf(r.uuid) }
    })
  }

  listProjects(): Project[] {
    return this.toProjects(this.all<TaskRow>(
      `${PROJECT_SELECT} WHERE t.type = 1 AND t.status = 0 AND t.trashed = 0 ORDER BY t."index"`,
    ))
  }

  /** Any project by id, in any state. */
  getProject(id: string): Project | null {
    return this.toProjects(this.all<TaskRow>(`${PROJECT_SELECT} WHERE t.uuid = ? AND t.type = 1`, id))[0] ?? null
  }

  getProjectDetail(id: string): ProjectDetail | null {
    const project = this.getProject(id)
    if (!project) return null
    const todos = this.hydrate(this.all<TaskRow>(
      `${TASK_SELECT} WHERE ${OPEN_TODO} AND p.uuid = ? ORDER BY t."index"`,
      id,
    ))
    const groups = [
      { heading: null, todos: todos.filter((t) => !t.heading) },
      ...project.headings.map((h) => ({ heading: h, todos: todos.filter((t) => t.heading?.id === h.id) })),
    ]
    return { ...project, groups }
  }

  private toArea(r: { uuid: string; title: string | null }): Area {
    const tags = this.all<{ title: string }>(
      `SELECT g.title FROM TMAreaTag x JOIN TMTag g ON g.uuid = x.tags WHERE x.areas = ? ORDER BY g."index"`,
      r.uuid,
    ).map((t) => t.title)
    return { id: r.uuid, title: r.title ?? '', tags }
  }

  listAreas(): Area[] {
    return this.all<{ uuid: string; title: string | null }>(`SELECT uuid, title FROM TMArea ORDER BY "index"`)
      .map((r) => this.toArea(r))
  }

  getArea(id: string): AreaDetail | null {
    const [row] = this.all<{ uuid: string; title: string | null }>(`SELECT uuid, title FROM TMArea WHERE uuid = ?`, id)
    if (!row) return null
    const projects = this.toProjects(this.all<TaskRow>(
      `${PROJECT_SELECT} WHERE t.type = 1 AND t.status = 0 AND t.trashed = 0 AND t.area = ? ORDER BY t."index"`,
      id,
    ))
    const todos = this.hydrate(this.all<TaskRow>(
      `${TASK_SELECT} WHERE ${OPEN_TODO} AND t.area = ? AND p.uuid IS NULL ORDER BY t."index"`,
      id,
    ))
    return { ...this.toArea(row), projects, todos }
  }

  areaExists(id: string): boolean {
    return this.all(`SELECT 1 FROM TMArea WHERE uuid = ?`, id).length > 0
  }

  listTags(): Tag[] {
    return this.all<{ uuid: string; title: string | null; parent: string | null }>(
      `SELECT g.uuid, g.title, pg.title AS parent FROM TMTag g LEFT JOIN TMTag pg ON pg.uuid = g.parent ORDER BY g."index"`,
    ).map((r) => ({ id: r.uuid, title: r.title ?? '', parent: r.parent }))
  }

  getHeading(id: string): { id: string; title: string; projectId: string } | null {
    const [r] = this.all<{ uuid: string; title: string | null; project: string }>(
      `SELECT uuid, title, project FROM TMTask WHERE uuid = ? AND type = 2 AND trashed = 0`,
      id,
    )
    return r ? { id: r.uuid, title: r.title ?? '', projectId: r.project } : null
  }
```

Also export `NOT_TEMPLATE` (change `const NOT_TEMPLATE` to `export const NOT_TEMPLATE`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/db-more.test.ts test/schema-drift.test.ts`
Expected: PASS (11 tests in `db-more`; `schema-drift` passes or skips).

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck`
Expected: all pass, no type errors.

---

### Task 5: AppleScript, URL scheme and process boundary

**Files:**
- Create: `src/things/system.ts`, `src/things/applescript.ts`, `src/things/urlscheme.ts`
- Test: `test/system.test.ts`

**Interfaces:**
- Consumes: `ApiError`, `notFound` (Task 1)
- Produces:
  - `type Runner = (file: string, args: string[]) => Promise<string>`, `execRunner: Runner`
  - `type System = { osascript(script: string, args: string[]): Promise<string>; openUrl(url: string): Promise<void>; thingsRunning(): Promise<boolean>; launchThings(): Promise<void> }`, `makeSystem(runner?: Runner): System`, `mapAppleScriptError(err: unknown): ApiError`
  - `SCRIPTS` (fixed AppleScript source), `type ThingsScripts = { ping(); createTodo(title); createProject(title, todoTitles); trashTodo(id); trashProject(id); moveToInbox(id); setTags(kind: 'todo' | 'project', id, tags: string[]); createArea(title); deleteArea(id) }`, `appleScriptThings(sys: Pick<System, 'osascript'>): ThingsScripts`
  - `type UrlCommand = 'update' | 'update-project'`, `thingsUrl(command, id, params: Record<string, string | boolean>, authToken): string`

- [ ] **Step 1: Write the failing test**

`test/system.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeSystem, mapAppleScriptError, execRunner, type Runner } from '../src/things/system.ts'
import { SCRIPTS, appleScriptThings } from '../src/things/applescript.ts'
import { thingsUrl } from '../src/things/urlscheme.ts'

const NASTY = `x" & (do shell script "touch MARKER") & "y \\ 'q' 🎉`

function recorder(output = 'ID1\n') {
  const calls: [string, string[]][] = []
  const runner: Runner = async (file, args) => {
    calls.push([file, args])
    return output
  }
  return { calls, runner }
}

describe('AppleScript calls', () => {
  it('passes user text only as argv, never inside the script (Review Focus 1)', async () => {
    const { calls, runner } = recorder()
    const things = appleScriptThings(makeSystem(runner))
    expect(await things.createTodo(NASTY)).toBe('ID1')
    expect(calls).toEqual([['osascript', ['-e', SCRIPTS.createTodo, NASTY]]])
    expect(SCRIPTS.createTodo).not.toContain('MARKER')
  })

  it('sends project to-dos as separate args and tags as one list', async () => {
    const { calls, runner } = recorder()
    const things = appleScriptThings(makeSystem(runner))
    await things.createProject('Trip', ['Pack', 'Book hotel'])
    await things.setTags('todo', 'T9', ['phone', 'errands'])
    await things.setTags('project', 'P9', [])
    expect(calls[0][1].slice(2)).toEqual(['Trip', 'Pack', 'Book hotel'])
    expect(calls[1][1]).toEqual(['-e', SCRIPTS.setTodoTags, 'T9', 'phone, errands'])
    expect(calls[2][1]).toEqual(['-e', SCRIPTS.setProjectTags, 'P9', ''])
  })

  it.runIf(process.platform === 'darwin')('real osascript returns argv text verbatim and runs none of it', async () => {
    const marker = path.join(os.tmpdir(), `musethings-marker-${process.pid}`)
    const text = NASTY.replace('MARKER', marker)
    const sys = makeSystem(execRunner)
    const echo = 'on run argv\n  return item 1 of argv\nend run'
    expect(await sys.osascript(echo, [text])).toBe(text)
    expect(fs.existsSync(marker)).toBe(false)
  })
})

describe('errors from osascript', () => {
  const fail = (stderr: string) => Object.assign(new Error('Command failed'), { stderr })

  it('maps permission, missing item and other failures', () => {
    expect(mapAppleScriptError(fail('execution error: Not authorized to send Apple events to Things3. (-1743)')))
      .toMatchObject({ status: 503, code: 'setup_required' })
    expect(mapAppleScriptError(fail('execution error: Things3 got an error: Can’t get to do id "x". (-1728)')))
      .toMatchObject({ status: 404, code: 'not_found' })
    expect(mapAppleScriptError(fail('something odd (-2700)')))
      .toMatchObject({ status: 503, code: 'things_unavailable' })
  })

  it('wraps runner failures from osascript', async () => {
    const sys = makeSystem(async () => {
      throw fail('Not authorized to send Apple events (-1743)')
    })
    await expect(sys.osascript(SCRIPTS.ping, [])).rejects.toMatchObject({ code: 'setup_required' })
  })
})

describe('process helpers', () => {
  it('opens URLs in the background and checks Things with pgrep', async () => {
    const { calls, runner } = recorder()
    const sys = makeSystem(runner)
    await sys.openUrl('things:///update?id=1')
    expect(await sys.thingsRunning()).toBe(true)
    expect(calls).toEqual([
      ['open', ['-g', 'things:///update?id=1']],
      ['pgrep', ['-x', 'Things3']],
    ])
    const down = makeSystem(async () => {
      throw new Error('exit 1')
    })
    expect(await down.thingsRunning()).toBe(false)
  })
})

describe('thingsUrl', () => {
  it('percent-encodes every value and keeps empty ones (Review Focus 1)', () => {
    const url = thingsUrl('update', 'A1', { title: 'Milk & eggs = 2 #1', notes: 'a\nb 🎉', deadline: '', completed: true }, 'tok')
    expect(url).toBe(
      'things:///update?id=A1&title=Milk%20%26%20eggs%20%3D%202%20%231&notes=a%0Ab%20%F0%9F%8E%89&deadline=&completed=true&auth-token=tok',
    )
    const back = new URL(url).searchParams
    expect(back.get('title')).toBe('Milk & eggs = 2 #1')
    expect(back.get('notes')).toBe('a\nb 🎉')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/system.test.ts`
Expected: FAIL, cannot find `../src/things/system.ts`.

- [ ] **Step 3: Implement**

`src/things/system.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ApiError, notFound } from '../errors.ts'

const execFileP = promisify(execFile)

export type Runner = (file: string, args: string[]) => Promise<string>

export const execRunner: Runner = async (file, args) => (await execFileP(file, args, { timeout: 15_000 })).stdout

export type System = {
  osascript(script: string, args: string[]): Promise<string>
  openUrl(url: string): Promise<void>
  thingsRunning(): Promise<boolean>
  launchThings(): Promise<void>
}

export function mapAppleScriptError(err: unknown): ApiError {
  const e = err as { stderr?: string; message?: string }
  const text = String(e?.stderr || e?.message || err)
  if (/-1743|not authorized to send apple events/i.test(text)) {
    return new ApiError(503, 'setup_required',
      "macOS hasn't allowed MuseThings to control Things. On the Mac, run `node src/cli.ts doctor` and click Allow.")
  }
  if (/-1728|can[’']t get/i.test(text)) return notFound('Things has no item with that id.')
  return new ApiError(503, 'things_unavailable', `Things returned an error: ${text.trim().slice(0, 200)}`)
}

export function makeSystem(runner: Runner = execRunner): System {
  return {
    async osascript(script, args) {
      try {
        return (await runner('osascript', ['-e', script, ...args])).trim()
      } catch (err) {
        throw mapAppleScriptError(err)
      }
    },
    async openUrl(url) {
      await runner('open', ['-g', url])
    },
    async thingsRunning() {
      try {
        await runner('pgrep', ['-x', 'Things3'])
        return true
      } catch {
        return false
      }
    },
    async launchThings() {
      await runner('open', ['-gja', 'Things3'])
    },
  }
}
```

`src/things/applescript.ts`:

```ts
import type { System } from './system.ts'

/**
 * Fixed AppleScript source. Values only ever arrive as argv (`item n of argv`).
 * Never build or edit these strings from user input.
 */
export const SCRIPTS = {
  ping: 'tell application "Things3" to return name',
  createTodo: `on run argv
  tell application "Things3"
    set t to make new to do with properties {name:(item 1 of argv)}
    return id of t
  end tell
end run`,
  createProject: `on run argv
  tell application "Things3"
    set p to make new project with properties {name:(item 1 of argv)}
    repeat with i from 2 to count of argv
      set t to make new to do with properties {name:(item i of argv)}
      set project of t to p
    end repeat
    return id of p
  end tell
end run`,
  trashTodo: `on run argv
  tell application "Things3" to delete to do id (item 1 of argv)
end run`,
  trashProject: `on run argv
  tell application "Things3" to delete project id (item 1 of argv)
end run`,
  moveToInbox: `on run argv
  tell application "Things3" to move to do id (item 1 of argv) to list "Inbox"
end run`,
  setTodoTags: `on run argv
  tell application "Things3" to set tag names of to do id (item 1 of argv) to (item 2 of argv)
end run`,
  setProjectTags: `on run argv
  tell application "Things3" to set tag names of project id (item 1 of argv) to (item 2 of argv)
end run`,
  createArea: `on run argv
  tell application "Things3"
    set a to make new area with properties {name:(item 1 of argv)}
    return id of a
  end tell
end run`,
  deleteArea: `on run argv
  tell application "Things3" to delete area id (item 1 of argv)
end run`,
} as const

export type ThingsScripts = {
  ping(): Promise<string>
  createTodo(title: string): Promise<string>
  createProject(title: string, todoTitles: string[]): Promise<string>
  trashTodo(id: string): Promise<void>
  trashProject(id: string): Promise<void>
  moveToInbox(id: string): Promise<void>
  /** Replaces all tags. Things creates tags that don't exist yet. */
  setTags(kind: 'todo' | 'project', id: string, tags: string[]): Promise<void>
  createArea(title: string): Promise<string>
  deleteArea(id: string): Promise<void>
}

export function appleScriptThings(sys: Pick<System, 'osascript'>): ThingsScripts {
  const run = (script: string, ...args: string[]) => sys.osascript(script, args)
  return {
    ping: () => run(SCRIPTS.ping),
    createTodo: (title) => run(SCRIPTS.createTodo, title),
    createProject: (title, todos) => run(SCRIPTS.createProject, title, ...todos),
    trashTodo: async (id) => void (await run(SCRIPTS.trashTodo, id)),
    trashProject: async (id) => void (await run(SCRIPTS.trashProject, id)),
    moveToInbox: async (id) => void (await run(SCRIPTS.moveToInbox, id)),
    setTags: async (kind, id, tags) =>
      void (await run(kind === 'todo' ? SCRIPTS.setTodoTags : SCRIPTS.setProjectTags, id, tags.join(', '))),
    createArea: (title) => run(SCRIPTS.createArea, title),
    deleteArea: async (id) => void (await run(SCRIPTS.deleteArea, id)),
  }
}
```

`src/things/urlscheme.ts`:

```ts
export type UrlCommand = 'update' | 'update-project'

/** A things:/// URL. Every value is percent-encoded; empty strings are kept (they clear a field). */
export function thingsUrl(
  command: UrlCommand,
  id: string,
  params: Record<string, string | boolean>,
  authToken: string,
): string {
  const pairs: [string, string][] = [
    ['id', id],
    ...Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]),
    ['auth-token', authToken],
  ]
  return `things:///${command}?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/system.test.ts`
Expected: PASS (7 tests; the real-osascript test runs only on macOS).

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck`
Expected: all pass, no type errors.

---

### Task 6: Write to-dos (plan the change, apply it through Things, confirm, audit)

Every write follows the same path:
1. **Plan** (`changes.ts`): validate the fields and turn them into URL parameters, a tag list (AppleScript), an Inbox move (AppleScript), and an **expectation**: what the to-do should look like once Things has applied it. Invalid input throws `invalid_request` before anything touches Things.
2. **Apply** (`writer.ts`): Inbox move, then tags, then one `things:///update` URL.
3. **Confirm** (`writer.ts` + `expect.ts`): re-read the to-do every `pollMs` until it matches the expectation, or fail with `write_not_confirmed` after `timeoutMs` (5 s), naming the fields still different.
4. **Audit**: append `{op, id, before, after}`.

All writes run through one `Queue`, so Things only ever handles one at a time. Tags go through AppleScript because Things' URL scheme ignores tags that don't exist yet; AppleScript creates them.

`when` values: `today`, `evening`, `tomorrow`, `anytime`, `someday`, `YYYY-MM-DD` (not in the past), or `null` (same as `anytime`). Dated values are sent as an ISO date, with `@HH:MM` when there's a reminder. A reminder needs a date, so it can't go with `evening`, `anytime`, `someday` or `null`. Changing only `reminder` keeps the to-do's current date.

**Files:**
- Create: `src/queue.ts`, `src/audit.ts`, `src/things/expect.ts`, `src/things/changes.ts`, `src/things/writer.ts`, `test/helpers/fake-things.ts`
- Test: `test/queue-audit.test.ts`, `test/writer-todos.test.ts`

**Interfaces:**
- Consumes: `ThingsDb` (`getTodo`, `getProject`, `kindOf`, `getHeading`, `areaExists`) (Tasks 3–4); `ThingsScripts` (Task 5); `thingsUrl` (Task 5); `todayIso`, `addDays`, `isIsoDate`, `isTime`, `packDate`, `packTime` (Task 2); `ApiError`, `invalid`, `notFound` (Task 1); `homeDir` (Task 1)
- Produces:
  - `class Queue { run<T>(job: () => Promise<T>): Promise<T> }`
  - `type AuditEntry = { op: string; id: string; before: unknown; after: unknown }`, `type Audit = (e: AuditEntry) => void`, `fileAudit(file?: string): Audit`
  - `type Expectation`, `mismatches(item: Todo | Project, e: Expectation): string[]`
  - `type When = string`, `type TodoFields`, `type TodoInput`, `type Lookup`, `type ChangePlan = { url: Record<string, string | boolean>; tags: string[] | null; toInbox: boolean; expect: Expectation }`, `planTodoChange(f, current: Todo | null, lookup, now: Date): ChangePlan`, `planBasics(f, plan)`, `planWhen(f, current, today, plan)`, `checkTitle(title)`, `checkTagNames(tags, field)`, `tagPlan(f, current)`
  - `type Reader`, `type WriterDeps = { reader; things; openUrl(url): Promise<void>; authToken; audit; ensureThings?; now?; pollMs?; timeoutMs? }`
  - `class Writer { createTodo(input: TodoInput): Promise<Todo>; updateTodo(id, fields: TodoFields): Promise<Todo>; setTodoStatus(id, action: 'complete' | 'cancel' | 'reopen'): Promise<Todo>; trashTodo(id): Promise<Todo> }`. Task 7 adds the project methods.
  - Test helper `class FakeThings implements ThingsScripts { log: string[]; urls: string[]; ignoreUrls: boolean; urlDelayMs: number; openUrl(url): Promise<void> }`

- [ ] **Step 1: Write the queue and audit tests**

`test/queue-audit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Queue } from '../src/queue.ts'
import { fileAudit } from '../src/audit.ts'

describe('Queue', () => {
  it('runs jobs one at a time in order and keeps going after a failure', async () => {
    const q = new Queue()
    const events: string[] = []
    const job = (name: string, ms: number, fail = false) => async () => {
      events.push(`start ${name}`)
      await new Promise((r) => setTimeout(r, ms))
      events.push(`end ${name}`)
      if (fail) throw new Error(name)
      return name
    }
    const results = await Promise.allSettled([q.run(job('a', 30)), q.run(job('b', 1, true)), q.run(job('c', 1))])
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
  })
})

describe('fileAudit', () => {
  it('appends one JSON line per write, owner-only', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-audit-')), 'sub', 'audit.jsonl')
    const audit = fileAudit(file)
    audit({ op: 'create_todo', id: 'X', before: null, after: { title: 'a' } })
    audit({ op: 'trash_todo', id: 'X', before: { title: 'a' }, after: null })
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.op)).toEqual(['create_todo', 'trash_todo'])
    expect(lines[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/queue-audit.test.ts`
Expected: FAIL, cannot find `../src/queue.ts`.

- [ ] **Step 3: Implement queue and audit**

`src/queue.ts`:

```ts
/** Runs async jobs one at a time, in the order they were queued. A failed job doesn't block the next. */
export class Queue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job)
    this.tail = result.catch(() => undefined)
    return result
  }
}
```

`src/audit.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { homeDir } from './config.ts'

export type AuditEntry = { op: string; id: string; before: unknown; after: unknown }
export type Audit = (entry: AuditEntry) => void

export function fileAudit(file = path.join(homeDir(), 'audit.jsonl')): Audit {
  return (entry) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 })
  }
}
```

Run: `npx vitest run test/queue-audit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Add the fake Things used by writer tests**

`test/helpers/fake-things.ts`:

```ts
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
          reminderTime: time ? packTime(time) : null,
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
```

- [ ] **Step 5: Write the failing writer test**

`test/writer-todos.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { Fixture } from './helpers/fixture.ts'
import { FakeThings } from './helpers/fake-things.ts'
import { ThingsDb } from '../src/things/db.ts'
import { Writer } from '../src/things/writer.ts'
import { packDate } from '../src/things/dates.ts'
import type { AuditEntry } from '../src/audit.ts'

const NOW = new Date(2026, 9, 15, 12, 0)
let f: Fixture
let fake: FakeThings
let writer: Writer
let audit: AuditEntry[]

function makeWriter(timeoutMs = 1000) {
  return new Writer({
    reader: new ThingsDb(f.path, () => NOW),
    things: fake,
    openUrl: (url) => fake.openUrl(url),
    authToken: 'tok',
    audit: (e) => audit.push(e),
    now: () => NOW,
    pollMs: 5,
    timeoutMs,
  })
}

beforeEach(() => {
  f = new Fixture()
  f.area('A1', 'Home')
    .task({ uuid: 'P1', type: 1, title: 'Errands', area: 'A1' })
    .task({ uuid: 'P2', type: 1, title: 'Trip' })
    .task({ uuid: 'H1', type: 2, title: 'Shops', project: 'P1' })
    .task({ uuid: 'H9', type: 2, title: 'Packing', project: 'P2' })
    .task({ uuid: 'x1', title: 'Water plants', start: 1 })
    .task({ uuid: 'x2', title: 'Pay rent', start: 1, startDate: packDate('2026-10-15') })
    .task({ uuid: 'x3', title: 'Old idea', start: 1, status: 2, stopDate: 1760000000 })
    .task({ uuid: 'tpl', title: 'Weekly review', start: 1, rt1_recurrenceRule: new Uint8Array([1]) })
    .tag('T1', 'Errands', null, 0)
    .tagTask('x1', 'T1')
    .checklist('C1', 'x1', 'Kitchen', false, 0)
  fake = new FakeThings(f, () => NOW)
  audit = []
  writer = makeWriter()
})

describe('createTodo', () => {
  it('creates with every field and confirms it', async () => {
    const todo = await writer.createTodo({
      title: 'Call the dentist', notes: 'ask about Friday', when: 'tomorrow', reminder: '09:30',
      deadline: '2026-10-17', tags: ['phone'], project_id: 'P1', checklist: ['Find card'],
    })
    expect(todo).toMatchObject({
      title: 'Call the dentist', notes: 'ask about Friday', list: 'upcoming', when: '2026-10-16',
      reminder: '09:30', deadline: '2026-10-17', tags: ['phone'], project: { id: 'P1' }, area: { id: 'A1' },
      checklist: [{ title: 'Find card', done: false }],
    })
    expect(fake.urls[0]).not.toContain('title=')
    expect(audit).toEqual([{ op: 'create_todo', id: todo.id, before: null, after: todo }])
  })

  it('a bare title goes to the Inbox without a URL call', async () => {
    const todo = await writer.createTodo({ title: 'Just a thought' })
    expect(todo.list).toBe('inbox')
    expect(fake.urls).toEqual([])
  })

  it('rejects bad input before touching Things', async () => {
    const bad: [object, RegExp][] = [
      [{ title: 'a', when: '2026-10-01' }, /past/],
      [{ title: 'a', when: 'someday', reminder: '09:00' }, /reminder needs a date/],
      [{ title: 'a', when: 'evening', reminder: '19:00' }, /This Evening/],
      [{ title: 'a', when: 'next week' }, /when must be/],
      [{ title: 'a', when: 'today', reminder: '9am' }, /reminder must be a time/],
      [{ title: 'a', project_id: 'A1' }, /not a project/],
      [{ title: 'a', area_id: 'P1' }, /not an area/],
      [{ title: 'a', project_id: 'P1', heading_id: 'H9' }, /different project/],
      [{ title: 'a', project_id: 'P1', area_id: 'A1' }, /not both/],
      [{ title: 'a', tags: ['one, two'] }, /commas/],
      [{ title: 'two\nlines' }, /single line/],
      [{ title: '  ' }, /empty/],
      [{ title: 'a', checklist: ['x\ny'] }, /single lines/],
    ]
    for (const [input, message] of bad) {
      await expect(writer.createTodo(input as never)).rejects.toMatchObject({
        status: 400, code: 'invalid_request', message: expect.stringMatching(message),
      })
    }
    expect(fake.log).toEqual([])
  })

  it('stores text that looks like code exactly as typed (Review Focus 1)', async () => {
    const title = `Milk & eggs = 2 #1 "quoted" \\ back`
    const notes = `line1\nline2 🎉 " & (do shell script "x") & "`
    const created = await writer.createTodo({ title: 'temp', notes })
    const updated = await writer.updateTodo(created.id, { title })
    expect(updated.title).toBe(title)
    expect(updated.notes).toBe(notes)
  })
})

describe('updateTodo', () => {
  it('schedules: evening, anytime, someday, a date with a reminder', async () => {
    expect((await writer.updateTodo('x1', { when: 'evening' })).list).toBe('evening')
    expect(await writer.updateTodo('x1', { when: null })).toMatchObject({ list: 'anytime', when: null })
    expect((await writer.updateTodo('x1', { when: 'someday' })).list).toBe('someday')
    expect(await writer.updateTodo('x1', { when: '2026-10-20', reminder: '18:00' }))
      .toMatchObject({ list: 'upcoming', when: '2026-10-20', reminder: '18:00' })
  })

  it('changing only the reminder keeps the date', async () => {
    expect(await writer.updateTodo('x2', { reminder: '18:00' }))
      .toMatchObject({ when: '2026-10-15', reminder: '18:00', list: 'today' })
    await expect(writer.updateTodo('x1', { reminder: '18:00' })).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('replaces, adds and removes tags (any case)', async () => {
    expect((await writer.updateTodo('x1', { add_tags: ['phone', 'errands'] })).tags).toEqual(['Errands', 'phone'])
    expect((await writer.updateTodo('x1', { remove_tags: ['ERRANDS'] })).tags).toEqual(['phone'])
    expect((await writer.updateTodo('x1', { tags: [] })).tags).toEqual([])
    await expect(writer.updateTodo('x1', { tags: ['a'], add_tags: ['b'] })).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('moves between heading, area, project and Inbox', async () => {
    expect(await writer.updateTodo('x1', { heading_id: 'H1' })).toMatchObject({ project: { id: 'P1' }, heading: { id: 'H1' } })
    expect(await writer.updateTodo('x1', { area_id: 'A1' })).toMatchObject({ project: null, heading: null, area: { id: 'A1' } })
    expect(await writer.updateTodo('x1', { project_id: 'P2' })).toMatchObject({ project: { id: 'P2' }, area: null })
    expect(await writer.updateTodo('x1', { list: 'inbox' })).toMatchObject({ list: 'inbox', project: null })
    await expect(writer.updateTodo('x1', { list: 'inbox', when: 'today' })).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('sets and clears deadline and notes; appends and replaces the checklist', async () => {
    expect((await writer.updateTodo('x1', { deadline: '2026-10-30', notes: 'n' })).deadline).toBe('2026-10-30')
    expect(await writer.updateTodo('x1', { deadline: null, notes: null })).toMatchObject({ deadline: null, notes: '' })
    expect((await writer.updateTodo('x1', { add_checklist: ['Bathroom'] })).checklist.map((c) => c.title))
      .toEqual(['Kitchen', 'Bathroom'])
    expect((await writer.updateTodo('x1', { checklist: ['Only'] })).checklist.map((c) => c.title)).toEqual(['Only'])
  })

  it('refuses repeating templates, projects and unknown ids', async () => {
    await expect(writer.updateTodo('tpl', { title: 'x' })).rejects.toMatchObject({ status: 409, code: 'repeating_not_supported' })
    await expect(writer.updateTodo('P1', { title: 'x' })).rejects.toMatchObject({
      status: 404, message: expect.stringContaining('/projects/P1'),
    })
    await expect(writer.updateTodo('nope', { title: 'x' })).rejects.toMatchObject({ status: 404 })
  })
})

describe('status and trash', () => {
  it('completes, reopens and cancels; the same status twice is a no-op', async () => {
    const done = await writer.setTodoStatus('x1', 'complete')
    expect(done.status).toBe('completed')
    expect(done.completed_at).not.toBeNull()
    const urlCount = fake.urls.length
    expect((await writer.setTodoStatus('x1', 'complete')).status).toBe('completed')
    expect(fake.urls.length).toBe(urlCount)
    expect((await writer.setTodoStatus('x1', 'reopen')).status).toBe('open')
    expect((await writer.setTodoStatus('x1', 'cancel')).status).toBe('canceled')
    expect((await writer.setTodoStatus('x3', 'reopen')).status).toBe('open')
    expect(fake.urls.at(-1)).toContain('canceled=false')
  })

  it('moves to Trash and records it', async () => {
    const t = await writer.trashTodo('x1')
    expect(t.list).toBe('trash')
    expect(audit.at(-1)).toMatchObject({ op: 'trash_todo', id: 'x1', before: { list: 'anytime' }, after: { list: 'trash' } })
  })
})

describe('confirmation', () => {
  it('fails with write_not_confirmed when Things never applies the change (Review Focus 4)', async () => {
    fake.ignoreUrls = true
    const slow = makeWriter(200)
    const started = Date.now()
    await expect(slow.updateTodo('x1', { title: 'New name' })).rejects.toMatchObject({
      status: 503, code: 'write_not_confirmed', message: expect.stringContaining('title'),
    })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(audit).toEqual([])
  })

  it('runs parallel writes one at a time, each confirmed before the next (Review Focus 5)', async () => {
    const [a, b] = await Promise.all([writer.updateTodo('x1', { title: 'A' }), writer.updateTodo('x2', { title: 'B' })])
    expect([a.title, b.title]).toEqual(['A', 'B'])
    expect(fake.log).toEqual(['open:x1', 'apply:x1', 'open:x2', 'apply:x2'])
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run test/writer-todos.test.ts`
Expected: FAIL, cannot find `../src/things/writer.ts`.

- [ ] **Step 7: Implement expectations, change planning and the writer**

`src/things/expect.ts`:

```ts
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
```

`src/things/changes.ts`:

```ts
import { invalid } from '../errors.ts'
import { addDays, isIsoDate, isTime, todayIso } from './dates.ts'
import type { ThingsDb } from './db.ts'
import type { Expectation } from './expect.ts'
import type { Todo } from './types.ts'

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
```

`src/things/writer.ts`:

```ts
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
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/writer-todos.test.ts test/queue-audit.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 9: Checkpoint**

Run: `npm test && npm run typecheck`
Expected: all pass, no type errors.

---

### Task 7: Write projects

Projects use the same plan → apply → confirm → audit path as to-dos, with `things:///update-project`. A project can't be scheduled for This Evening and has no reminder. Things creates a new project's to-dos in the same AppleScript call.

**Files:**
- Modify: `src/things/changes.ts` (project types + `planProjectChange`), `src/things/writer.ts` (project methods)
- Test: `test/writer-projects.test.ts`

**Interfaces:**
- Consumes: everything Task 6 produced; `ThingsDb.getProject`, `areaExists`, `kindOf` (Task 4)
- Produces:
  - `type ProjectFields = { title?; notes?: string | null; when?: When | null; deadline?: string | null; tags?; add_tags?; remove_tags?; area_id? }`
  - `type ProjectInput = Omit<ProjectFields, 'title' | 'add_tags' | 'remove_tags'> & { title: string; todos?: string[] }`
  - `planProjectChange(f: ProjectFields, current: Project | null, lookup: Lookup, now: Date): ChangePlan`
  - `Writer.createProject(input: ProjectInput): Promise<Project>`, `updateProject(id, fields: ProjectFields): Promise<Project>`, `setProjectStatus(id, action: 'complete' | 'cancel'): Promise<Project>`, `trashProject(id): Promise<Project>`

- [ ] **Step 1: Write the failing test**

`test/writer-projects.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { Fixture } from './helpers/fixture.ts'
import { FakeThings } from './helpers/fake-things.ts'
import { ThingsDb } from '../src/things/db.ts'
import { Writer } from '../src/things/writer.ts'
import type { AuditEntry } from '../src/audit.ts'

const NOW = new Date(2026, 9, 15, 12, 0)
let fake: FakeThings
let reader: ThingsDb
let writer: Writer
let audit: AuditEntry[]

beforeEach(() => {
  const f = new Fixture()
  f.area('A1', 'Home')
    .task({ uuid: 'P1', type: 1, title: 'Errands', area: 'A1' })
    .task({ uuid: 'c1', title: 'Buy milk', project: 'P1' })
    .task({ uuid: 'x1', title: 'Water plants' })
  fake = new FakeThings(f, () => NOW)
  reader = new ThingsDb(f.path, () => NOW)
  audit = []
  writer = new Writer({
    reader, things: fake, openUrl: (u) => fake.openUrl(u), authToken: 'tok',
    audit: (e) => audit.push(e), now: () => NOW, pollMs: 5, timeoutMs: 1000,
  })
})

describe('projects', () => {
  it('creates a project with to-dos, area, schedule, deadline and tags', async () => {
    const p = await writer.createProject({
      title: 'Trip', notes: 'Lisbon', area_id: 'A1', when: 'someday', deadline: '2026-11-01',
      tags: ['travel'], todos: ['Book flights', 'Pack'],
    })
    expect(p).toMatchObject({
      title: 'Trip', notes: 'Lisbon', area: { id: 'A1' }, list: 'someday', deadline: '2026-11-01',
      tags: ['travel'], todos_open: 2,
    })
    expect(fake.urls[0]).toMatch(/^things:\/\/\/update-project\?id=/)
    expect(fake.urls[0]).toContain('area-id=A1')
    expect(audit[0]).toMatchObject({ op: 'create_project', id: p.id, before: null })
  })

  it('rejects bad input before touching Things', async () => {
    const bad: [object, RegExp][] = [
      [{ title: 'a', when: 'evening' }, /This Evening/],
      [{ title: 'a', area_id: 'P1' }, /not an area/],
      [{ title: 'a', todos: ['x\ny'] }, /single line/],
      [{ title: 'a', when: '2026-01-01' }, /past/],
    ]
    for (const [input, message] of bad) {
      await expect(writer.createProject(input as never)).rejects.toMatchObject({
        code: 'invalid_request', message: expect.stringMatching(message),
      })
    }
    expect(fake.log).toEqual([])
  })

  it('updates title, schedule and tags', async () => {
    expect(await writer.updateProject('P1', { title: 'Weekend errands', when: '2026-10-20', add_tags: ['home'] }))
      .toMatchObject({ title: 'Weekend errands', when: '2026-10-20', list: 'upcoming', tags: ['home'] })
  })

  it('completing a project completes its open to-dos', async () => {
    expect((await writer.setProjectStatus('P1', 'complete')).status).toBe('completed')
    expect(reader.getTodo('c1')!.status).toBe('completed')
    expect(audit.at(-1)).toMatchObject({ op: 'complete_project', id: 'P1' })
  })

  it('cancels and trashes', async () => {
    expect((await writer.setProjectStatus('P1', 'cancel')).status).toBe('canceled')
    expect((await writer.trashProject('P1')).list).toBe('trash')
    expect(audit.at(-1)).toMatchObject({ op: 'trash_project', id: 'P1' })
  })

  it('tells to-dos and projects apart', async () => {
    await expect(writer.updateProject('x1', { title: 'a' })).rejects.toMatchObject({
      status: 404, message: expect.stringContaining('/todos/x1'),
    })
    await expect(writer.trashProject('nope')).rejects.toMatchObject({ status: 404 })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/writer-projects.test.ts`
Expected: FAIL, `writer.createProject is not a function`.

- [ ] **Step 3: Implement**

In `src/things/changes.ts`, change the types import to `import type { Project, Todo } from './types.ts'` and append:

```ts
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
```

In `src/things/writer.ts`, change the changes import to:

```ts
import {
  checkTitle, planProjectChange, planTodoChange,
  type ChangePlan, type Lookup, type ProjectFields, type ProjectInput, type TodoFields, type TodoInput,
} from './changes.ts'
```

and add these methods at the end of `class Writer`:

```ts
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
      const after = await this.apply('project', id, plan, () => this.d.reader.getProject(id), 'the new project')
      this.d.audit({ op: 'create_project', id, before: null, after })
      return after
    })
  }

  updateProject(id: string, fields: ProjectFields): Promise<Project> {
    return this.run(async () => {
      const before = this.existingProject(id)
      const plan = planProjectChange(fields, before, this.d.reader, this.d.now())
      const after = await this.apply('project', id, plan, () => this.d.reader.getProject(id), 'the change')
      this.d.audit({ op: 'update_project', id, before, after })
      return after
    })
  }

  setProjectStatus(id: string, action: 'complete' | 'cancel'): Promise<Project> {
    return this.run(async () => {
      const before = this.existingProject(id)
      const target: Status = action === 'complete' ? 'completed' : 'canceled'
      if (before.status === target) return before
      const url: Record<string, boolean> = action === 'complete' ? { completed: true } : { canceled: true }
      const plan: ChangePlan = { url, tags: null, toInbox: false, expect: { status: target } }
      const after = await this.apply('project', id, plan, () => this.d.reader.getProject(id), `the project as ${target}`)
      this.d.audit({ op: `${action}_project`, id, before, after })
      return after
    })
  }

  trashProject(id: string): Promise<Project> {
    return this.run(async () => {
      const before = this.existingProject(id)
      if (before.list === 'trash') return before
      await this.d.things.trashProject(id)
      const after = await this.confirm(() => this.d.reader.getProject(id), { lists: ['trash'] }, 'the move to Trash')
      this.d.audit({ op: 'trash_project', id, before, after })
      return after
    })
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/writer-projects.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck`
Expected: all pass, no type errors.

---

### Task 8: API key, server foundation, read endpoints and OpenAPI

**Files:**
- Create: `src/auth.ts`, `src/server/schemas.ts`, `src/server/app.ts`, `src/server/read-routes.ts`, `test/helpers/app.ts`
- Test: `test/auth.test.ts`, `test/server-read.test.ts`

**Interfaces:**
- Consumes: `ThingsDb` (Tasks 3–4), `Writer` (Tasks 6–7), `ApiError`, `notFound` (Task 1), `READABLE_LISTS` (Task 3)
- Produces:
  - `newKey(): { key: string; hash: string }`, `hashKey(key): string`, `keyMatches(presented, storedHash): boolean`, `bearer(header?: string): string | null`, `class BadKeyThrottle { constructor(now?: () => number); fail(): boolean }`
  - `type AppDeps = { reader: ThingsDb; writer: Writer; keyHash: string; thingsRunning: () => Promise<boolean>; publicUrl?: string; throttle?: BadKeyThrottle; logger?: boolean }`
  - `buildApp(deps: AppDeps): Promise<FastifyInstance>`
  - Schemas: `DATE`, `TIME`, `WHEN`, `ID`, `ID_PARAMS`, `objectReply(description)`, `COMPONENTS`
  - Test helper: `KEY`, `auth` (headers), `testApp(f: Fixture): Promise<{ app; fake; reader }>`

Routes return `{ todos: [...] }`, `{ projects: [...] }`, `{ areas: [...] }`, `{ tags: [...] }` for lists and the object itself for single items. Response schemas are permissive (`additionalProperties: true`) so Fastify never drops a field; the object shapes are documented once in `components.schemas` for Muse to read.

- [ ] **Step 1: Write the failing auth test**

`test/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BadKeyThrottle, bearer, keyMatches, newKey } from '../src/auth.ts'

describe('keys', () => {
  it('generates 32-byte base64url keys and matches only the right one', () => {
    const { key, hash } = newKey()
    expect(Buffer.from(key, 'base64url')).toHaveLength(32)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(keyMatches(key, hash)).toBe(true)
    expect(keyMatches(key + 'x', hash)).toBe(false)
    expect(keyMatches('', hash)).toBe(false)
    expect(newKey().key).not.toBe(key)
  })

  it('reads Bearer headers', () => {
    expect(bearer('Bearer abc')).toBe('abc')
    expect(bearer('Basic abc')).toBeNull()
    expect(bearer(undefined)).toBeNull()
  })
})

describe('BadKeyThrottle', () => {
  it('after 10 bad keys in a minute, throttles bad keys for 15 minutes', () => {
    let t = 0
    const th = new BadKeyThrottle(() => t)
    for (let i = 0; i < 10; i++) expect(th.fail()).toBe(false)
    expect(th.fail()).toBe(true)
    t += 14 * 60_000
    expect(th.fail()).toBe(true)
    t += 2 * 60_000
    expect(th.fail()).toBe(false)
  })

  it('forgets failures older than a minute', () => {
    let t = 0
    const th = new BadKeyThrottle(() => t)
    for (let i = 0; i < 9; i++) th.fail()
    t += 61_000
    expect(th.fail()).toBe(false)
    expect(th.fail()).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/auth.test.ts`
Expected: FAIL, cannot find `../src/auth.ts`.

- [ ] **Step 3: Implement auth**

`src/auth.ts`:

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function newKey(): { key: string; hash: string } {
  const key = randomBytes(32).toString('base64url')
  return { key, hash: hashKey(key) }
}

export function keyMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashKey(presented), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function bearer(header: string | undefined): string | null {
  const m = /^Bearer (.+)$/.exec(header ?? '')
  return m ? m[1].trim() : null
}

/** After 10 bad keys within a minute, bad keys get 429 for 15 minutes. A good key is never blocked. */
export class BadKeyThrottle {
  private failures: number[] = []
  private blockedUntil = 0
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** Records a bad key. Returns true when bad keys are currently throttled. */
  fail(): boolean {
    const t = this.now()
    if (t < this.blockedUntil) return true
    this.failures = this.failures.filter((x) => t - x < 60_000)
    this.failures.push(t)
    if (this.failures.length >= 10) {
      this.blockedUntil = t + 15 * 60_000
      this.failures = []
    }
    return false
  }
}
```

Run: `npx vitest run test/auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Write the failing server read test**

`test/helpers/app.ts`:

```ts
import { hashKey } from '../../src/auth.ts'
import { buildApp } from '../../src/server/app.ts'
import { ThingsDb } from '../../src/things/db.ts'
import { Writer } from '../../src/things/writer.ts'
import { FakeThings } from './fake-things.ts'
import type { Fixture } from './fixture.ts'

export const KEY = 'test-key'
export const auth = { authorization: `Bearer ${KEY}` }

/** The real app over a fixture database, with FakeThings standing in for Things. */
export async function testApp(f: Fixture) {
  const now = new Date(2026, 9, 15, 12, 0)
  const reader = new ThingsDb(f.path, () => now)
  const fake = new FakeThings(f, () => now)
  const writer = new Writer({
    reader, things: fake, openUrl: (u) => fake.openUrl(u), authToken: 'tok',
    audit: () => {}, now: () => now, pollMs: 5, timeoutMs: 1000,
  })
  const app = await buildApp({
    reader, writer, keyHash: hashKey(KEY), thingsRunning: async () => true,
    publicUrl: 'https://mac.example.ts.net',
  })
  return { app, fake, reader }
}
```

`test/server-read.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Fixture } from './helpers/fixture.ts'
import { auth, testApp } from './helpers/app.ts'
import { packDate } from '../src/things/dates.ts'

let app: FastifyInstance
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)
const get = (url: string) => app.inject({ url, headers: auth })

beforeAll(async () => {
  const f = new Fixture()
  f.area('A1', 'Home')
    .tag('T1', 'phone')
    .task({ uuid: 'P1', type: 1, title: 'Errands', area: 'A1' })
    .task({ uuid: 'H1', type: 2, title: 'Shops', project: 'P1' })
    .task({ uuid: 't1', title: 'Call the dentist', start: 1, startDate: packDate('2026-10-15') })
    .task({ uuid: 't2', title: 'Buy milk', heading: 'H1' })
    .task({ uuid: 'd1', title: 'Done', status: 3, stopDate: 1760600000 })
    .tagTask('t1', 'T1')
  ;({ app } = await testApp(f))
})
afterAll(() => app.close())

describe('access', () => {
  it('health needs no key and shows no Things data', async () => {
    const res = await app.inject({ url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, things_running: true, db_readable: true })
  })

  it('everything else needs the key', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 'test-key' }]) {
      const res = await app.inject({ url: '/lists/today', headers })
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('unauthorized')
    }
  })

  it('throttles repeated bad keys but never the right key', async () => {
    const { app: a } = await testApp(new Fixture())
    const bad = { authorization: 'Bearer nope' }
    for (let i = 0; i < 10; i++) expect((await a.inject({ url: '/tags', headers: bad })).statusCode).toBe(401)
    expect((await a.inject({ url: '/tags', headers: bad })).json().error.code).toBe('too_many_requests')
    expect((await a.inject({ url: '/tags', headers: auth })).statusCode).toBe(200)
    await a.close()
  })
})

describe('read endpoints', () => {
  it('lists', async () => {
    expect(ids((await get('/lists/today')).json().todos)).toEqual(['t1'])
    expect(ids((await get('/lists/logbook?since=2025-10-15&limit=1')).json().todos)).toEqual(['d1'])
    const bad = await get('/lists/someplace')
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('invalid_request')
    const extra = await get('/lists/today?color=red')
    expect(extra.statusCode).toBe(400)
    expect(extra.json().error.message).toContain('"color"')
  })

  it('search and single to-dos', async () => {
    expect(ids((await get('/todos?q=dentist')).json().todos)).toEqual(['t1'])
    expect((await get('/todos/t2')).json()).toMatchObject({ project: { id: 'P1' }, heading: { id: 'H1' }, area: { id: 'A1' } })
    const project = await get('/todos/P1')
    expect(project.statusCode).toBe(404)
    expect(project.json().error.message).toContain('/projects/P1')
    expect((await get('/todos/nope')).json().error.code).toBe('not_found')
  })

  it('projects, areas and tags', async () => {
    expect(ids((await get('/projects')).json().projects)).toEqual(['P1'])
    expect((await get('/projects/P1')).json().groups.map((g: { todos: { id: string }[] }) => ids(g.todos)))
      .toEqual([[], ['t2']])
    expect((await get('/projects/nope')).statusCode).toBe(404)
    expect((await get('/areas')).json().areas).toEqual([{ id: 'A1', title: 'Home', tags: [] }])
    expect(ids((await get('/areas/A1')).json().projects)).toEqual(['P1'])
    expect((await get('/tags')).json().tags).toEqual([{ id: 'T1', title: 'phone', parent: null }])
  })

  it('unknown endpoints are 404 not_found', async () => {
    const res = await get('/nope')
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })
})

describe('OpenAPI', () => {
  it('is public and describes auth, objects and sensitivity tags', async () => {
    const res = await app.inject({ url: '/openapi.json' })
    expect(res.statusCode).toBe(200)
    const doc = res.json()
    expect(doc.servers).toEqual([{ url: 'https://mac.example.ts.net' }])
    expect(doc.components.securitySchemes.bearer).toEqual({ type: 'http', scheme: 'bearer' })
    expect(doc.components.schemas.Todo.properties.when).toBeDefined()
    expect(doc.paths['/lists/{list}'].get.tags).toEqual(['read'])
    expect(doc.paths['/health'].get.security).toEqual([])
    expect(doc.paths['/openapi.json']).toBeUndefined()
  })
})
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run test/server-read.test.ts`
Expected: FAIL, cannot find `../../src/server/app.ts`.

- [ ] **Step 6: Implement schemas, app and read routes**

`src/server/schemas.ts`:

```ts
import { READABLE_LISTS } from '../things/types.ts'

export const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' }
export const TIME = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'HH:MM, 24-hour' }
export const WHEN = {
  type: 'string',
  pattern: '^(today|evening|tomorrow|anytime|someday|\\d{4}-\\d{2}-\\d{2})$',
  description: 'today, evening (This Evening), tomorrow, anytime, someday, or YYYY-MM-DD',
}
export const ID = { type: 'string', minLength: 1, maxLength: 100 }
export const ID_PARAMS = { type: 'object', properties: { id: ID }, required: ['id'] }

/** A permissive response schema: Fastify serializes every field; the shape is documented in COMPONENTS. */
export const objectReply = (description: string) => ({ description, type: 'object', additionalProperties: true })

const str = { type: 'string' }
const strOrNull = { type: ['string', 'null'] }
const refOrNull = { type: ['object', 'null'], properties: { id: str, title: str } }
const LISTS = ['inbox', 'today', 'evening', 'upcoming', 'anytime', 'someday', 'logbook', 'trash']

const TODO = {
  type: 'object',
  description: 'A Things to-do. Ids are stable.',
  properties: {
    id: str,
    title: str,
    notes: str,
    status: { enum: ['open', 'completed', 'canceled'] },
    list: { enum: LISTS, description: 'Where Things shows it now' },
    when: { ...strOrNull, description: 'Start date YYYY-MM-DD; null for Inbox, Anytime, Someday' },
    reminder: { ...strOrNull, description: 'Reminder time HH:MM on the when date' },
    deadline: { ...strOrNull, description: 'YYYY-MM-DD' },
    tags: { type: 'array', items: str },
    project: refOrNull,
    area: refOrNull,
    heading: refOrNull,
    checklist: { type: 'array', items: { type: 'object', properties: { id: str, title: str, done: { type: 'boolean' } } } },
    repeating: { type: 'boolean', description: 'A copy of a repeating to-do' },
    created_at: strOrNull,
    modified_at: strOrNull,
    completed_at: strOrNull,
  },
}

const PROJECT = {
  type: 'object',
  description: 'A Things project. Same fields as a to-do except checklist, heading, project and repeating.',
  properties: {
    ...Object.fromEntries(
      Object.entries(TODO.properties).filter(([k]) => !['checklist', 'heading', 'project', 'repeating'].includes(k)),
    ),
    todos_open: { type: 'integer' },
    headings: { type: 'array', items: refOrNull },
  },
}

export const COMPONENTS = {
  Todo: TODO,
  Project: PROJECT,
  ProjectDetail: {
    description: 'A project plus its open to-dos grouped by heading (heading null = no heading).',
    allOf: [
      { $ref: '#/components/schemas/Project' },
      { type: 'object', properties: { groups: { type: 'array', items: { type: 'object', properties: { heading: refOrNull, todos: { type: 'array', items: { $ref: '#/components/schemas/Todo' } } } } } } },
    ],
  },
  Area: { type: 'object', properties: { id: str, title: str, tags: { type: 'array', items: str } } },
  AreaDetail: {
    description: 'An area plus its open projects and the open to-dos directly in it.',
    allOf: [
      { $ref: '#/components/schemas/Area' },
      { type: 'object', properties: { projects: { type: 'array', items: { $ref: '#/components/schemas/Project' } }, todos: { type: 'array', items: { $ref: '#/components/schemas/Todo' } } } },
    ],
  },
  Tag: { type: 'object', properties: { id: str, title: str, parent: { ...strOrNull, description: 'Parent tag title' } } },
  Error: {
    type: 'object',
    properties: { error: { type: 'object', properties: { code: str, message: { ...str, description: 'Written to be shown to the user' } } } },
  },
}

export const LIST_PARAMS = { type: 'object', properties: { list: { type: 'string', enum: READABLE_LISTS } }, required: ['list'] }
```

`src/server/app.ts`:

```ts
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import swagger from '@fastify/swagger'
import { ApiError } from '../errors.ts'
import { BadKeyThrottle, bearer, keyMatches } from '../auth.ts'
import type { ThingsDb } from '../things/db.ts'
import type { Writer } from '../things/writer.ts'
import { COMPONENTS } from './schemas.ts'
import { readRoutes } from './read-routes.ts'

export type AppDeps = {
  reader: ThingsDb
  writer: Writer
  keyHash: string
  thingsRunning: () => Promise<boolean>
  publicUrl?: string
  throttle?: BadKeyThrottle
  logger?: boolean
}

const PUBLIC_ROUTES = new Set(['/health', '/openapi.json'])

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 65_536,
    ajv: { customOptions: { removeAdditional: false, allowUnionTypes: true } },
    schemaErrorFormatter: (errors, dataVar) =>
      new Error(errors.map((e) =>
        e.keyword === 'additionalProperties'
          ? `${dataVar} has an unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`
          : `${dataVar}${e.instancePath.replaceAll('/', '.')} ${e.message}`,
      ).join('; ')),
  })

  // Muse may send Content-Type: application/json with an empty body on action endpoints; treat that as no body.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined)
    try {
      done(null, JSON.parse(body as string))
    } catch {
      done(new ApiError(400, 'invalid_request', 'The request body is not valid JSON.'), undefined)
    }
  })

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'MuseThings',
        version: '0.1.0',
        description:
          "Read and manage the user's Things 3 to-dos. Every operation is tagged read, write or sensitive. " +
          'Always ask the user before a sensitive operation. Look up ids with the read operations before writing.',
      },
      servers: deps.publicUrl ? [{ url: deps.publicUrl }] : [],
      tags: [
        { name: 'read', description: 'Reads only; changes nothing' },
        { name: 'write', description: 'Changes Things' },
        { name: 'sensitive', description: 'Removes things or changes many at once; confirm with the user first' },
      ],
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
        schemas: COMPONENTS as never,
      },
      security: [{ bearer: [] }],
    },
  })

  const throttle = deps.throttle ?? new BadKeyThrottle()
  app.addHook('onRequest', async (req) => {
    if (PUBLIC_ROUTES.has(req.routeOptions.url ?? '')) return
    const key = bearer(req.headers.authorization)
    if (key && keyMatches(key, deps.keyHash)) return
    if (throttle.fail()) throw new ApiError(429, 'too_many_requests', 'Too many wrong API keys. Try again in 15 minutes.')
    throw new ApiError(401, 'unauthorized', 'Missing or wrong API key. Send Authorization: Bearer <key>.')
  })

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } })
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'invalid_request', message: err.message } })
    }
    req.log.error(err)
    return reply.status(500).send({
      error: { code: 'internal', message: 'Something went wrong in MuseThings; see ~/.musethings/server.log on the Mac.' },
    })
  })

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: `No endpoint ${req.method} ${req.url}` } }))

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())
  readRoutes(app, deps)
  return app
}
```

`src/server/read-routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { notFound } from '../errors.ts'
import type { TodoFilter } from '../things/db.ts'
import type { ReadableList } from '../things/types.ts'
import type { AppDeps } from './app.ts'
import { DATE, ID, ID_PARAMS, LIST_PARAMS, objectReply } from './schemas.ts'

const read = (operationId: string, summary: string, extra: object = {}) => ({ tags: ['read'], operationId, summary, ...extra })
const LIMIT = { type: 'integer', minimum: 1, maximum: 500, default: 100 }
type Id = { Params: { id: string } }

export function readRoutes(app: FastifyInstance, deps: AppDeps) {
  const { reader } = deps

  app.get('/health', {
    schema: read('health', 'Is the bridge up? (no key needed)', {
      security: [],
      response: { 200: objectReply('{ ok, things_running, db_readable }') },
    }),
  }, async () => {
    let dbReadable = true
    try {
      reader.listTags()
    } catch {
      dbReadable = false
    }
    return { ok: true, things_running: await deps.thingsRunning(), db_readable: dbReadable }
  })

  app.get<{ Params: { list: ReadableList }; Querystring: { limit?: number; since?: string } }>('/lists/:list', {
    schema: read('getList', 'To-dos in one Things list, in Things order', {
      description: 'today includes This Evening at the end (their list is "evening"). logbook is newest first.',
      params: LIST_PARAMS,
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: LIMIT, since: { ...DATE, description: 'logbook only: completed on or after this date' } },
      },
      response: { 200: objectReply('{ todos: Todo[] }') },
    }),
  }, async (req) => ({ todos: reader.listTodos(req.params.list, req.query) }))

  app.get<{ Querystring: TodoFilter }>('/todos', {
    schema: read('searchTodos', 'Search to-dos', {
      description: 'Filters combine. Only open to-dos unless status says otherwise. Soonest deadline first.',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string', minLength: 1, maxLength: 200, description: 'Text in title or notes' },
          tag: { type: 'string', minLength: 1, maxLength: 200, description: 'Tag title, any case' },
          project_id: ID,
          area_id: ID,
          deadline_before: { ...DATE, description: 'Deadline on or before this date' },
          status: { type: 'string', enum: ['open', 'completed', 'canceled', 'any'], default: 'open' },
          limit: LIMIT,
        },
      },
      response: { 200: objectReply('{ todos: Todo[] }') },
    }),
  }, async (req) => ({ todos: reader.searchTodos(req.query) }))

  app.get<Id>('/todos/:id', {
    schema: read('getTodo', 'One to-do', { params: ID_PARAMS, response: { 200: objectReply('Todo') } }),
  }, async (req) => {
    const todo = reader.getTodo(req.params.id)
    if (todo) return todo
    if (reader.kindOf(req.params.id) === 'project') {
      throw notFound(`${req.params.id} is a project; use /projects/${req.params.id}`)
    }
    throw notFound(`No to-do with id ${req.params.id}`)
  })

  app.get('/projects', {
    schema: read('listProjects', 'Open projects', { response: { 200: objectReply('{ projects: Project[] }') } }),
  }, async () => ({ projects: reader.listProjects() }))

  app.get<Id>('/projects/:id', {
    schema: read('getProject', 'One project with its open to-dos grouped by heading', {
      params: ID_PARAMS,
      response: { 200: objectReply('ProjectDetail') },
    }),
  }, async (req) => {
    const project = reader.getProjectDetail(req.params.id)
    if (!project) throw notFound(`No project with id ${req.params.id}`)
    return project
  })

  app.get('/areas', {
    schema: read('listAreas', 'Areas', { response: { 200: objectReply('{ areas: Area[] }') } }),
  }, async () => ({ areas: reader.listAreas() }))

  app.get<Id>('/areas/:id', {
    schema: read('getArea', 'One area with its open projects and loose to-dos', {
      params: ID_PARAMS,
      response: { 200: objectReply('AreaDetail') },
    }),
  }, async (req) => {
    const area = reader.getArea(req.params.id)
    if (!area) throw notFound(`No area with id ${req.params.id}`)
    return area
  })

  app.get('/tags', {
    schema: read('listTags', 'All tags', { response: { 200: objectReply('{ tags: Tag[] }') } }),
  }, async () => ({ tags: reader.listTags() }))
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/auth.test.ts test/server-read.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 8: Checkpoint**

Run: `npm test && npm run typecheck`
Expected: all pass, no type errors.

---

### Task 9: Write endpoints

**Files:**
- Create: `src/server/write-routes.ts`
- Modify: `src/server/app.ts` (register write routes)
- Test: `test/server-write.test.ts`

**Interfaces:**
- Consumes: `Writer` methods (Tasks 6–7), `TodoInput`, `TodoFields`, `ProjectInput`, `ProjectFields` (Tasks 6–7), `AppDeps`, schemas (Task 8)
- Produces: `writeRoutes(app: FastifyInstance, deps: AppDeps): void` with routes `POST /todos` (201), `PATCH /todos/:id`, `POST /todos/:id/{complete,cancel,reopen}`, `DELETE /todos/:id` (sensitive), `POST /projects` (201), `PATCH /projects/:id`, `POST /projects/:id/{complete,cancel}` (sensitive), `DELETE /projects/:id` (sensitive)

- [ ] **Step 1: Write the failing test**

`test/server-write.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Fixture } from './helpers/fixture.ts'
import { FakeThings } from './helpers/fake-things.ts'
import { auth, testApp } from './helpers/app.ts'

let app: FastifyInstance
let fake: FakeThings
type Method = 'POST' | 'PATCH' | 'DELETE'
const send = (method: Method, url: string, payload?: object) => app.inject({ method, url, payload, headers: auth })

beforeEach(async () => {
  const f = new Fixture()
  f.area('A1', 'Home')
    .task({ uuid: 'P1', type: 1, title: 'Errands' })
    .task({ uuid: 'x1', title: 'Water plants', start: 1 })
    .task({ uuid: 'tpl', title: 'Weekly review', start: 1, rt1_recurrenceRule: new Uint8Array([1]) })
  ;({ app, fake } = await testApp(f))
})
afterEach(() => app.close())

describe('to-do endpoints', () => {
  it('need the key and change nothing without it', async () => {
    const res = await app.inject({ method: 'POST', url: '/todos', payload: { title: 'x' } })
    expect(res.statusCode).toBe(401)
    expect(fake.log).toEqual([])
  })

  it('create', async () => {
    const res = await send('POST', '/todos', { title: 'Call the dentist', when: 'tomorrow', tags: ['phone'], project_id: 'P1' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ title: 'Call the dentist', list: 'upcoming', tags: ['phone'], project: { id: 'P1' } })
  })

  it('name the field in validation errors and touch nothing', async () => {
    const unknown = await send('POST', '/todos', { title: 'a', colour: 'red' })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().error).toEqual({ code: 'invalid_request', message: 'body has an unknown field "colour"' })
    expect((await send('POST', '/todos', { title: 'a', when: 'next week' })).json().error.message).toContain('body.when')
    expect((await send('PATCH', '/todos/x1', {})).statusCode).toBe(400)
    expect((await send('POST', '/todos', { title: 'a', notes: 'x'.repeat(10_001) })).json().error.message).toContain('body.notes')
    expect(fake.log).toEqual([])
  })

  it('update, complete, reopen, cancel and trash', async () => {
    expect((await send('PATCH', '/todos/x1', { when: 'evening', notes: null })).json()).toMatchObject({ list: 'evening', notes: '' })
    expect((await send('POST', '/todos/x1/complete')).json().status).toBe('completed')
    expect((await send('POST', '/todos/x1/reopen')).json().status).toBe('open')
    expect((await send('POST', '/todos/x1/cancel')).json().status).toBe('canceled')
    expect((await send('DELETE', '/todos/x1')).json().list).toBe('trash')
  })

  it('accept an empty JSON body on action endpoints', async () => {
    const res = await app.inject({
      method: 'POST', url: '/todos/x1/complete', headers: { ...auth, 'content-type': 'application/json' }, payload: '',
    })
    expect(res.statusCode).toBe(200)
  })

  it('pass writer errors through', async () => {
    expect((await send('PATCH', '/todos/tpl', { title: 'b' })).statusCode).toBe(409)
    expect((await send('POST', '/todos/nope/complete')).json().error.code).toBe('not_found')
    expect((await send('POST', '/todos', { title: 'a', when: '2020-01-01' })).json().error.message).toMatch(/past/)
  })

  it('reject bodies over 64 KB', async () => {
    const res = await send('POST', '/todos', { title: 'a', notes: 'x'.repeat(70_000) })
    expect(res.statusCode).toBe(413)
    expect(res.json().error.code).toBe('invalid_request')
  })
})

describe('project endpoints', () => {
  it('create, update, complete, trash', async () => {
    const created = await send('POST', '/projects', { title: 'Trip', area_id: 'A1', todos: ['Pack'] })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ todos_open: 1, area: { id: 'A1' } })
    const id = created.json().id
    expect((await send('PATCH', `/projects/${id}`, { title: 'Lisbon trip' })).json().title).toBe('Lisbon trip')
    expect((await send('POST', `/projects/${id}/complete`)).json().status).toBe('completed')
    expect((await send('DELETE', `/projects/${id}`)).json().list).toBe('trash')
  })
})

describe('OpenAPI', () => {
  it('tags each write operation write or sensitive', async () => {
    const doc = (await app.inject({ url: '/openapi.json' })).json()
    expect(doc.paths['/todos'].post.tags).toEqual(['write'])
    expect(doc.paths['/todos/{id}/complete'].post.tags).toEqual(['write'])
    expect(doc.paths['/todos/{id}'].delete.tags).toEqual(['sensitive'])
    expect(doc.paths['/projects/{id}/complete'].post.tags).toEqual(['sensitive'])
    expect(doc.paths['/projects/{id}'].delete.tags).toEqual(['sensitive'])
    expect(doc.paths['/todos'].post.requestBody.content['application/json'].schema.required).toEqual(['title'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/server-write.test.ts`
Expected: FAIL. Write routes are missing, so `POST /todos` returns 404.

- [ ] **Step 3: Implement the write routes and register them**

`src/server/write-routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { ProjectFields, ProjectInput, TodoFields, TodoInput } from '../things/changes.ts'
import type { AppDeps } from './app.ts'
import { DATE, ID, ID_PARAMS, TIME, WHEN, objectReply } from './schemas.ts'

const nullable = (s: object) => ({ ...s, type: ['string', 'null'] })
const TITLE = { type: 'string', minLength: 1, maxLength: 4000 }
const NOTES = { type: ['string', 'null'], maxLength: 10_000 }
const TAG_LIST = { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 } }
const LINES = { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4000 } }

const TODO_CREATE = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: TITLE,
    notes: NOTES,
    when: WHEN,
    reminder: { ...TIME, description: 'Needs a when date (not evening, anytime or someday)' },
    deadline: DATE,
    tags: { ...TAG_LIST, description: "Tag titles; ones that don't exist are created" },
    project_id: ID,
    area_id: ID,
    heading_id: { ...ID, description: 'A heading inside a project; implies that project' },
    checklist: { ...LINES, description: 'Checklist item titles' },
  },
}

const TODO_PATCH = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    title: TITLE,
    notes: NOTES,
    when: { ...nullable(WHEN), description: `${WHEN.description}; null = anytime` },
    reminder: nullable(TIME),
    deadline: nullable(DATE),
    list: { type: 'string', enum: ['inbox'], description: 'Move back to the Inbox' },
    tags: { ...TAG_LIST, description: 'Replaces all tags' },
    add_tags: TAG_LIST,
    remove_tags: TAG_LIST,
    project_id: ID,
    area_id: ID,
    heading_id: ID,
    checklist: { ...LINES, description: 'Replaces the checklist' },
    add_checklist: { ...LINES, description: 'Appends to the checklist' },
  },
}

const PROJECT_CREATE = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: TITLE,
    notes: NOTES,
    when: WHEN,
    deadline: DATE,
    tags: TAG_LIST,
    area_id: ID,
    todos: { ...LINES, description: 'Titles of to-dos to create inside the project' },
  },
}

const PROJECT_PATCH = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    title: TITLE,
    notes: NOTES,
    when: nullable(WHEN),
    deadline: nullable(DATE),
    tags: TAG_LIST,
    add_tags: TAG_LIST,
    remove_tags: TAG_LIST,
    area_id: ID,
  },
}

const op = (tag: 'write' | 'sensitive', operationId: string, summary: string, extra: object = {}) =>
  ({ tags: [tag], operationId, summary, ...extra })
const ASK_FIRST = 'Sensitive: ask the user before doing this.'
type Id = { Params: { id: string } }

export function writeRoutes(app: FastifyInstance, { writer }: AppDeps) {
  app.post<{ Body: TodoInput }>('/todos', {
    schema: op('write', 'createTodo', 'Create a to-do', {
      description: 'Goes to the Inbox unless when, project_id, area_id or heading_id put it somewhere else.',
      body: TODO_CREATE,
      response: { 201: objectReply('The new Todo') },
    }),
  }, async (req, reply) => reply.status(201).send(await writer.createTodo(req.body)))

  app.patch<Id & { Body: TodoFields }>('/todos/:id', {
    schema: op('write', 'updateTodo', 'Change a to-do', {
      description: 'Send only the fields to change. null clears when, reminder, deadline or notes.',
      params: ID_PARAMS,
      body: TODO_PATCH,
      response: { 200: objectReply('The updated Todo') },
    }),
  }, async (req) => writer.updateTodo(req.params.id, req.body))

  for (const action of ['complete', 'cancel', 'reopen'] as const) {
    app.post<Id>(`/todos/:id/${action}`, {
      schema: op('write', `${action}Todo`, `${action[0].toUpperCase()}${action.slice(1)} a to-do`, {
        params: ID_PARAMS,
        response: { 200: objectReply('The updated Todo') },
      }),
    }, async (req) => writer.setTodoStatus(req.params.id, action))
  }

  app.delete<Id>('/todos/:id', {
    schema: op('sensitive', 'trashTodo', 'Move a to-do to the Trash', {
      description: `${ASK_FIRST} It can be recovered from Things' Trash; MuseThings never empties it.`,
      params: ID_PARAMS,
      response: { 200: objectReply('The trashed Todo') },
    }),
  }, async (req) => writer.trashTodo(req.params.id))

  app.post<{ Body: ProjectInput }>('/projects', {
    schema: op('write', 'createProject', 'Create a project, optionally with to-dos', {
      body: PROJECT_CREATE,
      response: { 201: objectReply('The new Project') },
    }),
  }, async (req, reply) => reply.status(201).send(await writer.createProject(req.body)))

  app.patch<Id & { Body: ProjectFields }>('/projects/:id', {
    schema: op('write', 'updateProject', 'Change a project', {
      params: ID_PARAMS,
      body: PROJECT_PATCH,
      response: { 200: objectReply('The updated Project') },
    }),
  }, async (req) => writer.updateProject(req.params.id, req.body))

  for (const action of ['complete', 'cancel'] as const) {
    const verb = action === 'complete' ? 'completes' : 'cancels'
    app.post<Id>(`/projects/:id/${action}`, {
      schema: op('sensitive', `${action}Project`, `${action[0].toUpperCase()}${action.slice(1)} a project`, {
        description: `${ASK_FIRST} Things also ${verb} every open to-do in the project.`,
        params: ID_PARAMS,
        response: { 200: objectReply('The updated Project') },
      }),
    }, async (req) => writer.setProjectStatus(req.params.id, action))
  }

  app.delete<Id>('/projects/:id', {
    schema: op('sensitive', 'trashProject', 'Move a project and its to-dos to the Trash', {
      description: `${ASK_FIRST} Recoverable from Things' Trash.`,
      params: ID_PARAMS,
      response: { 200: objectReply('The trashed Project') },
    }),
  }, async (req) => writer.trashProject(req.params.id))
}
```

In `src/server/app.ts`, add the import and register the routes after the read routes:

```ts
import { writeRoutes } from './write-routes.ts'
```

```ts
  readRoutes(app, deps)
  writeRoutes(app, deps)
  return app
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/server-write.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck`
Expected: all pass, no type errors.

---

### Task 10: Command line: serve, keygen, config, doctor

`doctor` checks everything it can and prints one line per check, each failure with how to fix it. One check writes to Things: it creates a to-do called "MuseThings doctor check", renames it through the URL scheme (which proves the auth token works), then moves it to the Trash.

macOS asks for permission per app. Running `doctor` from Terminal asks for Terminal's permission to control Things. The background server (`node` under launchd) gets its own prompts the first time it reads or writes, which Task 11's smoke script triggers.

**Files:**
- Create: `src/doctor.ts`, `src/cli.ts`
- Test: `test/doctor.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `readConfig`, `writeConfig`, `setConfigValue`, `loadServeConfig`, `DEFAULTS` (Task 1); `newKey`, `hashKey` (Task 8); `buildApp` (Tasks 8–9); `ThingsDb`, `findDbPath` (Tasks 3–4); `Writer` (Tasks 6–7); `appleScriptThings`, `makeSystem`, `execRunner` (Task 5); `fileAudit` (Task 6)
- Produces:
  - `type Check = { name: string; ok: boolean | null; detail: string }` (`null` = skipped)
  - `type DoctorDeps = { config; openDb(): ThingsDb; sys: Pick<System, 'thingsRunning' | 'launchThings'>; things: Pick<ThingsScripts, 'ping'>; makeWriter(reader): Pick<Writer, 'createTodo' | 'updateTodo' | 'trashTodo'>; httpOk(url): Promise<boolean>; funnelStatus(): Promise<string | null> }`
  - `runChecks(d: DoctorDeps): Promise<Check[]>`, `report(checks): { text: string; ok: boolean }`
  - CLI: `node src/cli.ts serve | keygen | config set <key> <value> | doctor`

- [ ] **Step 1: Write the failing doctor test**

`test/doctor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Fixture } from './helpers/fixture.ts'
import { FakeThings } from './helpers/fake-things.ts'
import { DEFAULTS } from '../src/config.ts'
import { ApiError } from '../src/errors.ts'
import { ThingsDb } from '../src/things/db.ts'
import { Writer } from '../src/things/writer.ts'
import { report, runChecks, type DoctorDeps } from '../src/doctor.ts'

const now = () => new Date(2026, 9, 15, 12, 0)

function setup(over: Partial<DoctorDeps> = {}) {
  const f = new Fixture()
  const fake = new FakeThings(f, now)
  const d: DoctorDeps = {
    config: { ...DEFAULTS, keyHash: 'h', thingsAuthToken: 't', publicUrl: 'https://mac.example.ts.net' },
    openDb: () => new ThingsDb(f.path, now),
    sys: { thingsRunning: async () => true, launchThings: async () => {} },
    things: fake,
    makeWriter: (reader) => new Writer({
      reader, things: fake, openUrl: (u) => fake.openUrl(u), authToken: 't', audit: () => {}, now, pollMs: 5, timeoutMs: 300,
    }),
    httpOk: async () => true,
    funnelStatus: async () => 'https://mac.example.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:8787',
    ...over,
  }
  return { d, fake }
}

describe('doctor', () => {
  it('all green on a finished setup, and cleans up its test to-do', async () => {
    const { d, fake } = setup()
    const { text, ok } = report(await runChecks(d))
    expect(ok).toBe(true)
    expect(text).not.toContain('✘')
    expect(text).toContain('✔ Things URL token works')
    expect(fake.log.some((l) => l.startsWith('trash:'))).toBe(true)
  })

  it('says what to fix on a fresh Mac and skips checks that depend on them', async () => {
    const { d } = setup({
      config: { ...DEFAULTS },
      things: { ping: async () => { throw new ApiError(503, 'setup_required', "macOS hasn't allowed MuseThings to control Things.") } },
      httpOk: async () => false,
      funnelStatus: async () => null,
    })
    const { text, ok } = report(await runChecks(d))
    expect(ok).toBe(false)
    expect(text).toContain('✘ API key: run: node src/cli.ts keygen')
    expect(text).toContain('✘ Control of Things (Automation): macOS hasn')
    expect(text).toContain('– Things URL token works: skipped')
    expect(text).toContain('✘ Tailscale Funnel: tailscale CLI not found')
    expect(text).toContain('✘ Public URL: run: node src/cli.ts config set publicUrl')
  })

  it('catches a wrong Things auth token', async () => {
    const { d, fake } = setup()
    fake.ignoreUrls = true
    const { text, ok } = report(await runChecks(d))
    expect(ok).toBe(false)
    expect(text).toMatch(/✘ Things URL token works: .*copy the token again/)
  })

  it('launches Things when it is not running', async () => {
    let launched = false
    const { d } = setup({ sys: { thingsRunning: async () => launched, launchThings: async () => { launched = true } } })
    const { text } = report(await runChecks(d))
    expect(launched).toBe(true)
    expect(text).toContain('✔ Things running')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/doctor.test.ts`
Expected: FAIL, cannot find `../src/doctor.ts`.

- [ ] **Step 3: Implement doctor**

`src/doctor.ts`:

```ts
import type { Config } from './config.ts'
import type { ThingsScripts } from './things/applescript.ts'
import type { ThingsDb } from './things/db.ts'
import type { System } from './things/system.ts'
import type { Writer } from './things/writer.ts'

export type Check = { name: string; ok: boolean | null; detail: string }

export type DoctorDeps = {
  config: Config
  openDb: () => ThingsDb
  sys: Pick<System, 'thingsRunning' | 'launchThings'>
  things: Pick<ThingsScripts, 'ping'>
  makeWriter: (reader: ThingsDb) => Pick<Writer, 'createTodo' | 'updateTodo' | 'trashTodo'>
  httpOk: (url: string) => Promise<boolean>
  funnelStatus: () => Promise<string | null>
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function runChecks(d: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = []
  const add = (name: string, ok: boolean, good: string, bad: string) => {
    checks.push({ name, ok, detail: ok ? good : bad })
    return ok
  }

  add('API key', !!d.config.keyHash, 'set', 'run: node src/cli.ts keygen')
  const hasToken = add('Things URL auth token', !!d.config.thingsAuthToken, 'set',
    'in Things → Settings → General, turn on Enable Things URLs, click Manage, copy the token, then run: ' +
    'node src/cli.ts config set thingsAuthToken <token>')

  let reader: ThingsDb | null = null
  try {
    reader = d.openDb()
    reader.listTags()
    add('Things database', true, 'readable', '')
  } catch (err) {
    reader = null
    add('Things database', false, '', message(err))
  }

  if (!(await d.sys.thingsRunning())) await d.sys.launchThings()
  add('Things running', await d.sys.thingsRunning(), 'yes', 'open Things 3 on this Mac and add it to Login Items')

  let canControl = false
  try {
    await d.things.ping()
    canControl = add('Control of Things (Automation)', true, 'allowed', '')
  } catch (err) {
    add('Control of Things (Automation)', false, '', message(err))
  }

  if (reader && canControl && hasToken) {
    const writer = d.makeWriter(reader)
    let id: string | null = null
    try {
      id = (await writer.createTodo({ title: 'MuseThings doctor check' })).id
      await writer.updateTodo(id, { title: 'MuseThings doctor check ✓' })
      add('Things URL token works', true, "created, renamed and trashed a test to-do (it's in Things' Trash)", '')
    } catch (err) {
      add('Things URL token works', false, '',
        `${message(err)} If Things showed an auth-token error, copy the token again.`)
    } finally {
      if (id) await writer.trashTodo(id).catch(() => undefined)
    }
  } else {
    checks.push({ name: 'Things URL token works', ok: null, detail: 'skipped: needs the database, Automation and the token' })
  }

  const local = `http://127.0.0.1:${d.config.port}/health`
  add('Server running', await d.httpOk(local), local, `${local} isn't answering; run: scripts/install-agent.sh`)

  const funnel = await d.funnelStatus()
  add('Tailscale Funnel', !!funnel && funnel.includes(`:${d.config.port}`), 'forwarding to the server',
    funnel === null
      ? 'tailscale CLI not found or not running: install Tailscale, sign in, and turn on its CLI'
      : `run: tailscale funnel --bg ${d.config.port}`)

  if (d.config.publicUrl) {
    add('Public URL', await d.httpOk(`${d.config.publicUrl}/health`), d.config.publicUrl,
      `${d.config.publicUrl}/health isn't reachable; check Funnel and the URL`)
  } else {
    add('Public URL', false, '', 'run: node src/cli.ts config set publicUrl https://<mac>.<tailnet>.ts.net')
  }
  return checks
}

export function report(checks: Check[]): { text: string; ok: boolean } {
  const icon = (c: Check) => (c.ok === true ? '✔' : c.ok === false ? '✘' : '–')
  return {
    text: checks.map((c) => `${icon(c)} ${c.name}: ${c.detail}`).join('\n'),
    ok: checks.every((c) => c.ok !== false),
  }
}
```

Run: `npx vitest run test/doctor.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Write the failing CLI test**

`test/cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hashKey } from '../src/auth.ts'

function cli(home: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ['src/cli.ts', ...args], {
    env: { ...process.env, MUSETHINGS_HOME: home },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout + r.stderr }
}
const freshHome = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-cli-')), 'home')

describe('cli', () => {
  it('prints usage with no command', () => {
    const r = cli(freshHome())
    expect(r.code).toBe(0)
    expect(r.out).toContain('Usage: node src/cli.ts')
  })

  it('keygen prints a key once and stores only its hash', () => {
    const home = freshHome()
    const r = cli(home, 'keygen')
    expect(r.code).toBe(0)
    const key = /^\s{2}(\S{43})$/m.exec(r.out)![1]
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
    expect(cfg.keyHash).toBe(hashKey(key))
    expect(JSON.stringify(cfg)).not.toContain(key)
  })

  it('config set saves known settings and rejects others', () => {
    const home = freshHome()
    expect(cli(home, 'config', 'set', 'port', '9000').code).toBe(0)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).port).toBe(9000)
    const bad = cli(home, 'config', 'set', 'nope', 'x')
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('Unknown setting "nope"')
  })

  it('serve refuses to start before setup', () => {
    const r = cli(freshHome(), 'serve')
    expect(r.code).toBe(1)
    expect(r.out).toContain("MuseThings isn't set up")
  })
})
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL. `src/cli.ts` doesn't exist, so the processes exit with an error.

- [ ] **Step 6: Implement the CLI**

`src/cli.ts`:

```ts
import { newKey } from './auth.ts'
import { fileAudit } from './audit.ts'
import { loadServeConfig, readConfig, setConfigValue, writeConfig } from './config.ts'
import { report, runChecks } from './doctor.ts'
import { buildApp } from './server/app.ts'
import { appleScriptThings } from './things/applescript.ts'
import { ThingsDb, findDbPath } from './things/db.ts'
import { execRunner, makeSystem } from './things/system.ts'
import { Writer } from './things/writer.ts'

const USAGE = `Usage: node src/cli.ts <command>
  serve                      run the API on 127.0.0.1:<port>
  keygen                     make a new API key (shown once; the old key stops working)
  config set <key> <value>   port | thingsAuthToken | publicUrl | timezone
  doctor                     check the setup and say what to fix`

async function serve() {
  const cfg = loadServeConfig()
  if (cfg.timezone) process.env.TZ = cfg.timezone
  const sys = makeSystem()
  const ensureThings = async () => {
    if (!(await sys.thingsRunning())) await sys.launchThings()
  }
  await ensureThings()
  const reader = new ThingsDb(findDbPath())
  const writer = new Writer({
    reader, things: appleScriptThings(sys), openUrl: sys.openUrl, authToken: cfg.thingsAuthToken,
    audit: fileAudit(), ensureThings,
  })
  const app = await buildApp({
    reader, writer, keyHash: cfg.keyHash, publicUrl: cfg.publicUrl || undefined,
    thingsRunning: sys.thingsRunning, logger: true,
  })
  await app.listen({ host: '127.0.0.1', port: cfg.port })
}

function keygen() {
  const { key, hash } = newKey()
  writeConfig({ ...readConfig(), keyHash: hash })
  console.log(`New API key. It is shown only now; the old key stops working once the server restarts:

  ${key}

Restart the server:  launchctl kickstart -k gui/$(id -u)/app.musethings
Then give the key to Muse (see docs/muse-connector.md).`)
}

async function doctor() {
  const config = readConfig()
  if (config.timezone) process.env.TZ = config.timezone
  const sys = makeSystem()
  const things = appleScriptThings(sys)
  const checks = await runChecks({
    config,
    openDb: () => new ThingsDb(findDbPath()),
    sys,
    things,
    makeWriter: (reader) => new Writer({
      reader, things, openUrl: sys.openUrl, authToken: config.thingsAuthToken, audit: fileAudit(),
    }),
    httpOk: async (url) => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(5000) })).ok
      } catch {
        return false
      }
    },
    funnelStatus: async () => {
      for (const bin of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
        try {
          return await execRunner(bin, ['funnel', 'status'])
        } catch {
          // try the next location
        }
      }
      return null
    },
  })
  const { text, ok } = report(checks)
  console.log(text)
  process.exitCode = ok ? 0 : 1
}

const [command, ...args] = process.argv.slice(2)
try {
  if (command === 'serve') await serve()
  else if (command === 'keygen') keygen()
  else if (command === 'config' && args[0] === 'set' && args.length === 3) {
    setConfigValue(args[1], args[2])
    console.log(`Saved ${args[1]}.`)
  } else if (command === 'doctor') await doctor()
  else {
    console.log(USAGE)
    process.exitCode = command ? 1 : 0
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/cli.test.ts test/doctor.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 8: Try doctor on the dev Mac**

Run: `MUSETHINGS_HOME=$(mktemp -d) node src/cli.ts doctor`
Expected: a ✘ list (no key, no token, no server, no Funnel) and exit code 1. If this Mac has Things, "Things database" is ✔ and macOS may ask whether Terminal can control Things. Nothing is written to Things, because the token check is skipped without a token.

- [ ] **Step 9: Checkpoint**

Run: `npm test && npm run typecheck`
Expected: all pass, no type errors.

---

### Task 11: Run at login, smoke test, setup docs, live tests

**Files:**
- Create: `launchd/app.musethings.plist.template`, `scripts/install-agent.sh`, `scripts/smoke.sh`, `README.md`, `docs/muse-connector.md`, `test/live/live.test.ts`

**Interfaces:**
- Consumes: the CLI (Task 10), `Writer`, `ThingsDb`, `appleScriptThings`, `makeSystem`, `readConfig`, `addDays`, `todayIso`
- Produces: a LaunchAgent labelled `app.musethings` running `node src/cli.ts serve` at login and logging to `~/.musethings/server.log`; `scripts/smoke.sh` (end-to-end over HTTP); `npm run test:live`

- [ ] **Step 1: LaunchAgent template and installer**

`launchd/app.musethings.plist.template`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.musethings</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE__</string>
    <string>__DIR__/src/cli.ts</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>__DIR__</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>__HOME__/.musethings/server.log</string>
  <key>StandardErrorPath</key><string>__HOME__/.musethings/server.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
  </dict>
</dict>
</plist>
```

`scripts/install-agent.sh`:

```bash
#!/bin/bash
# Installs (or reinstalls) the LaunchAgent that runs the MuseThings server at login.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
case "$("$NODE" -v)" in
  v2[4-9]*|v[3-9][0-9]*) ;;
  *) echo "MuseThings needs Node 24 or newer; found $("$NODE" -v) at $NODE" >&2; exit 1 ;;
esac
PLIST="$HOME/Library/LaunchAgents/app.musethings.plist"
mkdir -p "$HOME/.musethings" "$HOME/Library/LaunchAgents"
chmod 700 "$HOME/.musethings"
sed -e "s|__NODE__|$NODE|g" -e "s|__DIR__|$DIR|g" -e "s|__HOME__|$HOME|g" \
  "$DIR/launchd/app.musethings.plist.template" > "$PLIST"
launchctl bootout "gui/$(id -u)/app.musethings" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $PLIST (node: $NODE). Logs: ~/.musethings/server.log"
```

Run: `chmod +x scripts/install-agent.sh && bash -n scripts/install-agent.sh && plutil -lint launchd/app.musethings.plist.template`
Expected: no output from `bash -n`; `plutil` prints `OK`.

- [ ] **Step 2: Smoke script**

`scripts/smoke.sh`:

```bash
#!/bin/bash
# End-to-end check over HTTP. Creates a to-do "MuseThings smoke test", renames, completes and trashes it.
# Run it at the Mac the first time: macOS asks whether node may control Things and read its data. Click Allow.
# Usage: MUSETHINGS_KEY=<key> scripts/smoke.sh [base-url]   (default http://127.0.0.1:8787)
set -euo pipefail
BASE="${1:-http://127.0.0.1:8787}"
: "${MUSETHINGS_KEY:?Set MUSETHINGS_KEY to the key printed by keygen}"
AUTH=(-H "Authorization: Bearer $MUSETHINGS_KEY")
JSON=(-H 'Content-Type: application/json')
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }

echo "1. health:  $(curl -fsS "$BASE/health")"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/lists/today")
[ "$code" = 401 ] && echo "2. no key → 401 ✔" || { echo "2. no key gave $code, expected 401 ✘"; exit 1; }
curl -fsS "${AUTH[@]}" "$BASE/lists/today" > /dev/null && echo "3. read Today ✔"
id=$(curl -fsS "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/todos" -d '{"title":"MuseThings smoke test","when":"today"}' | field id)
echo "4. created $id ✔"
title=$(curl -fsS "${AUTH[@]}" "${JSON[@]}" -X PATCH "$BASE/todos/$id" -d '{"title":"MuseThings smoke test ✓"}' | field title)
echo "5. renamed to \"$title\" ✔"
status=$(curl -fsS "${AUTH[@]}" -X POST "$BASE/todos/$id/complete" | field status)
echo "6. status $status ✔"
list=$(curl -fsS "${AUTH[@]}" -X DELETE "$BASE/todos/$id" | field list)
echo "7. moved to $list ✔"
echo "All good."
```

Run: `chmod +x scripts/smoke.sh && bash -n scripts/smoke.sh`
Expected: no output.

- [ ] **Step 3: Muse connector instructions**

`docs/muse-connector.md`:

````markdown
# Connecting Muse to Things

You need the public URL (`node src/cli.ts config set publicUrl …` on the spare Mac) and the API key from `keygen`.

1. Open Muse and start a chat.
2. Paste this, with your URL and key filled in:

   > Create a custom connector called "Things" for my Things 3 to-dos. Its API is described at
   > https://YOUR-MAC.YOUR-TAILNET.ts.net/openapi.json. Authenticate every request with the header
   > `Authorization: Bearer YOUR-KEY`. Operations tagged "sensitive" (moving to the Trash,
   > completing or canceling a whole project) must always be confirmed with me first. Look up ids with
   > the read operations before changing anything.

3. If Muse asks how to authenticate, choose API key / bearer token and paste the key.
4. Test it: "What's on my Today list in Things?"

If you rotate the key (`node src/cli.ts keygen`), update it in Muse → Settings → Connectors → Things.
````

- [ ] **Step 4: README with the spare-Mac setup checklist**

`README.md`:

````markdown
# MuseThings

Lets Muse (Meta's personal AI agent) read and manage Things 3 through a custom connector.
A small API runs on an always-on Mac next to Things and is published with Tailscale Funnel.
Design: `docs/superpowers/specs/2026-10-15-muse-things-bridge-design.md`.

## Set up the spare Mac

1. **macOS and Things.** Update macOS as far as it goes. Install Things 3 from the App Store, sign in to
   Things Cloud with your account, and check a to-do syncs from your phone. Add Things to
   System Settings → General → Login Items.
2. **Things URLs.** Things → Settings → General → turn on *Enable Things URLs* → *Manage* → copy the token.
3. **Power.** Keep it plugged in with the lid open (a closed MacBook sleeps without an external display).
   Run `sudo pmset -c sleep 0 disksleep 0 displaysleep 5 womp 1`. In System Settings → Battery, keep battery
   health management / optimized charging on. In Software Update, turn off automatic macOS installs so
   restarts happen when you choose. FileVault stays on: after any restart, log in once at the Mac.
4. **Code.** Install Node 24 (`brew install node@24` or nvm). Copy this folder to the Mac, then:
   ```bash
   npm ci
   node src/cli.ts config set thingsAuthToken <token from step 2>
   node src/cli.ts keygen          # save the printed key somewhere safe
   node src/cli.ts doctor          # click Allow when macOS asks about Terminal controlling Things
   ```
5. **Run at login.** `scripts/install-agent.sh`, then at the Mac: `MUSETHINGS_KEY=<key> scripts/smoke.sh`.
   macOS asks whether *node* may control Things and access its data. Click Allow for both.
6. **Tailscale Funnel.** Install Tailscale from tailscale.com, sign in, turn on its CLI, then
   `tailscale funnel --bg 8787`. The first time, it prints a link to enable Funnel for your tailnet.
   `tailscale funnel status` shows the public URL; save it:
   `node src/cli.ts config set publicUrl https://<mac>.<tailnet>.ts.net` and restart the agent:
   `launchctl kickstart -k gui/$(id -u)/app.musethings`.
7. **Check.** `node src/cli.ts doctor` should be all ✔. From another device:
   `MUSETHINGS_KEY=<key> scripts/smoke.sh https://<mac>.<tailnet>.ts.net`.
8. **Muse.** Follow `docs/muse-connector.md`.

## Day to day

- Logs: `~/.musethings/server.log`. Every change Muse made: `~/.musethings/audit.jsonl`.
- Restart: `launchctl kickstart -k gui/$(id -u)/app.musethings`. Stop: `launchctl bootout gui/$(id -u)/app.musethings`.
- New key: `node src/cli.ts keygen`, restart, update Muse.

## Development

`npm test` (unit + route tests, no Things needed) · `npm run typecheck` ·
`npm run test:live` (spare Mac only: writes into a temporary "MuseThings Test" area in your real Things,
then trashes it; delete the `musethings-test` tag afterwards).
````

- [ ] **Step 5: Live tests against real Things**

`test/live/live.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readConfig } from '../../src/config.ts'
import { appleScriptThings } from '../../src/things/applescript.ts'
import { addDays, todayIso } from '../../src/things/dates.ts'
import { ThingsDb, findDbPath } from '../../src/things/db.ts'
import { makeSystem } from '../../src/things/system.ts'
import { Writer } from '../../src/things/writer.ts'
import type { TodoInput } from '../../src/things/changes.ts'

const LIVE = !!process.env.MUSETHINGS_LIVE
const TAG = 'musethings-test'

describe.skipIf(!LIVE)('live Things (temporary "MuseThings Test" area, trashed afterwards)', { timeout: 30_000 }, () => {
  const sys = makeSystem()
  const things = appleScriptThings(sys)
  const today = todayIso()
  const created: { kind: 'todo' | 'project'; id: string }[] = []
  let reader: ThingsDb
  let writer: Writer
  let areaId = ''

  beforeAll(async () => {
    const cfg = readConfig()
    if (!cfg.thingsAuthToken) throw new Error('Set the token first: node src/cli.ts config set thingsAuthToken <token>')
    reader = new ThingsDb(findDbPath())
    writer = new Writer({ reader, things, openUrl: sys.openUrl, authToken: cfg.thingsAuthToken, audit: () => {} })
    areaId = await things.createArea('MuseThings Test')
  })

  afterAll(async () => {
    for (const c of created.reverse()) {
      await (c.kind === 'todo' ? things.trashTodo(c.id) : things.trashProject(c.id)).catch(() => undefined)
    }
    if (areaId) await things.deleteArea(areaId).catch(() => undefined)
  })

  const todo = async (input: Omit<TodoInput, 'area_id'>) => {
    const t = await writer.createTodo({ area_id: areaId, ...input })
    created.push({ kind: 'todo', id: t.id })
    return t
  }

  it('creates a to-do with every field', async () => {
    const t = await todo({
      title: 'Live: full', notes: 'notes', when: 'tomorrow', reminder: '09:30',
      deadline: addDays(today, 3), tags: [TAG], checklist: ['one', 'two'],
    })
    expect(t).toMatchObject({
      when: addDays(today, 1), reminder: '09:30', deadline: addDays(today, 3), tags: [TAG],
      area: { id: areaId }, list: 'upcoming',
    })
    expect(t.checklist.map((c) => c.title)).toEqual(['one', 'two'])
  })

  it('keeps text that looks like code exactly (Review Focus 1)', async () => {
    const title = `Live: "q" & (do shell script "echo hi") & \\ 🎉 #1 = 2`
    const notes = 'line 1\nline 2 & "quoted" 🎉'
    const t = await todo({ title: 'Live: text' })
    expect(await writer.updateTodo(t.id, { title, notes })).toMatchObject({ title, notes })
  })

  it('schedules evening, someday, anytime and a date with a reminder', async () => {
    const t = await todo({ title: 'Live: schedule' })
    expect((await writer.updateTodo(t.id, { when: 'evening' })).list).toBe('evening')
    expect((await writer.updateTodo(t.id, { when: 'someday' })).list).toBe('someday')
    expect((await writer.updateTodo(t.id, { when: null })).list).toBe('anytime')
    expect(await writer.updateTodo(t.id, { when: addDays(today, 2), reminder: '18:15' }))
      .toMatchObject({ when: addDays(today, 2), reminder: '18:15', list: 'upcoming' })
    expect((await writer.updateTodo(t.id, { reminder: null })).reminder).toBeNull()
  })

  it('edits tags, checklist and deadline', async () => {
    const t = await todo({ title: 'Live: edits', tags: [TAG], checklist: ['a'], deadline: addDays(today, 4) })
    expect((await writer.updateTodo(t.id, { remove_tags: [TAG] })).tags).toEqual([])
    expect((await writer.updateTodo(t.id, { add_tags: [TAG] })).tags).toEqual([TAG])
    expect((await writer.updateTodo(t.id, { add_checklist: ['b'] })).checklist.map((c) => c.title)).toEqual(['a', 'b'])
    expect((await writer.updateTodo(t.id, { deadline: null })).deadline).toBeNull()
  })

  it('completes, reopens and cancels', async () => {
    const t = await todo({ title: 'Live: status' })
    expect((await writer.setTodoStatus(t.id, 'complete')).status).toBe('completed')
    expect((await writer.setTodoStatus(t.id, 'reopen')).status).toBe('open')
    expect((await writer.setTodoStatus(t.id, 'cancel')).status).toBe('canceled')
    expect((await writer.setTodoStatus(t.id, 'reopen')).status).toBe('open')
  })

  it('moves to the Inbox and back to the area', async () => {
    const t = await todo({ title: 'Live: move' })
    expect((await writer.updateTodo(t.id, { list: 'inbox' })).list).toBe('inbox')
    expect((await writer.updateTodo(t.id, { area_id: areaId })).area?.id).toBe(areaId)
  })

  it('creates, edits, completes and trashes a project', async () => {
    const p = await writer.createProject({ title: 'Live: project', area_id: areaId, todos: ['a', 'b'] })
    created.push({ kind: 'project', id: p.id })
    expect(p.todos_open).toBe(2)
    const moved = await todo({ title: 'Live: into project' })
    expect((await writer.updateTodo(moved.id, { project_id: p.id })).project?.id).toBe(p.id)
    expect(await writer.updateProject(p.id, { title: 'Live: project 2', deadline: addDays(today, 5), tags: [TAG] }))
      .toMatchObject({ title: 'Live: project 2', deadline: addDays(today, 5), tags: [TAG] })
    expect((await writer.setProjectStatus(p.id, 'complete')).status).toBe('completed')
    const children = reader.searchTodos({ project_id: p.id, status: 'any' })
    expect(children.every((c) => c.status !== 'open')).toBe(true)
    expect((await writer.trashProject(p.id)).list).toBe('trash')
  })

  it('trashes a to-do', async () => {
    const t = await todo({ title: 'Live: trash' })
    expect((await writer.trashTodo(t.id)).list).toBe('trash')
  })
})
```

Run (dev Mac): `npx vitest run test/live`
Expected: the suite is **skipped** (no `MUSETHINGS_LIVE`). It runs for real in Task 12.

- [ ] **Step 6: Checkpoint**

Run: `npm test && npm run typecheck`
Expected: all pass (live suite skipped), no type errors.

---

### Task 12: Set up the spare Mac and accept it in Muse

No new code. This task proves the whole chain works and fixes anything the live run uncovers. If a live test fails, fix the code with a failing unit test first (fake Things included), then rerun the live suite.

- [ ] **Step 1: Set up the spare Mac** by following `README.md` steps 1–6.

- [ ] **Step 2: Run the live suite on the spare Mac**

Run: `npm run test:live`
Expected: 8 tests pass, the "MuseThings Test" area appears briefly in Things (and on the phone via sync), then everything is in the Trash. This is where Things' real behavior is confirmed: tags created through AppleScript, `reminder: null` clearing the reminder, `when=anytime` clearing a date, project completion completing its to-dos, and the notes format. Delete the `musethings-test` tag in Things afterwards.

- [ ] **Step 3: `doctor` is all ✔**

Run: `node src/cli.ts doctor`
Expected: every line ✔, exit code 0.

- [ ] **Step 4: Smoke test from another device through Funnel**

Run (main Mac): `MUSETHINGS_KEY=<key> scripts/smoke.sh https://<mac>.<tailnet>.ts.net`
Expected: steps 1–7 ✔ and "All good."

- [ ] **Step 5: Connect Muse** following `docs/muse-connector.md`.

- [ ] **Step 6: Run the spec's success criteria in Muse** (main laptop closed, phone only)

1. "What's on my Today in Things?" → matches the Today list in Things exactly.
2. "Add *call the dentist* to my Errands project for tomorrow, deadline Friday, tag *phone*" → appears on the phone within a minute with all four details.
3. "Move it to this evening with a reminder…" → Muse should report the evening/reminder rule; then "remind me at 6 pm today" works. Complete it, reopen it, add a checklist, then "trash it": Muse asks before trashing.
4. All of the above with the main laptop closed.
5. `curl -i https://<mac>.<tailnet>.ts.net/lists/today` without a key → `401`.
6. Quit Things on the spare Mac, ask Muse to add a to-do → it works (Things relaunches). Restart the spare Mac, log in once, ask again → it works.

- [ ] **Step 7: Done.** Report results to Nicolas, including anything Muse handled awkwardly (for example how it showed the `sensitive` confirmations).
