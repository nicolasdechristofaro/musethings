import { describe, it, expect, beforeAll } from 'vitest'
import { Fixture } from './helpers/fixture.ts'
import { ThingsDb } from '../src/things/db.ts'
import { packDate } from '../src/things/dates.ts'

const NOW = new Date(2026, 9, 15, 12, 0)
let db: ThingsDb
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

beforeAll(() => {
  const f = new Fixture()
  f.area('A1', 'Home', 0)
    .area('A2', 'Work', 1)
    .tag('T1', 'Phone', null, 0)
    .tag('T2', 'family', null, 1)
    .tag('T3', 'urgent', 'T1', 2)
    .tagArea('A1', 'T2')
    .task({ uuid: 'P1', type: 1, title: 'Errands', area: 'A1', index: 0, deadline: packDate('2026-10-20') })
    .task({ uuid: 'P2', type: 1, title: 'Done project', status: 3, stopDate: 1760000000 })
    .task({ uuid: 'P3', type: 1, title: 'Work stuff', area: 'A2', index: 1 })
    .task({ uuid: 'H1', type: 2, title: 'Shops', project: 'P1', index: 0 })
    .task({ uuid: 'H2', type: 2, title: 'Online', project: 'P1', index: 1 })
    .task({ uuid: 'e1', title: 'Buy milk', project: 'P1', index: 0 })
    .task({ uuid: 'e2', title: 'Buy 100% juice', heading: 'H1', index: 1, deadline: packDate('2026-10-18') })
    .task({ uuid: 'e3', title: 'Order printer ink', heading: 'H2', index: 2 })
    .task({ uuid: 'e4', title: 'Done errand', project: 'P1', status: 3, stopDate: 1760000000 })
    .task({ uuid: 'w1', title: 'Email Sam', area: 'A2' })
    .task({ uuid: 'w2', title: 'Prep deck', notes: 'for the 50_50 review', project: 'P3' })
    .task({ uuid: 'h1', title: 'Fix sink', area: 'A1', deadline: packDate('2026-10-16') })
    .tagTask('e3', 'T1')
  f.close()
  db = new ThingsDb(f.path, () => NOW)
})

describe('searchTodos', () => {
  it('matches title and notes, soonest deadline first', () => {
    expect(ids(db.searchTodos({ q: 'buy' }))).toEqual(['e2', 'e1'])
  })

  it('treats % and _ in the query literally', () => {
    expect(ids(db.searchTodos({ q: '100%' }))).toEqual(['e2'])
    expect(ids(db.searchTodos({ q: '%' }))).toEqual(['e2'])
    expect(ids(db.searchTodos({ q: '50_50' }))).toEqual(['w2'])
  })

  it('filters by tag (any case), project (incl. headings), area (incl. its projects)', () => {
    expect(ids(db.searchTodos({ tag: 'phone' }))).toEqual(['e3'])
    expect(ids(db.searchTodos({ project_id: 'P1' })).sort()).toEqual(['e1', 'e2', 'e3'])
    expect(ids(db.searchTodos({ area_id: 'A1' })).sort()).toEqual(['e1', 'e2', 'e3', 'h1'])
  })

  it('filters by deadline and status', () => {
    expect(ids(db.searchTodos({ deadline_before: '2026-10-17' }))).toEqual(['h1'])
    expect(ids(db.searchTodos({ status: 'completed' }))).toEqual(['e4'])
    expect(ids(db.searchTodos({ project_id: 'P1', status: 'any' })).sort()).toEqual(['e1', 'e2', 'e3', 'e4'])
  })
})

describe('projects', () => {
  it('lists open projects with counts, headings and area', () => {
    const projects = db.listProjects()
    expect(ids(projects)).toEqual(['P1', 'P3'])
    expect(projects[0]).toMatchObject({
      title: 'Errands',
      todos_open: 3,
      headings: [{ id: 'H1', title: 'Shops' }, { id: 'H2', title: 'Online' }],
      area: { id: 'A1', title: 'Home' },
      deadline: '2026-10-20',
      list: 'anytime',
      status: 'open',
    })
    expect(projects[0]).not.toHaveProperty('checklist')
  })

  it('gets any project by id, and only projects', () => {
    expect(db.getProject('P2')!.status).toBe('completed')
    expect(db.getProject('e1')).toBeNull()
  })

  it('groups a project’s open to-dos by heading', () => {
    const detail = db.getProjectDetail('P1')!
    expect(detail.groups.map((g) => [g.heading?.id ?? null, ids(g.todos)])).toEqual([
      [null, ['e1']],
      ['H1', ['e2']],
      ['H2', ['e3']],
    ])
  })
})

describe('areas, tags, headings', () => {
  it('lists areas with tags', () => {
    expect(db.listAreas()).toEqual([
      { id: 'A1', title: 'Home', tags: ['family'] },
      { id: 'A2', title: 'Work', tags: [] },
    ])
  })

  it('gets an area with its projects and loose to-dos', () => {
    const area = db.getArea('A2')!
    expect(ids(area.projects)).toEqual(['P3'])
    expect(ids(area.todos)).toEqual(['w1'])
    expect(db.getArea('nope')).toBeNull()
    expect(db.areaExists('A1')).toBe(true)
    expect(db.areaExists('P1')).toBe(false)
  })

  it('lists tags with parent titles', () => {
    expect(db.listTags()).toEqual([
      { id: 'T1', title: 'Phone', parent: null },
      { id: 'T2', title: 'family', parent: null },
      { id: 'T3', title: 'urgent', parent: 'Phone' },
    ])
  })

  it('gets a heading with its project', () => {
    expect(db.getHeading('H1')).toEqual({ id: 'H1', title: 'Shops', projectId: 'P1' })
    expect(db.getHeading('e1')).toBeNull()
  })
})
