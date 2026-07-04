import type { Rect } from './canvas-types'

export type AlignAxis =
  | 'left'
  | 'h-center'
  | 'right'
  | 'top'
  | 'v-center'
  | 'bottom'

export type DistributeAxis = 'horizontal' | 'vertical'

export type BoundsWithId = Rect & { id: string }

export type ShapeOffset = { x?: number; y?: number }

/**
 * Compute new positions to align the given shapes inside the provided target rect.
 * If `target` is omitted, use the collective bbox of `shapes` (multi-select align).
 * Returns a Map id → {x?, y?} of the new position deltas to apply.
 */
export function alignShapes(
  shapes: BoundsWithId[],
  axis: AlignAxis,
  target?: Rect
): Map<string, ShapeOffset> {
  const result = new Map<string, ShapeOffset>()
  if (shapes.length === 0) return result

  const t = target ?? collectiveBounds(shapes)

  for (const s of shapes) {
    switch (axis) {
      case 'left':
        if (s.x !== t.x) result.set(s.id, { x: t.x })
        break
      case 'h-center': {
        const newX = t.x + t.width / 2 - s.width / 2
        if (s.x !== newX) result.set(s.id, { x: newX })
        break
      }
      case 'right': {
        const newX = t.x + t.width - s.width
        if (s.x !== newX) result.set(s.id, { x: newX })
        break
      }
      case 'top':
        if (s.y !== t.y) result.set(s.id, { y: t.y })
        break
      case 'v-center': {
        const newY = t.y + t.height / 2 - s.height / 2
        if (s.y !== newY) result.set(s.id, { y: newY })
        break
      }
      case 'bottom': {
        const newY = t.y + t.height - s.height
        if (s.y !== newY) result.set(s.id, { y: newY })
        break
      }
    }
  }
  return result
}

/**
 * Distribute ≥3 shapes evenly along the given axis. First and last shapes stay
 * put; middle shapes are positioned so the gap-spacing between every adjacent
 * pair (by leading edge) is equal.
 */
export function distributeShapes(
  shapes: BoundsWithId[],
  axis: DistributeAxis
): Map<string, ShapeOffset> {
  const result = new Map<string, ShapeOffset>()
  if (shapes.length < 3) return result

  const sorted = [...shapes].sort((a, b) => (axis === 'horizontal' ? a.x - b.x : a.y - b.y))
  // shapes.length ≥ 3 已由上方守卫,故首尾必定存在
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!

  // Distribute by leading-edge spacing (Figma/Penpot do "by-space" for distribute-equally).
  // For wireframe usage, distributing by leading edges is more predictable.
  if (axis === 'horizontal') {
    const totalSpan = last.x - first.x
    const step = totalSpan / (sorted.length - 1)
    for (let i = 1; i < sorted.length - 1; i++) {
      const cur = sorted[i]!
      const target = first.x + step * i
      if (cur.x !== target) result.set(cur.id, { x: target })
    }
  } else {
    const totalSpan = last.y - first.y
    const step = totalSpan / (sorted.length - 1)
    for (let i = 1; i < sorted.length - 1; i++) {
      const cur = sorted[i]!
      const target = first.y + step * i
      if (cur.y !== target) result.set(cur.id, { y: target })
    }
  }

  return result
}

export function collectiveBounds(shapes: BoundsWithId[]): Rect {
  if (shapes.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  // 长度已 > 0,首元素必定存在
  const head = shapes[0]!
  let minX = head.x
  let minY = head.y
  let maxX = head.x + head.width
  let maxY = head.y + head.height
  for (let i = 1; i < shapes.length; i++) {
    const s = shapes[i]!
    if (s.x < minX) minX = s.x
    if (s.y < minY) minY = s.y
    if (s.x + s.width > maxX) maxX = s.x + s.width
    if (s.y + s.height > maxY) maxY = s.y + s.height
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
