import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import swagger from '@fastify/swagger'
import { ApiError } from '../errors.ts'
import { BadKeyThrottle, bearer, keyMatches } from '../auth.ts'
import type { ThingsDb } from '../things/db.ts'
import type { Writer } from '../things/writer.ts'
import { COMPONENTS } from './schemas.ts'
import { readRoutes } from './read-routes.ts'
import { writeRoutes } from './write-routes.ts'

export type AppDeps = {
  reader: ThingsDb
  writer: Writer
  keyHash: string
  thingsRunning: () => Promise<boolean>
  publicUrl?: string
  throttle?: BadKeyThrottle
  logger?: boolean
}

const PUBLIC_ROUTES = new Set(['/health', '/openapi.json'])

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 65_536,
    ajv: { customOptions: { removeAdditional: false, allowUnionTypes: true } },
    schemaErrorFormatter: (errors, dataVar) =>
      new Error(errors.map((e) =>
        e.keyword === 'additionalProperties'
          ? `${dataVar} has an unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`
          : `${dataVar}${e.instancePath.replaceAll('/', '.')} ${e.message}`,
      ).join('; ')),
  })

  // Muse may send Content-Type: application/json with an empty body on action endpoints; treat that as no body.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined)
    try {
      done(null, JSON.parse(body as string))
    } catch {
      done(new ApiError(400, 'invalid_request', 'The request body is not valid JSON.'), undefined)
    }
  })

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'MuseThings',
        version: '0.1.0',
        description:
          "Read and manage the user's Things 3 to-dos. Every operation is tagged read, write or sensitive. " +
          'Always ask the user before a sensitive operation. Look up ids with the read operations before writing.',
      },
      servers: deps.publicUrl ? [{ url: deps.publicUrl }] : [],
      tags: [
        { name: 'read', description: 'Reads only; changes nothing' },
        { name: 'write', description: 'Changes Things' },
        { name: 'sensitive', description: 'Removes things or changes many at once; confirm with the user first' },
      ],
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
        schemas: COMPONENTS as never,
      },
      security: [{ bearer: [] }],
    },
  })

  const throttle = deps.throttle ?? new BadKeyThrottle()
  app.addHook('onRequest', async (req) => {
    if (PUBLIC_ROUTES.has(req.routeOptions.url ?? '')) return
    const key = bearer(req.headers.authorization)
    if (key && keyMatches(key, deps.keyHash)) return
    if (throttle.fail()) throw new ApiError(429, 'too_many_requests', 'Too many wrong API keys. Try again in 15 minutes.')
    throw new ApiError(401, 'unauthorized', 'Missing or wrong API key. Send Authorization: Bearer <key>.')
  })

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } })
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'invalid_request', message: err.message } })
    }
    req.log.error(err)
    return reply.status(500).send({
      error: { code: 'internal', message: 'Something went wrong in MuseThings; see ~/.musethings/server.log on the Mac.' },
    })
  })

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: `No endpoint ${req.method} ${req.url}` } }))

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())
  readRoutes(app, deps)
  writeRoutes(app, deps)
  return app
}
