import { useState, useEffect, type RefObject } from 'react'

export interface Dimensions {
  width: number
  height: number
}

/**
 * コンテナ要素のサイズ変更を監視してレスポンシブ対応を実現するフック。
 * チャートコンポーネントはこの hook から width を取得し、
 * useD3 の deps に含めることで自動リサイズする。
 */
export function useResizeObserver(ref: RefObject<HTMLElement | null>): Dimensions {
  const [dimensions, setDimensions] = useState<Dimensions>({ width: 0, height: 0 })

  useEffect(() => {
    if (!ref.current) return
    // Read initial size synchronously as fallback for cases where ResizeObserver
    // fires with 0 (e.g. element initially hidden) and never fires again.
    const initial = ref.current.getBoundingClientRect()
    if (initial.width > 0 || initial.height > 0) {
      setDimensions({ width: initial.width, height: initial.height })
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setDimensions({ width, height })
    })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [ref])

  return dimensions
}
