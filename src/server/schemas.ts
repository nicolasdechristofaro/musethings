import { READABLE_LISTS } from '../things/types.ts'

export const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' }
export const TIME = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'HH:MM, 24-hour' }
export const WHEN = {
  type: 'string',
  pattern: '^(today|evening|tomorrow|anytime|someday|\\d{4}-\\d{2}-\\d{2})$',
  description: 'today, evening (This Evening), tomorrow, anytime, someday, or YYYY-MM-DD',
}
export const ID = { type: 'string', minLength: 1, maxLength: 100 }
export const ID_PARAMS = { type: 'object', properties: { id: ID }, required: ['id'] }

/** A permissive response schema: Fastify serializes every field; the shape is documented in COMPONENTS. */
export const objectReply = (description: string) => ({ description, type: 'object', additionalProperties: true })

const str = { type: 'string' }
const strOrNull = { type: ['string', 'null'] }
const refOrNull = { type: ['object', 'null'], properties: { id: str, title: str } }
const LISTS = ['inbox', 'today', 'evening', 'upcoming', 'anytime', 'someday', 'logbook', 'trash']

const TODO = {
  type: 'object',
  description: 'A Things to-do. Ids are stable.',
  properties: {
    id: str,
    title: str,
    notes: str,
    status: { enum: ['open', 'completed', 'canceled'] },
    list: { enum: LISTS, description: 'Where Things shows it now' },
    when: { ...strOrNull, description: 'Start date YYYY-MM-DD; null for Inbox, Anytime, Someday' },
    reminder: { ...strOrNull, description: 'Reminder time HH:MM on the when date' },
    deadline: { ...strOrNull, description: 'YYYY-MM-DD' },
    tags: { type: 'array', items: str },
    project: refOrNull,
    area: refOrNull,
    heading: refOrNull,
    checklist: { type: 'array', items: { type: 'object', properties: { id: str, title: str, done: { type: 'boolean' } } } },
    repeating: { type: 'boolean', description: 'A copy of a repeating to-do' },
    created_at: strOrNull,
    modified_at: strOrNull,
    completed_at: strOrNull,
  },
}

const PROJECT = {
  type: 'object',
  description: 'A Things project. Same fields as a to-do except checklist, heading, project and repeating.',
  properties: {
    ...Object.fromEntries(
      Object.entries(TODO.properties).filter(([k]) => !['checklist', 'heading', 'project', 'repeating'].includes(k)),
    ),
    todos_open: { type: 'integer' },
    headings: { type: 'array', items: refOrNull },
  },
}

export const COMPONENTS = {
  Todo: TODO,
  Project: PROJECT,
  ProjectDetail: {
    description: 'A project plus its open to-dos grouped by heading (heading null = no heading).',
    allOf: [
      { $ref: '#/components/schemas/Project' },
      { type: 'object', properties: { groups: { type: 'array', items: { type: 'object', properties: { heading: refOrNull, todos: { type: 'array', items: { $ref: '#/components/schemas/Todo' } } } } } } },
    ],
  },
  Area: { type: 'object', properties: { id: str, title: str, tags: { type: 'array', items: str } } },
  AreaDetail: {
    description: 'An area plus its open projects and the open to-dos directly in it.',
    allOf: [
      { $ref: '#/components/schemas/Area' },
      { type: 'object', properties: { projects: { type: 'array', items: { $ref: '#/components/schemas/Project' } }, todos: { type: 'array', items: { $ref: '#/components/schemas/Todo' } } } },
    ],
  },
  Tag: { type: 'object', properties: { id: str, title: str, parent: { ...strOrNull, description: 'Parent tag title' } } },
  Error: {
    type: 'object',
    properties: { error: { type: 'object', properties: { code: str, message: { ...str, description: 'Written to be shown to the user' } } } },
  },
}

export const LIST_PARAMS = { type: 'object', properties: { list: { type: 'string', enum: READABLE_LISTS } }, required: ['list'] }
