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
