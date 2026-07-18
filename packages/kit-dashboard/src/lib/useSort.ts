import { useState, useMemo } from 'react'

export type SortDir = 'asc' | 'desc'

/**
 * テーブルソート状態を管理するフック。
 */
export function useSort<T extends Record<string, string | number>>(
  data: T[],
  defaultKey?: string,
  defaultDir: SortDir = 'asc',
) {
  const [sortKey, setSortKey] = useState<string | undefined>(defaultKey)
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir)

  const sorted = useMemo(() => {
    if (!sortKey) return data
    return [...data].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av === undefined || bv === undefined) return 0
      let cmp = 0
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv
      } else {
        cmp = String(av).localeCompare(String(bv))
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [data, sortKey, sortDir])

  const toggle = (key: string) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  return { sorted, sortKey, sortDir, toggle }
}
