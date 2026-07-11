/**
 * Tests for @torihanaku/logger — AsyncLocalStorage request context.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  requestContext,
  getRequestId,
  getRequestContext,
  runWithRequestContext,
  logInfo,
  logError,
} from './index'

describe('request context', () => {
  it('getRequestContext returns undefined outside a run', () => {
    expect(getRequestContext()).toBeUndefined()
  })

  it('getRequestId generates a fresh UUID outside a context', () => {
    const id = getRequestId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    // Not stable outside a context — each call generates a new one
    expect(getRequestId()).not.toBe(id)
  })

  it('returns the bound requestId inside a context', () => {
    runWithRequestContext({ requestId: 'req-123', startTime: 1 }, () => {
      expect(getRequestId()).toBe('req-123')
      expect(getRequestContext()).toMatchObject({ requestId: 'req-123', startTime: 1 })
    })
  })

  it('fills in defaults for missing fields', () => {
    runWithRequestContext({}, () => {
      const ctx = getRequestContext()
      expect(ctx).toBeDefined()
      expect(ctx!.requestId).toMatch(/^[0-9a-f-]{36}$/i)
      expect(typeof ctx!.startTime).toBe('number')
      expect(ctx!.userId).toBeUndefined()
    })
  })

  it('carries userId when provided', () => {
    runWithRequestContext({ requestId: 'r', userId: 'user-1', startTime: 0 }, () => {
      expect(getRequestContext()?.userId).toBe('user-1')
    })
  })

  it('propagates across await boundaries', async () => {
    await runWithRequestContext({ requestId: 'req-async', startTime: 0 }, async () => {
      expect(getRequestId()).toBe('req-async')
      await new Promise((r) => setTimeout(r, 1))
      expect(getRequestId()).toBe('req-async')
      await Promise.resolve().then(() => {
        expect(getRequestId()).toBe('req-async')
      })
    })
  })

  it('isolates concurrent contexts from each other', async () => {
    const seen: string[] = []
    const task = (id: string) =>
      runWithRequestContext({ requestId: id, startTime: 0 }, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5))
        seen.push(getRequestId())
        expect(getRequestId()).toBe(id)
      })
    await Promise.all([task('req-a'), task('req-b'), task('req-c')])
    expect(seen.sort()).toEqual(['req-a', 'req-b', 'req-c'])
  })

  it('restores the outer context after a nested run', () => {
    runWithRequestContext({ requestId: 'outer', startTime: 0 }, () => {
      runWithRequestContext({ requestId: 'inner', startTime: 0 }, () => {
        expect(getRequestId()).toBe('inner')
      })
      expect(getRequestId()).toBe('outer')
    })
  })

  it('exposes the raw AsyncLocalStorage for low-level integration', () => {
    requestContext.run({ requestId: 'raw', startTime: 0 }, () => {
      expect(getRequestId()).toBe('raw')
    })
  })
})

describe('logger × request context integration', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('log lines include requestId when a context is active', () => {
    runWithRequestContext({ requestId: 'req-log-1', startTime: 0 }, () => {
      logInfo('ctx.log', 'hello')
    })
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
    expect(parsed.requestId).toBe('req-log-1')
    expect(parsed.message).toBe('hello')
  })

  it('log lines omit requestId outside a context', () => {
    logInfo('ctx.log', 'no context')
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
    expect('requestId' in parsed).toBe(false)
  })

  it('requestId in the log line is NOT redacted even when it is a UUID (sanitize applies to message only)', () => {
    runWithRequestContext(
      { requestId: '550e8400-e29b-41d4-a716-446655440000', startTime: 0 },
      () => {
        logError('ctx.err', new Error('boom for 550e8400-e29b-41d4-a716-446655440001'))
      }
    )
    const parsed = JSON.parse(errSpy.mock.calls[0]?.[0] as string)
    expect(parsed.requestId).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(parsed.message).toBe('boom for [UUID]')
  })

  it('includes requestId across async boundaries', async () => {
    await runWithRequestContext({ requestId: 'req-deep', startTime: 0 }, async () => {
      await new Promise((r) => setTimeout(r, 1))
      logInfo('ctx.deep', 'after await')
    })
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
    expect(parsed.requestId).toBe('req-deep')
  })
})
