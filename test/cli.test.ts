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
