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
