import type { FastifyInstance } from 'fastify'
import { notFound } from '../errors.ts'
import type { TodoFilter } from '../things/db.ts'
import type { ReadableList } from '../things/types.ts'
import type { AppDeps } from './app.ts'
import { DATE, ID, ID_PARAMS, LIST_PARAMS, objectReply } from './schemas.ts'

const read = (operationId: string, summary: string, extra: object = {}) => ({ tags: ['read'], operationId, summary, ...extra })
const LIMIT = { type: 'integer', minimum: 1, maximum: 500, default: 100 }
type Id = { Params: { id: string } }

export function readRoutes(app: FastifyInstance, deps: AppDeps) {
  const { reader } = deps

  app.get('/health', {
    schema: read('health', 'Is the bridge up? (no key needed)', {
      security: [],
      response: { 200: objectReply('{ ok, things_running, db_readable }') },
    }),
  }, async () => {
    let dbReadable = true
    try {
      reader.listTags()
    } catch {
      dbReadable = false
    }
    return { ok: true, things_running: await deps.thingsRunning(), db_readable: dbReadable }
  })

  app.get<{ Params: { list: ReadableList }; Querystring: { limit?: number; since?: string } }>('/lists/:list', {
    schema: read('getList', 'To-dos in one Things list, in Things order', {
      description: 'today includes This Evening at the end (their list is "evening"). logbook is newest first.',
      params: LIST_PARAMS,
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: LIMIT, since: { ...DATE, description: 'logbook only: completed on or after this date' } },
      },
      response: { 200: objectReply('{ todos: Todo[] }') },
    }),
  }, async (req) => ({ todos: reader.listTodos(req.params.list, req.query) }))

  app.get<{ Querystring: TodoFilter }>('/todos', {
    schema: read('searchTodos', 'Search to-dos', {
      description: 'Filters combine. Only open to-dos unless status says otherwise. Soonest deadline first.',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string', minLength: 1, maxLength: 200, description: 'Text in title or notes' },
          tag: { type: 'string', minLength: 1, maxLength: 200, description: 'Tag title, any case' },
          project_id: ID,
          area_id: ID,
          deadline_before: { ...DATE, description: 'Deadline on or before this date' },
          status: { type: 'string', enum: ['open', 'completed', 'canceled', 'any'], default: 'open' },
          limit: LIMIT,
        },
      },
      response: { 200: objectReply('{ todos: Todo[] }') },
    }),
  }, async (req) => ({ todos: reader.searchTodos(req.query) }))

  app.get<Id>('/todos/:id', {
    schema: read('getTodo', 'One to-do', { params: ID_PARAMS, response: { 200: objectReply('Todo') } }),
  }, async (req) => {
    const todo = reader.getTodo(req.params.id)
    if (todo) return todo
    if (reader.kindOf(req.params.id) === 'project') {
      throw notFound(`${req.params.id} is a project; use /projects/${req.params.id}`)
    }
    throw notFound(`No to-do with id ${req.params.id}`)
  })

  app.get('/projects', {
    schema: read('listProjects', 'Open projects', { response: { 200: objectReply('{ projects: Project[] }') } }),
  }, async () => ({ projects: reader.listProjects() }))

  app.get<Id>('/projects/:id', {
    schema: read('getProject', 'One project with its open to-dos grouped by heading', {
      params: ID_PARAMS,
      response: { 200: objectReply('ProjectDetail') },
    }),
  }, async (req) => {
    const project = reader.getProjectDetail(req.params.id)
    if (!project) throw notFound(`No project with id ${req.params.id}`)
    return project
  })

  app.get('/areas', {
    schema: read('listAreas', 'Areas', { response: { 200: objectReply('{ areas: Area[] }') } }),
  }, async () => ({ areas: reader.listAreas() }))

  app.get<Id>('/areas/:id', {
    schema: read('getArea', 'One area with its open projects and loose to-dos', {
      params: ID_PARAMS,
      response: { 200: objectReply('AreaDetail') },
    }),
  }, async (req) => {
    const area = reader.getArea(req.params.id)
    if (!area) throw notFound(`No area with id ${req.params.id}`)
    return area
  })

  app.get('/tags', {
    schema: read('listTags', 'All tags', { response: { 200: objectReply('{ tags: Tag[] }') } }),
  }, async () => ({ tags: reader.listTags() }))
}
