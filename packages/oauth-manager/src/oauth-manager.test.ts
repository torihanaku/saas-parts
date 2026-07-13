/**
 * Tests for src/oauth-manager.ts
 * OAuth 2.0 flow manager: auth URL, PKCE, token exchange, persistence.
 *
 * Ported from 実運用SaaS/tests/oauth-manager.test.ts with mocks adapted:
 *   - '../server/lib/supabase' mock → injected mock ConnectionStore
 *   - '../server/lib/helpers' (fetchWithTimeout) mock → injected mock fetch
 *   - '../server/lib/env' mock → caller-supplied credentials for factories
 *   - './oauth-state' is still module-mocked (generate/consume)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('./oauth-state', () => ({
  generateOAuthState: vi.fn().mockResolvedValue(JSON.stringify({ type: 'slack', nonce: 'test-nonce-abc' })),
  consumeOAuthState: vi.fn().mockResolvedValue({ valid: true }),
  verifyOAuthState: vi.fn().mockResolvedValue(true),
}))

import {
  OAuthManager,
  generatePkce,
  createSlackOAuthManager,
  createGitHubOAuthManager,
  type OAuthProviderConfig,
  type OAuthToken,
} from './oauth-manager'
import { generateOAuthState, consumeOAuthState } from './oauth-state'
import type { ConnectionStore } from './connection-store'

const mockGenerateOAuthState = vi.mocked(generateOAuthState)
const mockConsumeOAuthState = vi.mocked(consumeOAuthState)

const mockConnectionStore = {
  insert: vi.fn<ConnectionStore['insert']>(),
  patch: vi.fn<ConnectionStore['patch']>(),
  get: vi.fn<ConnectionStore['get']>(),
} satisfies ConnectionStore

const mockFetch = vi.fn<typeof fetch>()

const testConfig: OAuthProviderConfig = {
  authorizationUrl: 'https://provider.example.com/oauth/authorize',
  tokenUrl: 'https://provider.example.com/oauth/token',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  scope: 'read write',
}

const testOptions = { connectionStore: mockConnectionStore, fetch: mockFetch }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('OAuthManager.buildAuthUrl', () => {
  it('returns url and state', async () => {
    const stateJson = JSON.stringify({ type: 'test', nonce: 'nonce-123' })
    mockGenerateOAuthState.mockResolvedValue(stateJson)

    const manager = new OAuthManager('test', testConfig, testOptions)
    const result = await manager.buildAuthUrl('https://app.example.com/callback')

    expect(result.state).toBe(stateJson)
    expect(result.url).toContain(testConfig.authorizationUrl)
    expect(result.url).toContain('client_id=test-client-id')
    expect(result.url).toContain('response_type=code')
    expect(result.url).toContain('scope=read+write')
  })

  it('includes extra auth params when configured', async () => {
    mockGenerateOAuthState.mockResolvedValue('{"type":"test","nonce":"n"}')
    const configWithExtras: OAuthProviderConfig = {
      ...testConfig,
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    }
    const manager = new OAuthManager('test', configWithExtras, testOptions)
    const { url } = await manager.buildAuthUrl('https://app.example.com/callback')
    expect(url).toContain('access_type=offline')
    expect(url).toContain('prompt=consent')
  })

  it('omits scope param when not configured', async () => {
    mockGenerateOAuthState.mockResolvedValue('{"type":"test","nonce":"n"}')
    const configNoScope: OAuthProviderConfig = {
      ...testConfig,
      scope: undefined,
    }
    const manager = new OAuthManager('test', configNoScope, testOptions)
    const { url } = await manager.buildAuthUrl('https://app.example.com/callback')
    expect(url).not.toContain('scope=')
  })

  it('attaches an S256 code_challenge and stores the verifier when usePkce is set', async () => {
    mockGenerateOAuthState.mockResolvedValue('{"type":"test","nonce":"n"}')
    const manager = new OAuthManager('test', { ...testConfig, usePkce: true }, testOptions)
    const { url } = await manager.buildAuthUrl('https://app.example.com/callback')

    expect(url).toContain('code_challenge_method=S256')
    const challenge = new URL(url).searchParams.get('code_challenge')
    expect(challenge).toBeTruthy()

    // The verifier passed to state storage must hash (S256) to the challenge in the URL
    const call = mockGenerateOAuthState.mock.calls[0]!
    const data = call[2] as { verifier: string }
    expect(typeof data.verifier).toBe('string')
    expect(data.verifier.length).toBeGreaterThanOrEqual(43)
    const expected = createHash('sha256').update(data.verifier).digest('base64url')
    expect(challenge).toBe(expected)
  })

  it('does not attach PKCE params when usePkce is not set', async () => {
    mockGenerateOAuthState.mockResolvedValue('{"type":"test","nonce":"n"}')
    const manager = new OAuthManager('test', testConfig, testOptions)
    const { url } = await manager.buildAuthUrl('https://app.example.com/callback')
    expect(url).not.toContain('code_challenge')
  })
})

describe('generatePkce', () => {
  it('produces an RFC 7636 compliant verifier/challenge pair', () => {
    const { verifier, challenge, method } = generatePkce()
    expect(method).toBe('S256')
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('generates unique verifiers on each call', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier)
  })
})

describe('OAuthManager.exchangeCode', () => {
  it('exchanges code for tokens on success', async () => {
    mockConsumeOAuthState.mockResolvedValue({ valid: true })
    const tokenResponse: OAuthToken = {
      access_token: 'access-token-123',
      refresh_token: 'refresh-token-456',
      token_type: 'Bearer',
      scope: 'read write',
    }
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    )

    const manager = new OAuthManager('slack', testConfig, testOptions)
    const token = await manager.exchangeCode('auth-code', '{"type":"slack","nonce":"n"}', 'https://app.example.com/cb')
    expect(token.access_token).toBe('access-token-123')
    expect(token.refresh_token).toBe('refresh-token-456')
  })

  it('sends the exact authorization_code request shape', async () => {
    mockConsumeOAuthState.mockResolvedValue({ valid: true })
    mockFetch.mockResolvedValue(new Response('{"access_token":"at"}', { status: 200 }))

    const manager = new OAuthManager('slack', testConfig, testOptions)
    await manager.exchangeCode('auth-code', '{"type":"slack","nonce":"n"}', 'https://app.example.com/cb')

    const [url, init] = mockFetch.mock.calls[0]!
    expect(url).toBe(testConfig.tokenUrl)
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    const body = init?.body as URLSearchParams
    expect(body.get('client_id')).toBe('test-client-id')
    expect(body.get('client_secret')).toBe('test-client-secret')
    expect(body.get('code')).toBe('auth-code')
    expect(body.get('redirect_uri')).toBe('https://app.example.com/cb')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code_verifier')).toBeNull()
  })

  it('includes the stored PKCE code_verifier in the token exchange', async () => {
    mockConsumeOAuthState.mockResolvedValue({ valid: true, verifier: 'test-verifier' })
    mockFetch.mockResolvedValue(new Response('{"access_token":"at"}', { status: 200 }))

    const manager = new OAuthManager('slack', { ...testConfig, usePkce: true }, testOptions)
    await manager.exchangeCode('auth-code', '{"type":"slack","nonce":"n"}', 'https://app.example.com/cb')

    const [, init] = mockFetch.mock.calls[0]!
    const body = init?.body as URLSearchParams
    expect(body.get('code_verifier')).toBe('test-verifier')
  })

  it('throws when state is invalid', async () => {
    mockConsumeOAuthState.mockResolvedValue({ valid: false })
    const manager = new OAuthManager('slack', testConfig, testOptions)
    await expect(
      manager.exchangeCode('code', 'invalid-state', 'https://app.example.com/cb')
    ).rejects.toThrow('Invalid or expired OAuth state')
  })

  it('throws when token endpoint returns an error', async () => {
    mockConsumeOAuthState.mockResolvedValue({ valid: true })
    mockFetch.mockResolvedValue(
      new Response('invalid_grant', { status: 400 })
    )
    const manager = new OAuthManager('slack', testConfig, testOptions)
    await expect(
      manager.exchangeCode('bad-code', '{"type":"slack","nonce":"n"}', 'https://app.example.com/cb')
    ).rejects.toThrow('Token exchange failed (400)')
  })
})

describe('OAuthManager.refreshToken', () => {
  it('refreshes and returns new tokens', async () => {
    const newToken: OAuthToken = { access_token: 'new-access-token', token_type: 'Bearer' }
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(newToken), { status: 200 })
    )
    const manager = new OAuthManager('slack', testConfig, testOptions)
    const token = await manager.refreshToken('old-refresh-token')
    expect(token.access_token).toBe('new-access-token')
  })

  it('sends the exact refresh_token request shape', async () => {
    mockFetch.mockResolvedValue(new Response('{"access_token":"at"}', { status: 200 }))
    const manager = new OAuthManager('slack', testConfig, testOptions)
    await manager.refreshToken('old-refresh-token')

    const [url, init] = mockFetch.mock.calls[0]!
    expect(url).toBe(testConfig.tokenUrl)
    const body = init?.body as URLSearchParams
    expect(body.get('client_id')).toBe('test-client-id')
    expect(body.get('client_secret')).toBe('test-client-secret')
    expect(body.get('refresh_token')).toBe('old-refresh-token')
    expect(body.get('grant_type')).toBe('refresh_token')
  })

  it('throws when refresh endpoint returns error', async () => {
    mockFetch.mockResolvedValue(
      new Response('token_expired', { status: 401 })
    )
    const manager = new OAuthManager('slack', testConfig, testOptions)
    await expect(manager.refreshToken('expired-token')).rejects.toThrow('Token refresh failed (401)')
  })
})

describe('OAuthManager.saveConnection', () => {
  it('inserts connection and returns OAuthConnection', async () => {
    mockConnectionStore.insert.mockResolvedValue({ ok: true })
    const token: OAuthToken = {
      access_token: 'at-123',
      refresh_token: 'rt-456',
      scope: 'read',
      metadata: { team: 'my-team' },
    }
    const manager = new OAuthManager('slack', testConfig, testOptions)
    const conn = await manager.saveConnection('user-1', token)
    expect(conn.provider).toBe('slack')
    expect(conn.user_id).toBe('user-1')
    expect(conn.access_token).toBe('at-123')
    expect(conn.status).toBe('active')
    expect(mockConnectionStore.insert).toHaveBeenCalledWith(
      'oauth_connections',
      expect.objectContaining({ provider: 'slack', user_id: 'user-1' })
    )
  })

  it('uses a custom table name when configured', async () => {
    mockConnectionStore.insert.mockResolvedValue({ ok: true })
    const manager = new OAuthManager('slack', testConfig, { ...testOptions, table: 'my_connections' })
    await manager.saveConnection('user-1', { access_token: 'at' })
    expect(mockConnectionStore.insert).toHaveBeenCalledWith('my_connections', expect.anything())
  })
})

describe('OAuthManager.updateConnection', () => {
  it('patches access_token and returns true on success', async () => {
    mockConnectionStore.patch.mockResolvedValue({ ok: true })
    const manager = new OAuthManager('slack', testConfig, testOptions)
    const result = await manager.updateConnection('conn-1', {
      access_token: 'new-at',
      refresh_token: 'new-rt',
    })
    expect(result).toBe(true)
    expect(mockConnectionStore.patch).toHaveBeenCalledWith(
      'oauth_connections',
      expect.stringContaining('conn-1'),
      expect.objectContaining({ access_token: 'new-at', refresh_token: 'new-rt' }),
    )
  })

  it('returns false when patch fails', async () => {
    mockConnectionStore.patch.mockResolvedValue({ ok: false })
    const manager = new OAuthManager('slack', testConfig, testOptions)
    const result = await manager.updateConnection('conn-1', { access_token: 'new-at' })
    expect(result).toBe(false)
  })

  it('does not include refresh_token in patch when not provided', async () => {
    mockConnectionStore.patch.mockResolvedValue({ ok: true })
    const manager = new OAuthManager('slack', testConfig, testOptions)
    await manager.updateConnection('conn-1', { access_token: 'new-at' })
    const [, , patchData] = mockConnectionStore.patch.mock.calls[0]!
    expect(patchData).not.toHaveProperty('refresh_token')
  })
})

describe('OAuthManager.revokeConnection', () => {
  it('patches status to "revoked" and returns true', async () => {
    mockConnectionStore.patch.mockResolvedValue({ ok: true })
    const manager = new OAuthManager('slack', testConfig, testOptions)
    const result = await manager.revokeConnection('conn-1')
    expect(result).toBe(true)
    const [, , data] = mockConnectionStore.patch.mock.calls[0]!
    expect(data.status).toBe('revoked')
  })

  it('returns false when patch fails', async () => {
    mockConnectionStore.patch.mockResolvedValue({ ok: false })
    const manager = new OAuthManager('slack', testConfig, testOptions)
    const result = await manager.revokeConnection('conn-1')
    expect(result).toBe(false)
  })
})

describe('OAuthManager.listConnections', () => {
  it('returns connections for a user', async () => {
    const conns = [{ id: 'c1', provider: 'slack', user_id: 'user-1', status: 'active' }]
    mockConnectionStore.get.mockResolvedValue(conns)
    const manager = new OAuthManager('slack', testConfig, testOptions)
    const result = await manager.listConnections('user-1')
    expect(result).toHaveLength(1)
    expect(result[0]?.provider).toBe('slack')
  })

  it('returns empty array when no connections', async () => {
    mockConnectionStore.get.mockResolvedValue([])
    const manager = new OAuthManager('slack', testConfig, testOptions)
    const result = await manager.listConnections('user-1')
    expect(result).toEqual([])
  })

  it('returns empty array when the store returns null', async () => {
    mockConnectionStore.get.mockResolvedValue(null)
    const manager = new OAuthManager('slack', testConfig, testOptions)
    const result = await manager.listConnections('user-1')
    expect(result).toEqual([])
  })
})

describe('OAuthManager.getConnection', () => {
  it('returns connection by ID', async () => {
    const conn = { id: 'c1', provider: 'slack', user_id: 'user-1' }
    mockConnectionStore.get.mockResolvedValue([conn])
    const manager = new OAuthManager('slack', testConfig, testOptions)
    const result = await manager.getConnection('c1')
    expect(result).toEqual(conn)
  })

  it('returns null when connection not found', async () => {
    mockConnectionStore.get.mockResolvedValue([])
    const manager = new OAuthManager('slack', testConfig, testOptions)
    const result = await manager.getConnection('nonexistent')
    expect(result).toBeNull()
  })

  it('returns null when the store returns null', async () => {
    mockConnectionStore.get.mockResolvedValue(null)
    const manager = new OAuthManager('slack', testConfig, testOptions)
    const result = await manager.getConnection('c1')
    expect(result).toBeNull()
  })
})

describe('createSlackOAuthManager', () => {
  it('returns an OAuthManager when Slack credentials are supplied', () => {
    const manager = createSlackOAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    })
    expect(manager).not.toBeNull()
    expect(manager).toBeInstanceOf(OAuthManager)
  })

  it('returns null when Slack credentials are missing', () => {
    expect(createSlackOAuthManager({})).toBeNull()
  })
})

describe('createGitHubOAuthManager', () => {
  it('returns null when GitHub credentials are empty', () => {
    const manager = createGitHubOAuthManager({ clientId: '', clientSecret: '' })
    expect(manager).toBeNull()
  })

  it('returns an OAuthManager when GitHub credentials are supplied', () => {
    const manager = createGitHubOAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    })
    expect(manager).toBeInstanceOf(OAuthManager)
  })
})
