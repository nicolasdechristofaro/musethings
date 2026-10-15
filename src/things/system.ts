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
