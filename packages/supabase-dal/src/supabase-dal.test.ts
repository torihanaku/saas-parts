/**
 * Ported from dev-dashboard-v2 tests/supabase.test.ts (generic helpers only).
 * Adapted: vi.mock of env/context modules became constructor config; the
 * product-specific state/activity/SSO helpers were removed with the port.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { createSupabaseDal, escapePostgrestValue, assertSafeStoragePath } from './index'

const dal = createSupabaseDal({
  url: 'https://test.supabase.co',
  serviceRoleKey: 'test-service-role-key',
  getCorrelationId: () => 'test-request-id',
})

function makeOkResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function makeErrorResponse(status: number, body = 'error'): Response {
  return new Response(body, { status })
}

let fetchSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch')
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  fetchSpy.mockRestore()
  errorSpy.mockRestore()
  warnSpy.mockRestore()
})

describe('url / headers', () => {
  it('exposes the configured Supabase URL', () => {
    expect(dal.url).toBe('https://test.supabase.co')
  })

  it('sends apikey, Authorization and X-Correlation-Id headers', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeOkResponse([])))
    await dal.get('my_table', 'id=eq.1')
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('https://test.supabase.co/rest/v1/my_table?id=eq.1')
    const headers = (opts as RequestInit).headers as Record<string, string>
    expect(headers['apikey']).toBe('test-service-role-key')
    expect(headers['Authorization']).toBe('Bearer test-service-role-key')
    expect(headers['X-Correlation-Id']).toBe('test-request-id')
  })

  it('omits X-Correlation-Id when no provider is configured', async () => {
    const plain = createSupabaseDal({ url: 'https://test.supabase.co', serviceRoleKey: 'k' })
    fetchSpy.mockImplementation(() => Promise.resolve(makeOkResponse([])))
    await plain.get('my_table')
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = (opts as RequestInit).headers as Record<string, string>
    expect(headers['X-Correlation-Id']).toBeUndefined()
  })

  it('uses an injected fetch implementation when provided', async () => {
    const customFetch = vi.fn().mockResolvedValue(makeOkResponse([{ id: 'x' }]))
    const custom = createSupabaseDal({ url: 'https://test.supabase.co', serviceRoleKey: 'k', fetch: customFetch })
    const rows = await custom.get('my_table')
    expect(rows).toEqual([{ id: 'x' }])
    expect(customFetch).toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('escapePostgrestValue', () => {
  it('escapes percent characters', () => {
    expect(escapePostgrestValue('100%')).toBe('100\\%')
  })

  it('escapes underscore characters', () => {
    expect(escapePostgrestValue('user_name')).toBe('user\\_name')
  })

  it('escapes backslash characters', () => {
    expect(escapePostgrestValue('path\\to')).toBe('path\\\\to')
  })

  it('escapes multiple special characters', () => {
    const result = escapePostgrestValue('foo%bar_baz')
    expect(result).toBe('foo\\%bar\\_baz')
  })

  it('returns plain strings unchanged', () => {
    expect(escapePostgrestValue('normalstring')).toBe('normalstring')
  })
})

describe('get', () => {
  it('returns rows on successful fetch', async () => {
    const data = [{ id: '1', name: 'Test' }]
    fetchSpy.mockImplementation(() => Promise.resolve(makeOkResponse(data)))
    const result = await dal.get('my_table', 'id=eq.1')
    expect(result).toEqual(data)
  })

  it('returns null on HTTP error', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeErrorResponse(500)))
    const result = await dal.get('my_table', '')
    expect(result).toBeNull()
  })

  it('returns null on network exception', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'))
    const result = await dal.get('my_table', '')
    expect(result).toBeNull()
  })
})

describe('insert', () => {
  it('returns ok:true on successful POST', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeOkResponse(null)))
    const result = await dal.insert('my_table', { name: 'test' })
    expect(result.ok).toBe(true)
  })

  it('returns ok:false with error text on HTTP error', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response('constraint violation', { status: 409 })))
    const result = await dal.insert('my_table', { name: 'dup' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(409)
  })

  it('returns ok:false on network exception', async () => {
    fetchSpy.mockRejectedValue(new Error('connection refused'))
    const result = await dal.insert('my_table', { name: 'fail' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('connection refused')
  })
})

describe('insertReturning', () => {
  it('returns ok:true and data on successful POST', async () => {
    const rows = [{ id: 'new-1', name: 'Created' }]
    fetchSpy.mockImplementation(() => Promise.resolve(makeOkResponse(rows)))
    const result = await dal.insertReturning('my_table', { name: 'Created' })
    expect(result.ok).toBe(true)
    expect(result.data).toEqual(rows)
  })

  it('returns ok:false on error', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeErrorResponse(422, 'validation error')))
    const result = await dal.insertReturning('my_table', { name: 'bad' })
    expect(result.ok).toBe(false)
  })

  it('returns ok:false on exception', async () => {
    fetchSpy.mockRejectedValue(new Error('timeout'))
    const result = await dal.insertReturning('my_table', { name: 'fail' })
    expect(result.ok).toBe(false)
  })
})

describe('patch', () => {
  it('returns ok:true on successful PATCH', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeOkResponse(null)))
    const result = await dal.patch('my_table', 'id=eq.1', { status: 'done' })
    expect(result.ok).toBe(true)
  })

  it('returns ok:false on HTTP error', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeErrorResponse(404)))
    const result = await dal.patch('my_table', 'id=eq.missing', { status: 'x' })
    expect(result.ok).toBe(false)
  })

  it('returns ok:false on exception', async () => {
    fetchSpy.mockRejectedValue(new Error('net error'))
    const result = await dal.patch('my_table', 'id=eq.1', { x: 1 })
    expect(result.ok).toBe(false)
  })
})

describe('delete', () => {
  it('returns ok:true on successful DELETE', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeOkResponse(null)))
    const result = await dal.delete('my_table', 'id=eq.1')
    expect(result.ok).toBe(true)
  })

  it('returns ok:false with status on HTTP error', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeErrorResponse(404)))
    const result = await dal.delete('my_table', 'id=eq.missing')
    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
  })

  it('returns ok:false on network exception', async () => {
    fetchSpy.mockRejectedValue(new Error('net error'))
    const result = await dal.delete('my_table', 'id=eq.1')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('net error')
  })
})

describe('assertSafeStoragePath', () => {
  it('accepts normal nested paths', () => {
    expect(() => assertSafeStoragePath('tenant-1/2026/report.pdf')).not.toThrow()
    expect(() => assertSafeStoragePath('file.pdf')).not.toThrow()
  })

  it('rejects "../" traversal segments', () => {
    expect(() => assertSafeStoragePath('../../secret-bucket/creds.json')).toThrow(/traversal/)
    expect(() => assertSafeStoragePath('a/../../b')).toThrow(/traversal/)
  })

  it('rejects "." and ".." segments and absolute paths', () => {
    expect(() => assertSafeStoragePath('./a')).toThrow(/traversal/)
    expect(() => assertSafeStoragePath('/etc/passwd')).toThrow(/relative/)
  })

  it('rejects backslashes and empty paths', () => {
    expect(() => assertSafeStoragePath('a\\..\\b')).toThrow(/backslash/)
    expect(() => assertSafeStoragePath('')).toThrow(/non-empty/)
  })
})

describe('storage path traversal is blocked at the wrapper', () => {
  it('upload with a traversal path returns ok:false and never calls fetch', async () => {
    const result = await dal.upload('tenant-abc', '../../secret-bucket/creds.json', 'x', 'application/json')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/traversal/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('download with a traversal path returns null and never calls fetch', async () => {
    const result = await dal.download('tenant-abc', '../../secret-bucket/creds.json')
    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still allows a legitimate nested upload path', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeOkResponse({ Key: 'ok' })))
    const result = await dal.upload('docs', 'tenant-1/2026/file.pdf', 'content', 'application/pdf')
    expect(result.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalled()
  })
})

describe('upload', () => {
  it('returns ok:true on successful upload', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeOkResponse({ Key: 'path/file.pdf' })))
    const result = await dal.upload('docs', 'file.pdf', 'binary content', 'application/pdf')
    expect(result.ok).toBe(true)
  })

  it('returns ok:false on upload error', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeErrorResponse(403, 'unauthorized')))
    const result = await dal.upload('docs', 'file.pdf', 'content', 'application/pdf')
    expect(result.ok).toBe(false)
  })

  it('returns ok:false on exception', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'))
    const result = await dal.upload('docs', 'file.pdf', 'content', 'application/pdf')
    expect(result.ok).toBe(false)
  })
})

describe('download', () => {
  it('returns the Response on success', async () => {
    const mockResponse = makeOkResponse('file content')
    fetchSpy.mockImplementation(() => Promise.resolve(mockResponse))
    const result = await dal.download('docs', 'file.pdf')
    expect(result).not.toBeNull()
    expect(result!.ok).toBe(true)
  })

  it('returns null on HTTP error', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeErrorResponse(404, 'not found')))
    const result = await dal.download('docs', 'missing.pdf')
    expect(result).toBeNull()
  })

  it('returns null on exception', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'))
    const result = await dal.download('docs', 'file.pdf')
    expect(result).toBeNull()
  })
})

describe('rpc', () => {
  it('returns parsed JSON on success', async () => {
    const responseData = { result: 42 }
    fetchSpy.mockImplementation(() => Promise.resolve(makeOkResponse(responseData)))
    const result = await dal.rpc('my_function', { param: 'value' })
    expect(result).toEqual(responseData)
  })

  it('POSTs to the rpc endpoint', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeOkResponse(null)))
    await dal.rpc('my_function', { param: 'value' })
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('https://test.supabase.co/rest/v1/rpc/my_function')
    expect((opts as RequestInit).method).toBe('POST')
  })

  it('returns null on HTTP error', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeErrorResponse(500, 'function error')))
    const result = await dal.rpc('my_function', {})
    expect(result).toBeNull()
  })

  it('returns null on exception', async () => {
    fetchSpy.mockRejectedValue(new Error('rpc error'))
    const result = await dal.rpc('my_function', {})
    expect(result).toBeNull()
  })
})
