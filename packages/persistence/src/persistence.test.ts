/**
 * Ported from dev-dashboard-v2 tests/persistence-layer.test.ts.
 * Adapted: vi.mock('../server/lib/supabase') became an injected mock DalClient.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  PersistenceLayer,
  upsert,
  batchInsert,
  projectLayer,
  userLayer,
  tenantLayer,
  type DalClient,
  type DalResult,
} from './index'

const mockGet = vi.fn<(table: string, query?: string) => Promise<unknown[] | null>>()
const mockInsert = vi.fn<(table: string, data: Record<string, unknown>) => Promise<DalResult>>()
const mockPatch = vi.fn<(table: string, filter: string, data: Record<string, unknown>) => Promise<DalResult>>()

const dal: DalClient = {
  get: mockGet,
  insert: mockInsert,
  patch: mockPatch,
}

beforeEach(() => {
  vi.clearAllMocks()
})

type TestItem = { id: string; title: string; status?: string }

describe('PersistenceLayer.list', () => {
  it('returns rows matching the filter', async () => {
    const rows = [{ id: '1', title: 'Item A' }, { id: '2', title: 'Item B' }]
    mockGet.mockResolvedValue(rows)

    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.list()
    expect(result).toEqual(rows)
    expect(mockGet).toHaveBeenCalledWith(
      'my_table',
      'project_id=eq.proj-1&deleted=not.is.true',
    )
  })

  it('returns empty array when dal.get returns null', async () => {
    mockGet.mockResolvedValue(null)
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.list()
    expect(result).toEqual([])
  })

  it('returns empty array on exception', async () => {
    mockGet.mockRejectedValue(new Error('network error'))
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.list()
    expect(result).toEqual([])
  })

  it('appends extraQuery when provided', async () => {
    mockGet.mockResolvedValue([])
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    await layer.list('order=created_at.desc')
    expect(mockGet).toHaveBeenCalledWith(
      'my_table',
      'project_id=eq.proj-1&deleted=not.is.true&order=created_at.desc',
    )
  })
})

describe('PersistenceLayer read-side delete filtering (regression)', () => {
  it('list() excludes flag-deleted rows in default (hard) mode', async () => {
    mockGet.mockResolvedValue([])
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    await layer.list()
    expect(mockGet).toHaveBeenCalledWith('my_table', 'project_id=eq.proj-1&deleted=not.is.true')
  })

  it('list() excludes status="deleted" rows in soft-delete mode', async () => {
    mockGet.mockResolvedValue([])
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1', { softDelete: true })
    await layer.list()
    expect(mockGet).toHaveBeenCalledWith('my_table', 'project_id=eq.proj-1&status=neq.deleted')
  })

  it('get() applies the not-deleted clause (default mode)', async () => {
    mockGet.mockResolvedValue([])
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    await layer.get('item-1')
    expect(mockGet).toHaveBeenCalledWith(
      'my_table',
      'id=eq.item-1&project_id=eq.proj-1&deleted=not.is.true&limit=1',
    )
  })

  it('get() applies the status clause in soft-delete mode', async () => {
    mockGet.mockResolvedValue([])
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1', { softDelete: true })
    await layer.get('item-1')
    expect(mockGet).toHaveBeenCalledWith(
      'my_table',
      'id=eq.item-1&project_id=eq.proj-1&status=neq.deleted&limit=1',
    )
  })

  it('end-to-end: a soft-removed row no longer appears in list()/get()', async () => {
    const rows = [
      { id: 'a', project_id: 'proj-1', title: 'A' } as Record<string, unknown>,
      { id: 'b', project_id: 'proj-1', title: 'B' } as Record<string, unknown>,
    ]
    const match = (row: Record<string, unknown>, q: string): boolean => {
      for (const clause of q.split('&')) {
        let m = clause.match(/^([^=]+)=eq\.(.*)$/)
        if (m) { if (String(row[m[1]!]) !== decodeURIComponent(m[2]!)) return false; continue }
        m = clause.match(/^([^=]+)=neq\.(.*)$/)
        if (m) { if (String(row[m[1]!]) === decodeURIComponent(m[2]!)) return false; continue }
        m = clause.match(/^([^=]+)=not\.is\.true$/)
        if (m) { if (row[m[1]!] === true) return false; continue }
      }
      return true
    }
    const liveDal: DalClient = {
      get: async (_t, q = '') => rows.filter((r) => match(r, q)),
      insert: async () => ({ ok: true }),
      patch: async (_t, filter, data) => { for (const r of rows) if (match(r, filter)) Object.assign(r, data); return { ok: true } },
    }
    const layer = new PersistenceLayer<TestItem>(liveDal, 'my_table', 'project_id', 'proj-1', { softDelete: true })
    await layer.remove('a')
    const listed = await layer.list()
    expect(listed.map((r) => r.id)).toEqual(['b'])
    expect(await layer.get('a')).toBeNull()
  })
})

describe('PersistenceLayer.get', () => {
  it('returns the first matching row', async () => {
    const row = { id: 'item-1', title: 'Found' }
    mockGet.mockResolvedValue([row])
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.get('item-1')
    expect(result).toEqual(row)
  })

  it('returns null when no rows found', async () => {
    mockGet.mockResolvedValue([])
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.get('nonexistent')
    expect(result).toBeNull()
  })

  it('returns null on exception', async () => {
    mockGet.mockRejectedValue(new Error('timeout'))
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.get('item-1')
    expect(result).toBeNull()
  })
})

describe('PersistenceLayer.save', () => {
  it('returns true on successful insert', async () => {
    mockInsert.mockResolvedValue({ ok: true })
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.save({ id: 'new-1', title: 'New Item' })
    expect(result).toBe(true)
    expect(mockInsert).toHaveBeenCalledWith('my_table', expect.objectContaining({
      id: 'new-1',
      title: 'New Item',
      project_id: 'proj-1',
    }))
  })

  it('returns false when insert fails', async () => {
    mockInsert.mockResolvedValue({ ok: false })
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.save({ id: 'fail-1', title: 'Bad' })
    expect(result).toBe(false)
  })

  it('returns false on exception', async () => {
    mockInsert.mockRejectedValue(new Error('connection refused'))
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.save({ id: 'err-1', title: 'Error' })
    expect(result).toBe(false)
  })
})

describe('PersistenceLayer.update', () => {
  it('returns true on successful patch', async () => {
    mockPatch.mockResolvedValue({ ok: true })
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.update('item-1', { title: 'Updated' })
    expect(result).toBe(true)
    expect(mockPatch).toHaveBeenCalledWith(
      'my_table',
      'id=eq.item-1&project_id=eq.proj-1',
      expect.objectContaining({ title: 'Updated', updated_at: expect.any(String) }),
    )
  })

  it('returns false when patch fails', async () => {
    mockPatch.mockResolvedValue({ ok: false })
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.update('item-1', { title: 'Fail' })
    expect(result).toBe(false)
  })

  it('returns false on exception', async () => {
    mockPatch.mockRejectedValue(new Error('timeout'))
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.update('item-1', { title: 'Error' })
    expect(result).toBe(false)
  })
})

describe('PersistenceLayer.remove', () => {
  it('hard delete: patches with deleted=true and deleted_at', async () => {
    mockPatch.mockResolvedValue({ ok: true })
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.remove('item-1')
    expect(result).toBe(true)
    expect(mockPatch).toHaveBeenCalledWith(
      'my_table',
      'id=eq.item-1&project_id=eq.proj-1',
      expect.objectContaining({ deleted: true, deleted_at: expect.any(String) }),
    )
  })

  it('soft delete: patches status to "deleted"', async () => {
    mockPatch.mockResolvedValue({ ok: true })
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1', { softDelete: true })
    await layer.remove('item-1')
    expect(mockPatch).toHaveBeenCalledWith(
      'my_table',
      'id=eq.item-1&project_id=eq.proj-1',
      expect.objectContaining({ status: 'deleted' }),
    )
  })

  it('returns false on exception', async () => {
    mockPatch.mockRejectedValue(new Error('error'))
    const layer = new PersistenceLayer<TestItem>(dal, 'my_table', 'project_id', 'proj-1')
    const result = await layer.remove('item-1')
    expect(result).toBe(false)
  })
})

describe('upsert', () => {
  afterEach(() => vi.clearAllMocks())

  it('inserts when no existing row found', async () => {
    mockGet.mockResolvedValue([])
    mockInsert.mockResolvedValue({ ok: true })
    const result = await upsert(dal, 'settings', 'project_id=eq.p1', { key: 'val' })
    expect(result).toBe(true)
    expect(mockInsert).toHaveBeenCalled()
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it('updates when existing row found', async () => {
    mockGet.mockResolvedValue([{ id: 'existing' }])
    mockPatch.mockResolvedValue({ ok: true })
    const result = await upsert(dal, 'settings', 'project_id=eq.p1', { key: 'val' })
    expect(result).toBe(true)
    expect(mockPatch).toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('returns false on exception', async () => {
    mockGet.mockRejectedValue(new Error('error'))
    const result = await upsert(dal, 'settings', 'project_id=eq.p1', { key: 'val' })
    expect(result).toBe(false)
  })
})

describe('batchInsert', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns count of successful inserts', async () => {
    mockInsert
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true })
    const count = await batchInsert(dal, 'my_table', [
      { id: '1' },
      { id: '2' },
      { id: '3' },
    ])
    expect(count).toBe(2)
  })

  it('returns 0 for empty records array', async () => {
    const count = await batchInsert(dal, 'my_table', [])
    expect(count).toBe(0)
  })

  it('handles rejected inserts gracefully', async () => {
    mockInsert
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('network error'))
    const count = await batchInsert(dal, 'my_table', [{ id: '1' }, { id: '2' }])
    expect(count).toBe(1)
  })
})

describe('projectLayer factory', () => {
  afterEach(() => vi.clearAllMocks())

  it('creates a PersistenceLayer with project_id filter', async () => {
    mockGet.mockResolvedValue([{ id: 'item-1' }])
    const layer = projectLayer<TestItem>(dal, 'my_table', 'project-abc')
    await layer.list()
    expect(mockGet).toHaveBeenCalledWith('my_table', 'project_id=eq.project-abc&deleted=not.is.true')
  })
})

describe('userLayer factory', () => {
  afterEach(() => vi.clearAllMocks())

  it('creates a PersistenceLayer with user_id filter', async () => {
    mockGet.mockResolvedValue([])
    const layer = userLayer<TestItem>(dal, 'user_items', 'user-xyz')
    await layer.list()
    expect(mockGet).toHaveBeenCalledWith('user_items', 'user_id=eq.user-xyz&deleted=not.is.true')
  })
})

describe('tenantLayer factory', () => {
  afterEach(() => vi.clearAllMocks())

  it('creates a PersistenceLayer with tenant_id filter', async () => {
    mockGet.mockResolvedValue([])
    const layer = tenantLayer<TestItem>(dal, 'tenant_items', 'tenant-123')
    await layer.list()
    expect(mockGet).toHaveBeenCalledWith('tenant_items', 'tenant_id=eq.tenant-123&deleted=not.is.true')
  })
})
