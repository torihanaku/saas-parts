export interface ChartMargin {
  top: number
  right: number
  bottom: number
  left: number
}

export const DEFAULT_MARGIN: ChartMargin = { top: 20, right: 20, bottom: 40, left: 50 }

export function getInnerDimensions(
  width: number,
  height: number,
  margin: ChartMargin,
) {
  return {
    innerWidth: Math.max(0, width - margin.left - margin.right),
    innerHeight: Math.max(0, height - margin.top - margin.bottom),
  }
}
