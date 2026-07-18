import { useRef, useEffect, type DependencyList } from 'react'
import * as d3 from 'd3'

/**
 * D3.js の SVG 操作をカプセル化する基本フック。
 * React がコンテナを管理し、D3 が SVG 内を直接操作する責務分離パターン。
 */
export function useD3<T extends SVGElement>(
  renderFn: (svg: d3.Selection<T, unknown, null, undefined>) => void,
  deps: DependencyList,
) {
  const ref = useRef<T>(null)

  useEffect(() => {
    if (!ref.current) return
    const svg = d3.select(ref.current) as d3.Selection<T, unknown, null, undefined>
    svg.selectAll('*').remove()
    renderFn(svg)
    return () => {
      if (ref.current) {
        d3.select(ref.current).selectAll('*').remove()
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return ref
}
