/**
 * Ported from dev-dashboard-v2 tests/helpers.test.ts (imports adapted).
 */
import { describe, it, expect, vi } from 'vitest'
import { parsePagination, generateETag, checkConditionalRequest, getContentType, jsonResponse, paginatedResponse } from './index'

describe('parsePagination', () => {
  it('returns defaults when no params', () => {
    const url = new URL('http://localhost/api/test')
    const result = parsePagination(url)
    expect(result.page).toBe(1)
    expect(result.limit).toBe(20)
    expect(result.offset).toBe(0)
  })

  it('respects page and limit params', () => {
    const url = new URL('http://localhost/api/test?page=3&limit=10')
    const result = parsePagination(url)
    expect(result.page).toBe(3)
    expect(result.limit).toBe(10)
    expect(result.offset).toBe(20)
  })

  it('clamps limit to maxLimit', () => {
    const url = new URL('http://localhost/api/test?limit=500')
    const result = parsePagination(url, 20, 100)
    expect(result.limit).toBe(100)
  })

  it('clamps page to minimum 1', () => {
    const url = new URL('http://localhost/api/test?page=-5')
    const result = parsePagination(url)
    expect(result.page).toBe(1)
  })

  it('clamps limit to minimum 1', () => {
    const url = new URL('http://localhost/api/test?limit=0')
    const result = parsePagination(url)
    expect(result.limit).toBe(1)
  })

  it('falls back to defaults for non-numeric params (no NaN leaks into limit/offset)', () => {
    const url = new URL('http://localhost/api/test?page=abc&limit=xyz')
    const result = parsePagination(url, 20, 100)
    expect(result.page).toBe(1)
    expect(result.limit).toBe(20)
    expect(result.offset).toBe(0)
    expect(Number.isNaN(result.limit)).toBe(false)
    expect(Number.isNaN(result.offset)).toBe(false)
  })

  it('falls back to default when only limit is non-numeric', () => {
    const url = new URL('http://localhost/api/test?page=3&limit=notanumber')
    const result = parsePagination(url, 25, 100)
    expect(result.page).toBe(3)
    expect(result.limit).toBe(25)
    expect(result.offset).toBe(50)
  })
})

describe('generateETag', () => {
  it('generates consistent ETags for same data', () => {
    const data = { key: 'value', num: 42 }
    const etag1 = generateETag(data)
    const etag2 = generateETag(data)
    expect(etag1).toBe(etag2)
  })

  it('generates different ETags for different data', () => {
    const etag1 = generateETag({ a: 1 })
    const etag2 = generateETag({ a: 2 })
    expect(etag1).not.toBe(etag2)
  })

  it('produces W/ prefixed weak ETag', () => {
    const etag = generateETag({ test: true })
    expect(etag).toMatch(/^W\/"[a-f0-9]{16}"$/)
  })
})

describe('checkConditionalRequest', () => {
  it('returns 304 when ETag matches', () => {
    const etag = 'W/"abc123"'
    const req = new Request('http://localhost', {
      headers: { 'If-None-Match': etag },
    })
    const result = checkConditionalRequest(req, etag)
    expect(result).not.toBeNull()
    expect(result!.status).toBe(304)
  })

  it('returns null when ETag does not match', () => {
    const req = new Request('http://localhost', {
      headers: { 'If-None-Match': 'W/"old"' },
    })
    const result = checkConditionalRequest(req, 'W/"new"')
    expect(result).toBeNull()
  })

  it('returns null when no If-None-Match header', () => {
    const req = new Request('http://localhost')
    const result = checkConditionalRequest(req, 'W/"etag"')
    expect(result).toBeNull()
  })
})

describe('getContentType', () => {
  it('returns correct types for common extensions', () => {
    expect(getContentType('file.html')).toBe('text/html; charset=utf-8')
    expect(getContentType('file.css')).toBe('text/css; charset=utf-8')
    expect(getContentType('file.js')).toBe('application/javascript; charset=utf-8')
    expect(getContentType('file.json')).toBe('application/json')
    expect(getContentType('file.svg')).toBe('image/svg+xml')
    expect(getContentType('file.png')).toBe('image/png')
    expect(getContentType('file.jpg')).toBe('image/jpeg')
    expect(getContentType('file.woff2')).toBe('font/woff2')
  })

  it('returns octet-stream for unknown extensions', () => {
    expect(getContentType('file.xyz')).toBe('application/octet-stream')
  })
})

describe('jsonResponse', () => {
  it('returns plain JSON response for small payloads', async () => {
    const req = new Request('http://localhost')
    const res = jsonResponse({ ok: true }, req, 200)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })

  it('merges extra headers into the response', async () => {
    const req = new Request('http://localhost')
    const res = jsonResponse({ x: 1 }, req, 201, { 'X-Custom': 'yes' })
    expect(res.status).toBe(201)
    expect(res.headers.get('X-Custom')).toBe('yes')
  })

  it('compresses large payload when client accepts gzip', async () => {
    const req = new Request('http://localhost', {
      headers: { 'Accept-Encoding': 'gzip, deflate' },
    })
    const large = { data: 'x'.repeat(2000) }
    const res = jsonResponse(large, req)
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('Vary')).toBe('Accept-Encoding')
  })

  it('does not compress when client does not accept gzip', async () => {
    const req = new Request('http://localhost')
    const large = { data: 'x'.repeat(2000) }
    const res = jsonResponse(large, req)
    expect(res.headers.get('Content-Encoding')).toBeNull()
  })
})

describe('paginatedResponse', () => {
  it('returns correct envelope with has_next true', () => {
    const result = paginatedResponse([1, 2, 3], 30, 1, 10)
    expect(result.data).toEqual([1, 2, 3])
    expect(result.total_count).toBe(30)
    expect(result.page).toBe(1)
    expect(result.per_page).toBe(10)
    expect(result.has_next).toBe(true)
  })

  it('returns has_next false on last page', () => {
    const result = paginatedResponse([1], 21, 3, 10)
    expect(result.has_next).toBe(false)
  })
})

describe('fetchWithTimeout', () => {
  it('resolves with the fetch response on success', async () => {
    const { fetchWithTimeout } = await import('./index')
    const mockRes = new Response(JSON.stringify({ ok: true }), { status: 200 })
    const fetchMock = vi.fn().mockResolvedValue(mockRes)
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchWithTimeout('http://localhost/test', {}, 5000)
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/test',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    vi.unstubAllGlobals()
  })

  it('passes custom options to fetch', async () => {
    const { fetchWithTimeout } = await import('./index')
    const mockRes = new Response('{}', { status: 201 })
    const fetchMock = vi.fn().mockResolvedValue(mockRes)
    vi.stubGlobal('fetch', fetchMock)
    await fetchWithTimeout('http://localhost', { method: 'POST' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost',
      expect.objectContaining({ method: 'POST' })
    )
    vi.unstubAllGlobals()
  })
})
