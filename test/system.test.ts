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
    expect(calls).toEqual([['osascript', ['-e', SCRIPTS.createTodo, '--', NASTY]]])
    expect(SCRIPTS.createTodo).not.toContain('MARKER')
  })

  it('sends project to-dos as separate args and tags as one list', async () => {
    const { calls, runner } = recorder()
    const things = appleScriptThings(makeSystem(runner))
    await things.createProject('Trip', ['Pack', 'Book hotel'])
    await things.setTags('todo', 'T9', ['phone', 'errands'])
    await things.setTags('project', 'P9', [])
    expect(calls[0][1].slice(3)).toEqual(['Trip', 'Pack', 'Book hotel'])
    expect(calls[1][1]).toEqual(['-e', SCRIPTS.setTodoTags, '--', 'T9', 'phone, errands'])
    expect(calls[2][1]).toEqual(['-e', SCRIPTS.setProjectTags, '--', 'P9', ''])
  })

  it.runIf(process.platform === 'darwin')('real osascript returns argv text verbatim and runs none of it', async () => {
    const marker = path.join(os.tmpdir(), `musethings-marker-${process.pid}`)
    const text = NASTY.replace('MARKER', marker)
    const sys = makeSystem(execRunner)
    const echo = 'on run argv\n  return item 1 of argv\nend run'
    expect(await sys.osascript(echo, [text])).toBe(text)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it.runIf(process.platform === 'darwin')('a leading "-" is text, not an osascript option', async () => {
    const marker = path.join(os.tmpdir(), `musethings-dash-${process.pid}`)
    const sys = makeSystem(execRunner)
    const echo = 'on run argv\n  return item 1 of argv\nend run'
    for (const text of [`-eproperty p : (do shell script "touch ${marker}")`, '- buy milk', '-5 lbs', '--> call Bob']) {
      expect(await sys.osascript(echo, [text])).toBe(text)
    }
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

  it('a hung Things is write_not_confirmed, and no error repeats the script source', async () => {
    const hung = makeSystem(async () => {
      throw Object.assign(new Error(`Command failed: osascript -e ${SCRIPTS.createTodo}`), { killed: true, signal: 'SIGTERM', stderr: '' })
    })
    const err = await hung.osascript(SCRIPTS.createTodo, ['x']).catch((e) => e)
    expect(err).toMatchObject({ status: 503, code: 'write_not_confirmed' })
    expect(err.message).not.toContain('on run argv')
    const odd = makeSystem(async () => {
      throw Object.assign(new Error(`Command failed: osascript -e ${SCRIPTS.createTodo}`), { code: 1, stderr: '' })
    })
    const err2 = await odd.osascript(SCRIPTS.createTodo, ['x']).catch((e) => e)
    expect(err2).toMatchObject({ code: 'things_unavailable' })
    expect(err2.message).not.toContain('on run argv')
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
