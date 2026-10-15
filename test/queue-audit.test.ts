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
