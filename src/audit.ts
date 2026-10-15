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
