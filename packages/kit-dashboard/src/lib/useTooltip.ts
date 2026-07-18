import { useCallback, useRef } from "react";

export interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  content: string;
}

/**
 * D3 チャート上のツールチップを **命令的(ref直書き)** で管理するフック。
 *
 * 重要: React state を使わない。show/hide はホバーのたびに setState して
 * コンポーネントを再レンダーさせる…という旧実装が flicker の根因だった
 * （再レンダー→useD3 の deps 再評価→renderFn 再実行→SVG全消し＋入場アニメ再生）。
 * ここでは tooltipRef の DOM を直接更新するだけなので **ホバーで再レンダーが起きない**。
 *
 * 使い方:
 *   const { show, hide, containerRef, tooltipRef } = useTooltip();
 *   ...selection.on("mouseenter", (e) => show(e, text)).on("mouseleave", hide);
 *   return <div ref={containerRef} className="relative">...<ChartTooltip ref={tooltipRef} /></div>
 */
export function useTooltip() {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const show = useCallback((event: MouseEvent, content: string) => {
    const el = tooltipRef.current;
    if (!el) return;
    el.textContent = content;
    el.style.left = `${event.offsetX}px`;
    el.style.top = `${event.offsetY}px`;
    el.style.opacity = "1";
  }, []);

  const hide = useCallback(() => {
    const el = tooltipRef.current;
    if (el) el.style.opacity = "0";
  }, []);

  return { show, hide, containerRef, tooltipRef };
}
