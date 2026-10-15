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
