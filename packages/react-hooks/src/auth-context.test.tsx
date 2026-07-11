// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createAuthContext, type AuthContextValue } from './auth-context';

interface TestUser { email: string; role: string }

afterEach(cleanup);

describe('createAuthContext', () => {
  it('returns the loading default outside a provider', () => {
    const { useAuth } = createAuthContext<TestUser>();
    const { result } = renderHook(() => useAuth());

    expect(result.current.status).toBe('loading');
    expect(result.current.user).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('default async callbacks are safe no-ops', async () => {
    const { useAuth } = createAuthContext<TestUser>();
    const { result } = renderHook(() => useAuth());

    await expect(result.current.refresh()).resolves.toBeUndefined();
    await expect(result.current.logout()).resolves.toBeUndefined();
    await expect(result.current.onLoginSuccess()).resolves.toBeUndefined();
  });

  it('exposes the provided value through useAuth with a typed user', async () => {
    const { AuthContext, useAuth } = createAuthContext<TestUser>();
    const logout = vi.fn(async () => {});
    const value: AuthContextValue<TestUser> = {
      status: 'authenticated',
      user: { email: 'a@example.com', role: 'admin' },
      error: null,
      refresh: async () => {},
      logout,
      onLoginSuccess: async () => {},
    };

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });

    expect(result.current.status).toBe('authenticated');
    expect(result.current.user?.email).toBe('a@example.com');
    await result.current.logout();
    expect(logout).toHaveBeenCalled();
  });
});
