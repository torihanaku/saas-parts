/**
 * AuthContext: Centralized authentication state management.
 *
 * Ported from dev-dashboard-v2 `src/contexts/AuthContext.ts`.
 * Product coupling removed: the hardcoded `UserProfile` shape (plan/limits/
 * usage/config specific to the product) is replaced by a generic `TUser`
 * type parameter via a `createAuthContext<TUser>()` factory. The Supabase-
 * coupled `AuthProvider.tsx` was NOT ported — implement your own provider
 * against any auth backend and feed this context.
 */
import { createContext, useContext, type Context } from 'react';

// --- Types ---

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue<TUser> {
  status: AuthStatus;
  user: TUser | null;
  error: string | null;
  /** Re-fetch user profile from backend */
  refresh: () => Promise<void>;
  /** Sign out and redirect to login */
  logout: () => Promise<void>;
  /** Called after successful login to trigger user fetch */
  onLoginSuccess: () => Promise<void>;
}

export interface AuthContextBundle<TUser> {
  AuthContext: Context<AuthContextValue<TUser>>;
  useAuth: () => AuthContextValue<TUser>;
}

// --- Context factory ---

export function createAuthContext<TUser>(): AuthContextBundle<TUser> {
  const AuthContext = createContext<AuthContextValue<TUser>>({
    status: 'loading',
    user: null,
    error: null,
    refresh: async () => {},
    logout: async () => {},
    onLoginSuccess: async () => {},
  });

  function useAuth(): AuthContextValue<TUser> {
    return useContext(AuthContext);
  }

  return { AuthContext, useAuth };
}
