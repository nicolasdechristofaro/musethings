import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Fixture } from './helpers/fixture.ts'
import { FakeThings } from './helpers/fake-things.ts'
import { auth, testApp } from './helpers/app.ts'

let app: FastifyInstance
let fake: FakeThings
type Method = 'POST' | 'PATCH' | 'DELETE'
const send = (method: Method, url: string, payload?: object) => app.inject({ method, url, payload, headers: auth })

beforeEach(async () => {
  const f = new Fixture()
  f.area('A1', 'Home')
    .task({ uuid: 'P1', type: 1, title: 'Errands' })
    .task({ uuid: 'x1', title: 'Water plants', start: 1 })
    .task({ uuid: 'tpl', title: 'Weekly review', start: 1, rt1_recurrenceRule: new Uint8Array([1]) })
  ;({ app, fake } = await testApp(f))
})
afterEach(() => app.close())

describe('to-do endpoints', () => {
  it('need the key and change nothing without it', async () => {
    const res = await app.inject({ method: 'POST', url: '/todos', payload: { title: 'x' } })
    expect(res.statusCode).toBe(401)
    expect(fake.log).toEqual([])
  })

  it('create', async () => {
    const res = await send('POST', '/todos', { title: 'Call the dentist', when: 'tomorrow', tags: ['phone'], project_id: 'P1' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ title: 'Call the dentist', list: 'upcoming', tags: ['phone'], project: { id: 'P1' } })
  })

  it('name the field in validation errors and touch nothing', async () => {
    const unknown = await send('POST', '/todos', { title: 'a', colour: 'red' })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().error).toEqual({ code: 'invalid_request', message: 'body has an unknown field "colour"' })
    expect((await send('POST', '/todos', { title: 'a', when: 'next week' })).json().error.message).toContain('body.when')
    expect((await send('PATCH', '/todos/x1', {})).statusCode).toBe(400)
    expect((await send('POST', '/todos', { title: 'a', notes: 'x'.repeat(10_001) })).json().error.message).toContain('body.notes')
    expect(fake.log).toEqual([])
  })

  it('update, complete, reopen, cancel and trash', async () => {
    expect((await send('PATCH', '/todos/x1', { when: 'evening', notes: null })).json()).toMatchObject({ list: 'evening', notes: '' })
    expect((await send('POST', '/todos/x1/complete')).json().status).toBe('completed')
    expect((await send('POST', '/todos/x1/reopen')).json().status).toBe('open')
    expect((await send('POST', '/todos/x1/cancel')).json().status).toBe('canceled')
    expect((await send('DELETE', '/todos/x1')).json().list).toBe('trash')
  })

  it('accept an empty JSON body on action endpoints', async () => {
    const res = await app.inject({
      method: 'POST', url: '/todos/x1/complete', headers: { ...auth, 'content-type': 'application/json' }, payload: '',
    })
    expect(res.statusCode).toBe(200)
  })

  it('pass writer errors through', async () => {
    expect((await send('PATCH', '/todos/tpl', { title: 'b' })).statusCode).toBe(409)
    expect((await send('POST', '/todos/nope/complete')).json().error.code).toBe('not_found')
    expect((await send('POST', '/todos', { title: 'a', when: '2020-01-01' })).json().error.message).toMatch(/past/)
  })

  it('reject bodies over 64 KB', async () => {
    const res = await send('POST', '/todos', { title: 'a', notes: 'x'.repeat(70_000) })
    expect(res.statusCode).toBe(413)
    expect(res.json().error.code).toBe('invalid_request')
  })
})

describe('project endpoints', () => {
  it('create, update, complete, trash', async () => {
    const created = await send('POST', '/projects', { title: 'Trip', area_id: 'A1', todos: ['Pack'] })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ todos_open: 1, area: { id: 'A1' } })
    const id = created.json().id
    expect((await send('PATCH', `/projects/${id}`, { title: 'Lisbon trip' })).json().title).toBe('Lisbon trip')
    expect((await send('POST', `/projects/${id}/complete`)).json().status).toBe('completed')
    expect((await send('DELETE', `/projects/${id}`)).json().list).toBe('trash')
  })
})

describe('OpenAPI', () => {
  it('tags each write operation write or sensitive', async () => {
    const doc = (await app.inject({ url: '/openapi.json' })).json()
    expect(doc.paths['/todos'].post.tags).toEqual(['write'])
    expect(doc.paths['/todos/{id}/complete'].post.tags).toEqual(['write'])
    expect(doc.paths['/todos/{id}'].delete.tags).toEqual(['sensitive'])
    expect(doc.paths['/projects/{id}/complete'].post.tags).toEqual(['sensitive'])
    expect(doc.paths['/projects/{id}'].delete.tags).toEqual(['sensitive'])
    expect(doc.paths['/todos'].post.requestBody.content['application/json'].schema.required).toEqual(['title'])
  })
})
