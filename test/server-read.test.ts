import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Fixture } from './helpers/fixture.ts'
import { auth, testApp } from './helpers/app.ts'
import { packDate } from '../src/things/dates.ts'

let app: FastifyInstance
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)
const get = (url: string) => app.inject({ url, headers: auth })

beforeAll(async () => {
  const f = new Fixture()
  f.area('A1', 'Home')
    .tag('T1', 'phone')
    .task({ uuid: 'P1', type: 1, title: 'Errands', area: 'A1' })
    .task({ uuid: 'H1', type: 2, title: 'Shops', project: 'P1' })
    .task({ uuid: 't1', title: 'Call the dentist', start: 1, startDate: packDate('2026-10-15') })
    .task({ uuid: 't2', title: 'Buy milk', heading: 'H1' })
    .task({ uuid: 'd1', title: 'Done', status: 3, stopDate: 1760600000 })
    .tagTask('t1', 'T1')
  ;({ app } = await testApp(f))
})
afterAll(() => app.close())

describe('access', () => {
  it('health needs no key and shows no Things data', async () => {
    const res = await app.inject({ url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, things_running: true, db_readable: true })
  })

  it('everything else needs the key', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 'test-key' }]) {
      const res = await app.inject({ url: '/lists/today', headers })
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('unauthorized')
    }
  })

  it('throttles repeated bad keys but never the right key', async () => {
    const { app: a } = await testApp(new Fixture())
    const bad = { authorization: 'Bearer nope' }
    for (let i = 0; i < 10; i++) expect((await a.inject({ url: '/tags', headers: bad })).statusCode).toBe(401)
    expect((await a.inject({ url: '/tags', headers: bad })).json().error.code).toBe('too_many_requests')
    expect((await a.inject({ url: '/tags', headers: auth })).statusCode).toBe(200)
    await a.close()
  })
})

describe('read endpoints', () => {
  it('lists', async () => {
    expect(ids((await get('/lists/today')).json().todos)).toEqual(['t1'])
    expect(ids((await get('/lists/logbook?since=2025-10-15&limit=1')).json().todos)).toEqual(['d1'])
    const bad = await get('/lists/someplace')
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('invalid_request')
    const extra = await get('/lists/today?color=red')
    expect(extra.statusCode).toBe(400)
    expect(extra.json().error.message).toContain('"color"')
  })

  it('search and single to-dos', async () => {
    expect(ids((await get('/todos?q=dentist')).json().todos)).toEqual(['t1'])
    expect((await get('/todos/t2')).json()).toMatchObject({ project: { id: 'P1' }, heading: { id: 'H1' }, area: { id: 'A1' } })
    const project = await get('/todos/P1')
    expect(project.statusCode).toBe(404)
    expect(project.json().error.message).toContain('/projects/P1')
    expect((await get('/todos/nope')).json().error.code).toBe('not_found')
  })

  it('projects, areas and tags', async () => {
    expect(ids((await get('/projects')).json().projects)).toEqual(['P1'])
    expect((await get('/projects/P1')).json().groups.map((g: { todos: { id: string }[] }) => ids(g.todos)))
      .toEqual([[], ['t2']])
    expect((await get('/projects/nope')).statusCode).toBe(404)
    expect((await get('/areas')).json().areas).toEqual([{ id: 'A1', title: 'Home', tags: [] }])
    expect(ids((await get('/areas/A1')).json().projects)).toEqual(['P1'])
    expect((await get('/tags')).json().tags).toEqual([{ id: 'T1', title: 'phone', parent: null }])
  })

  it('unknown endpoints are 404 not_found', async () => {
    const res = await get('/nope')
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })
})

describe('OpenAPI', () => {
  it('is public and describes auth, objects and sensitivity tags', async () => {
    const res = await app.inject({ url: '/openapi.json' })
    expect(res.statusCode).toBe(200)
    const doc = res.json()
    expect(doc.servers).toEqual([{ url: 'https://mac.example.ts.net' }])
    expect(doc.components.securitySchemes.bearer).toEqual({ type: 'http', scheme: 'bearer' })
    expect(doc.components.schemas.Todo.properties.when).toBeDefined()
    expect(doc.paths['/lists/{list}'].get.tags).toEqual(['read'])
    expect(doc.paths['/health'].get.security).toEqual([])
    expect(doc.paths['/openapi.json']).toBeUndefined()
  })
})
