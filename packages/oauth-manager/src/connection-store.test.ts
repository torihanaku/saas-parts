/**
 * Tests for src/connection-store.ts
 * In-memory default ConnectionStore, exercised through the same PostgREST-style
 * query strings that OAuthManager emits.
 */
import { describe, it, expect } from 'vitest'

import { InMemoryConnectionStore } from './connection-store'
import { OAuthManager, type OAuthProviderConfig } from './oauth-manager'

const testConfig: OAuthProviderConfig = {
  authorizationUrl: 'https://provider.example.com/oauth/authorize',
  tokenUrl: 'https://provider.example.com/oauth/token',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
}

describe('InMemoryConnectionStore', () => {
  it('inserts and reads back rows by eq filter', async () => {
    const store = new InMemoryConnectionStore()
    await store.insert('t', { id: 'a', user_id: 'u1' })
    await store.insert('t', { id: 'b', user_id: 'u2' })
    const rows = await store.get('t', 'user_id=eq.u2')
    expect(rows).toEqual([{ id: 'b', user_id: 'u2' }])
  })

  it('patches matching rows and reports ok=false when nothing matches', async () => {
    const store = new InMemoryConnectionStore()
    await store.insert('t', { id: 'a', status: 'active' })
    expect((await store.patch('t', 'id=eq.a', { status: 'revoked' })).ok).toBe(true)
    expect((await store.patch('t', 'id=eq.zzz', { status: 'revoked' })).ok).toBe(false)
    const rows = await store.get('t', 'id=eq.a')
    expect(rows?.[0]?.status).toBe('revoked')
  })

  it('applies order and limit', async () => {
    const store = new InMemoryConnectionStore()
    await store.insert('t', { id: 'a', created_at: '2026-01-01' })
    await store.insert('t', { id: 'b', created_at: '2026-03-01' })
    await store.insert('t', { id: 'c', created_at: '2026-02-01' })
    const rows = await store.get('t', 'order=created_at.desc&limit=2')
    expect(rows?.map((r) => r.id)).toEqual(['b', 'c'])
  })

  it('backs the full OAuthManager persistence lifecycle', async () => {
    const store = new InMemoryConnectionStore()
    const manager = new OAuthManager('slack', testConfig, { connectionStore: store })

    const conn = await manager.saveConnection('user-1', {
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      scope: 'read',
    })

    expect(await manager.getConnection(conn.id)).toMatchObject({ id: conn.id, status: 'active' })
    expect(await manager.listConnections('user-1')).toHaveLength(1)

    expect(await manager.updateConnection(conn.id, { access_token: 'new-at' })).toBe(true)
    expect((await manager.getConnection(conn.id))?.access_token).toBe('new-at')

    expect(await manager.revokeConnection(conn.id)).toBe(true)
    expect(await manager.listConnections('user-1')).toHaveLength(0)
  })
})
