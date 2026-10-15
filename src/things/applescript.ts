import type { System } from './system.ts'

/**
 * Fixed AppleScript source. Values only ever arrive as argv (`item n of argv`).
 * Never build or edit these strings from user input.
 */
export const SCRIPTS = {
  ping: 'tell application "Things3" to return name',
  createTodo: `on run argv
  tell application "Things3"
    set t to make new to do with properties {name:(item 1 of argv)}
    return id of t
  end tell
end run`,
  createProject: `on run argv
  tell application "Things3"
    set p to make new project with properties {name:(item 1 of argv)}
    repeat with i from 2 to count of argv
      set t to make new to do with properties {name:(item i of argv)}
      set project of t to p
    end repeat
    return id of p
  end tell
end run`,
  trashTodo: `on run argv
  tell application "Things3"
    try
      delete to do id (item 1 of argv)
    on error
      -- Things only deletes completed or canceled items through the Logbook,
      -- or, if they've left it, once they're open again.
      try
        delete (to do id (item 1 of argv) of list "Logbook")
      on error
        set x to to do id (item 1 of argv)
        set status of x to open
        delete x
      end try
    end try
  end tell
end run`,
  trashProject: `on run argv
  tell application "Things3"
    try
      delete project id (item 1 of argv)
    on error
      -- Things only deletes completed or canceled items through the Logbook,
      -- or, if they've left it, once they're open again.
      try
        delete (project id (item 1 of argv) of list "Logbook")
      on error
        set x to project id (item 1 of argv)
        set status of x to open
        delete x
      end try
    end try
  end tell
end run`,
  moveToInbox: `on run argv
  tell application "Things3" to move to do id (item 1 of argv) to list "Inbox"
end run`,
  setTodoTags: `on run argv
  tell application "Things3" to set tag names of to do id (item 1 of argv) to (item 2 of argv)
end run`,
  setProjectTags: `on run argv
  tell application "Things3" to set tag names of project id (item 1 of argv) to (item 2 of argv)
end run`,
  createArea: `on run argv
  tell application "Things3"
    set a to make new area with properties {name:(item 1 of argv)}
    return id of a
  end tell
end run`,
  deleteArea: `on run argv
  tell application "Things3" to delete area id (item 1 of argv)
end run`,
} as const

export type ThingsScripts = {
  ping(): Promise<string>
  createTodo(title: string): Promise<string>
  createProject(title: string, todoTitles: string[]): Promise<string>
  trashTodo(id: string): Promise<void>
  trashProject(id: string): Promise<void>
  moveToInbox(id: string): Promise<void>
  /** Replaces all tags. Things creates tags that don't exist yet. */
  setTags(kind: 'todo' | 'project', id: string, tags: string[]): Promise<void>
  createArea(title: string): Promise<string>
  deleteArea(id: string): Promise<void>
}

export function appleScriptThings(sys: Pick<System, 'osascript'>): ThingsScripts {
  const run = (script: string, ...args: string[]) => sys.osascript(script, args)
  return {
    ping: () => run(SCRIPTS.ping),
    createTodo: (title) => run(SCRIPTS.createTodo, title),
    createProject: (title, todos) => run(SCRIPTS.createProject, title, ...todos),
    trashTodo: async (id) => void (await run(SCRIPTS.trashTodo, id)),
    trashProject: async (id) => void (await run(SCRIPTS.trashProject, id)),
    moveToInbox: async (id) => void (await run(SCRIPTS.moveToInbox, id)),
    setTags: async (kind, id, tags) =>
      void (await run(kind === 'todo' ? SCRIPTS.setTodoTags : SCRIPTS.setProjectTags, id, tags.join(', '))),
    createArea: (title) => run(SCRIPTS.createArea, title),
    deleteArea: async (id) => void (await run(SCRIPTS.deleteArea, id)),
  }
}
