/**
 * Ported from 実運用SaaS `src/hooks/useFetch.ts` (unchanged).
 */
import { useState, useEffect, useCallback } from 'react'

interface UseFetchState<T> {
  data: T | null
  loading: boolean
  error: Error | null
  refetch: () => void
}

/**
 * Generic fetch hook with cancellation, loading, and error state.
 * Pass null as url to skip fetching (useful for conditional fetches).
 *
 * Usage:
 *   const { data, loading, error, refetch } = useFetch<User[]>('/api/users')
 */
export function useFetch<T>(url: string | null): UseFetchState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(url !== null)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!url) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    const load = async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json() as T
        if (!cancelled) {
          setData(json)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)))
          setLoading(false)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [url, tick])

  const refetch = useCallback(() => setTick(t => t + 1), [])

  return { data, loading, error, refetch }
}
