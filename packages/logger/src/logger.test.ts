/**
 * Tests for @torihanaku/logger — PII sanitization + error sink.
 * Ported from 実運用SaaS tests/logger.test.ts
 * (Sentry mock replaced by the injected error sink).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { logError, logWarn, logInfo, sanitize, setErrorSink } from './index'

type Spy = ReturnType<typeof vi.spyOn>

describe('logger — PII sanitization', () => {
  let errSpy: Spy
  let warnSpy: Spy
  let logSpy: Spy

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setErrorSink(null)
  })

  function capture(spy: Spy): string {
    const raw = spy.mock.calls[0]?.[0] as string
    const parsed = JSON.parse(raw) as { severity: string; context: string; message: string }
    return parsed.message
  }

  describe('logError', () => {
    it('emits ERROR severity and context with the Error message', () => {
      logError('ctx.one', new Error('boom'))
      expect(errSpy).toHaveBeenCalledOnce()
      const raw = errSpy.mock.calls[0]?.[0] as string
      const parsed = JSON.parse(raw)
      expect(parsed.severity).toBe('ERROR')
      expect(parsed.context).toBe('ctx.one')
      expect(parsed.message).toBe('boom')
    })

    it('coerces non-Error values to string', () => {
      logError('ctx.two', 'plain-string')
      expect(capture(errSpy)).toBe('plain-string')
    })

    it('coerces object values to string before sanitizing', () => {
      logError('ctx.obj', { code: 500 })
      expect(capture(errSpy)).toBe('[object Object]')
    })

    it('redacts email addresses', () => {
      logError('ctx.email', new Error('failed for user@example.com during fetch'))
      expect(capture(errSpy)).toBe('failed for [EMAIL] during fetch')
    })

    it('redacts Bearer tokens of 8+ chars', () => {
      logError('ctx.bearer', new Error('Bearer abcdefghij123'))
      expect(capture(errSpy)).toContain('[REDACTED]')
      expect(capture(errSpy)).not.toContain('abcdefghij123')
    })

    it('redacts apiKey=... assignments', () => {
      logError('ctx.apikey', new Error('apiKey=sk-1234567890abcdef'))
      expect(capture(errSpy)).toContain('[REDACTED]')
      expect(capture(errSpy)).not.toContain('sk-1234567890abcdef')
    })

    it('redacts UUIDs', () => {
      logError('ctx.uuid', new Error('user 550e8400-e29b-41d4-a716-446655440000 denied'))
      expect(capture(errSpy)).toBe('user [UUID] denied')
    })

    it('redacts multiple PII patterns in a single message', () => {
      logError(
        'ctx.multi',
        new Error(
          'user a@b.com (550e8400-e29b-41d4-a716-446655440000) with password="supersecret123"'
        )
      )
      const msg = capture(errSpy)
      expect(msg).toContain('[EMAIL]')
      expect(msg).toContain('[UUID]')
      expect(msg).toContain('[REDACTED]')
      expect(msg).not.toContain('a@b.com')
      expect(msg).not.toContain('supersecret123')
    })

    it('does NOT call the error sink when none is injected', () => {
      const sink = vi.fn()
      setErrorSink(sink)
      setErrorSink(null)
      logError('ctx.nosink', new Error('x'))
      expect(sink).not.toHaveBeenCalled()
    })

    it('calls the injected error sink with the original Error and context', () => {
      const sink = vi.fn()
      setErrorSink(sink)
      const err = new Error('tracked')
      logError('ctx.sink', err)
      expect(sink).toHaveBeenCalledWith(err, { context: 'ctx.sink' })
    })

    it('wraps non-Error values before sending to the sink', () => {
      const sink = vi.fn()
      setErrorSink(sink)
      logError('ctx.wrap', 'plain')
      const firstArg = sink.mock.calls[0]?.[0]
      expect(firstArg).toBeInstanceOf(Error)
      expect((firstArg as Error).message).toBe('plain')
    })
  })

  describe('logWarn', () => {
    it('emits WARNING severity with sanitized message', () => {
      logWarn('ctx.warn', 'rate-limited user a@b.com')
      expect(warnSpy).toHaveBeenCalledOnce()
      const raw = warnSpy.mock.calls[0]?.[0] as string
      const parsed = JSON.parse(raw)
      expect(parsed.severity).toBe('WARNING')
      expect(parsed.context).toBe('ctx.warn')
      expect(parsed.message).toBe('rate-limited user [EMAIL]')
    })

    it('redacts token assignments in objects serialized into the message', () => {
      logWarn('ctx.warn.obj', JSON.stringify({ token: 'abcdefgh12345678', ok: true }))
      const msg = capture(warnSpy)
      expect(msg).toContain('[REDACTED]')
      expect(msg).not.toContain('abcdefgh12345678')
    })
  })

  describe('logInfo', () => {
    it('emits INFO severity with sanitized message', () => {
      logInfo('ctx.info', 'login uuid 550e8400-e29b-41d4-a716-446655440000')
      expect(logSpy).toHaveBeenCalledOnce()
      const raw = logSpy.mock.calls[0]?.[0] as string
      const parsed = JSON.parse(raw)
      expect(parsed.severity).toBe('INFO')
      expect(parsed.context).toBe('ctx.info')
      expect(parsed.message).toBe('login uuid [UUID]')
    })
  })

  describe('sanitize (exported directly)', () => {
    it('redacts secret= assignments of 8+ chars', () => {
      const out = sanitize('secret=verylongsecretvalue')
      expect(out).toContain('[REDACTED]')
      expect(out).not.toContain('verylongsecretvalue')
    })

    it('leaves short values (<8 chars) after keywords untouched', () => {
      expect(sanitize('token=short')).toBe('token=short')
    })

    it('leaves non-PII text untouched', () => {
      expect(sanitize('fetch failed with status 502')).toBe('fetch failed with status 502')
    })
  })
})
