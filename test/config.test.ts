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
