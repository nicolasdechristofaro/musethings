import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ApiError, notFound } from '../errors.ts'

const execFileP = promisify(execFile)

export type Runner = (file: string, args: string[]) => Promise<string>

export const OSASCRIPT_TIMEOUT_MS = 10_000

export const execRunner: Runner = async (file, args) =>
  (await execFileP(file, args, { timeout: OSASCRIPT_TIMEOUT_MS })).stdout

export type System = {
  osascript(script: string, args: string[]): Promise<string>
  openUrl(url: string): Promise<void>
  thingsRunning(): Promise<boolean>
  launchThings(): Promise<void>
}

export function mapAppleScriptError(err: unknown): ApiError {
  const e = err as { stderr?: string; killed?: boolean; signal?: string }
  if (e?.killed || e?.signal === 'SIGTERM') {
    return new ApiError(503, 'write_not_confirmed',
      `Things didn't respond within ${OSASCRIPT_TIMEOUT_MS / 1000} s; it may be showing a dialog on the Mac. ` +
      'The change may still happen once Things responds, so check before trying again.')
  }
  // Only osascript's own error text: the Error message would repeat the script source.
  const text = String(e?.stderr ?? '').trim()
  if (/-1743|not authorized to send apple events/i.test(text)) {
    return new ApiError(503, 'setup_required',
      "macOS hasn't allowed MuseThings to control Things. On the Mac, run `node src/cli.ts doctor` and click Allow.")
  }
  if (/-1728|can[’']t get/i.test(text)) return notFound('Things has no item with that id.')
  return new ApiError(503, 'things_unavailable',
    text ? `Things returned an error: ${text.slice(0, 200)}` : 'Things could not be reached through AppleScript.')
}

export function makeSystem(runner: Runner = execRunner): System {
  return {
    async osascript(script, args) {
      try {
        // `--` ends osascript's options, so text starting with '-' stays text.
        return (await runner('osascript', ['-e', script, '--', ...args])).trim()
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
