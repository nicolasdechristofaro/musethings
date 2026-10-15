import type { FastifyInstance } from 'fastify'
import type { ProjectFields, ProjectInput, TodoFields, TodoInput } from '../things/changes.ts'
import type { AppDeps } from './app.ts'
import { DATE, ID, ID_PARAMS, TIME, WHEN, objectReply } from './schemas.ts'

const nullable = (s: object) => ({ ...s, type: ['string', 'null'] })
const TITLE = { type: 'string', minLength: 1, maxLength: 4000 }
const NOTES = { type: ['string', 'null'], maxLength: 10_000 }
const TAG_LIST = { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 } }
const LINES = { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4000 } }

const TODO_CREATE = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: TITLE,
    notes: NOTES,
    when: WHEN,
    reminder: { ...TIME, description: 'Needs a when date (not evening, anytime or someday)' },
    deadline: DATE,
    tags: { ...TAG_LIST, description: "Tag titles; ones that don't exist are created" },
    project_id: ID,
    area_id: ID,
    heading_id: { ...ID, description: 'A heading inside a project; implies that project' },
    checklist: { ...LINES, description: 'Checklist item titles' },
  },
}

const TODO_PATCH = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    title: TITLE,
    notes: NOTES,
    when: { ...nullable(WHEN), description: `${WHEN.description}; null = anytime` },
    reminder: nullable(TIME),
    deadline: nullable(DATE),
    list: { type: 'string', enum: ['inbox'], description: 'Move back to the Inbox' },
    tags: { ...TAG_LIST, description: 'Replaces all tags' },
    add_tags: TAG_LIST,
    remove_tags: TAG_LIST,
    project_id: ID,
    area_id: ID,
    heading_id: ID,
    checklist: { ...LINES, description: 'Replaces the checklist' },
    add_checklist: { ...LINES, description: 'Appends to the checklist' },
  },
}

const PROJECT_CREATE = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: TITLE,
    notes: NOTES,
    when: WHEN,
    deadline: DATE,
    tags: TAG_LIST,
    area_id: ID,
    todos: { ...LINES, description: 'Titles of to-dos to create inside the project' },
  },
}

const PROJECT_PATCH = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    title: TITLE,
    notes: NOTES,
    when: nullable(WHEN),
    deadline: nullable(DATE),
    tags: TAG_LIST,
    add_tags: TAG_LIST,
    remove_tags: TAG_LIST,
    area_id: ID,
  },
}

const op = (tag: 'write' | 'sensitive', operationId: string, summary: string, extra: object = {}) =>
  ({ tags: [tag], operationId, summary, ...extra })
const ASK_FIRST = 'Sensitive: ask the user before doing this.'
type Id = { Params: { id: string } }

export function writeRoutes(app: FastifyInstance, { writer }: AppDeps) {
  app.post<{ Body: TodoInput }>('/todos', {
    schema: op('write', 'createTodo', 'Create a to-do', {
      description: 'Goes to the Inbox unless when, project_id, area_id or heading_id put it somewhere else.',
      body: TODO_CREATE,
      response: { 201: objectReply('The new Todo') },
    }),
  }, async (req, reply) => reply.status(201).send(await writer.createTodo(req.body)))

  app.patch<Id & { Body: TodoFields }>('/todos/:id', {
    schema: op('write', 'updateTodo', 'Change a to-do', {
      description: 'Send only the fields to change. null clears when, reminder, deadline or notes.',
      params: ID_PARAMS,
      body: TODO_PATCH,
      response: { 200: objectReply('The updated Todo') },
    }),
  }, async (req) => writer.updateTodo(req.params.id, req.body))

  for (const action of ['complete', 'cancel', 'reopen'] as const) {
    app.post<Id>(`/todos/:id/${action}`, {
      schema: op('write', `${action}Todo`, `${action[0].toUpperCase()}${action.slice(1)} a to-do`, {
        params: ID_PARAMS,
        response: { 200: objectReply('The updated Todo') },
      }),
    }, async (req) => writer.setTodoStatus(req.params.id, action))
  }

  app.delete<Id>('/todos/:id', {
    schema: op('sensitive', 'trashTodo', 'Move a to-do to the Trash', {
      description: `${ASK_FIRST} It can be recovered from Things' Trash; MuseThings never empties it.`,
      params: ID_PARAMS,
      response: { 200: objectReply('The trashed Todo') },
    }),
  }, async (req) => writer.trashTodo(req.params.id))

  app.post<{ Body: ProjectInput }>('/projects', {
    schema: op('write', 'createProject', 'Create a project, optionally with to-dos', {
      body: PROJECT_CREATE,
      response: { 201: objectReply('The new Project') },
    }),
  }, async (req, reply) => reply.status(201).send(await writer.createProject(req.body)))

  app.patch<Id & { Body: ProjectFields }>('/projects/:id', {
    schema: op('write', 'updateProject', 'Change a project', {
      params: ID_PARAMS,
      body: PROJECT_PATCH,
      response: { 200: objectReply('The updated Project') },
    }),
  }, async (req) => writer.updateProject(req.params.id, req.body))

  for (const action of ['complete', 'cancel'] as const) {
    const verb = action === 'complete' ? 'completes' : 'cancels'
    app.post<Id>(`/projects/:id/${action}`, {
      schema: op('sensitive', `${action}Project`, `${action[0].toUpperCase()}${action.slice(1)} a project`, {
        description: `${ASK_FIRST} Things also ${verb} every open to-do in the project.`,
        params: ID_PARAMS,
        response: { 200: objectReply('The updated Project') },
      }),
    }, async (req) => writer.setProjectStatus(req.params.id, action))
  }

  app.delete<Id>('/projects/:id', {
    schema: op('sensitive', 'trashProject', 'Move a project and its to-dos to the Trash', {
      description: `${ASK_FIRST} Recoverable from Things' Trash.`,
      params: ID_PARAMS,
      response: { 200: objectReply('The trashed Project') },
    }),
  }, async (req) => writer.trashProject(req.params.id))
}
