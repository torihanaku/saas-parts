import { useState, useCallback, useRef } from 'react'

export interface TooltipState {
  visible: boolean
  x: number
  y: number
  content: string
}

/**
 * D3 チャート上のツールチップ表示状態を管理するフック。
 */
export function useTooltip() {
  const [state, setState] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    content: '',
  })
  const containerRef = useRef<HTMLDivElement>(null)

  const show = useCallback((event: MouseEvent, content: string) => {
    setState({ visible: true, x: event.offsetX, y: event.offsetY, content })
  }, [])

  const hide = useCallback(() => {
    setState((s) => ({ ...s, visible: false }))
  }, [])

  return { state, show, hide, containerRef }
}
