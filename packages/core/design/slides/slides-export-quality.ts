export type SceneExportQuality = 'high' | 'mixed' | 'raster-heavy'

export type SceneExportNativeKinds = {
  text: number
  image: number
  table: number
  shape: number
  chart: number
}

export type SceneExportReport = {
  nativeCount: number
  rasterCount: number
  rasterAreaRatio: number
  rasterReasons: string[]
  warnings: string[]
  quality: SceneExportQuality
  nativeKinds: SceneExportNativeKinds
}

export type DeckExportReport = SceneExportReport & {
  slideCount: number
  qualityCounts: Record<SceneExportQuality, number>
}

type SceneLikeNode = {
  kind: string
  x: number
  y: number
  w: number
  h: number
  reason?: string
}

type SceneLike = {
  width: number
  height: number
  warnings?: readonly string[]
  nodes: readonly SceneLikeNode[]
}

type ClippedRect = {
  left: number
  top: number
  right: number
  bottom: number
}

const HIGH_RASTER_RATIO_MAX = 0.15
const MIXED_RASTER_RATIO_MAX = 0.5
const FULL_PAGE_EPSILON = 0.000001

function createNativeKinds(): SceneExportNativeKinds {
  return { text: 0, image: 0, table: 0, shape: 0, chart: 0 }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function sanitizeDiagnosticCode(value: string | undefined): string {
  const match = value?.trim().toLowerCase().match(/^[a-z0-9]+(?:-[a-z0-9]+)*/)
  return match?.[0] ?? 'unknown'
}

function uniqueOrdered(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function clipRect(node: Pick<SceneLikeNode, 'x' | 'y' | 'w' | 'h'>, width: number, height: number): ClippedRect | null {
  const left = clamp(node.x, 0, width)
  const top = clamp(node.y, 0, height)
  const right = clamp(node.x + node.w, 0, width)
  const bottom = clamp(node.y + node.h, 0, height)
  if (right - left <= 0 || bottom - top <= 0) return null
  return { left, top, right, bottom }
}

function unionYLength(intervals: Array<{ start: number; end: number }>): number {
  if (intervals.length === 0) return 0
  intervals.sort((a, b) => a.start - b.start || a.end - b.end)
  let total = 0
  let currentStart = intervals[0]!.start
  let currentEnd = intervals[0]!.end
  for (let index = 1; index < intervals.length; index += 1) {
    const interval = intervals[index]!
    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end)
      continue
    }
    total += currentEnd - currentStart
    currentStart = interval.start
    currentEnd = interval.end
  }
  total += currentEnd - currentStart
  return total
}

function rasterUnionArea(rects: readonly ClippedRect[]): number {
  if (rects.length === 0) return 0
  const xs = uniqueOrdered(
    rects
      .flatMap((rect) => [String(rect.left), String(rect.right)])
      .sort((a, b) => Number(a) - Number(b))
  ).map((value) => Number(value))

  let area = 0
  for (let index = 0; index < xs.length - 1; index += 1) {
    const left = xs[index]!
    const right = xs[index + 1]!
    if (right <= left) continue
    const intervals = rects
      .filter((rect) => rect.left < right && rect.right > left)
      .map((rect) => ({ start: rect.top, end: rect.bottom }))
    area += (right - left) * unionYLength(intervals)
  }
  return area
}

function hasBlockingWarning(warnings: readonly string[]): boolean {
  return warnings.includes('blocking')
}

function classifyQuality(options: {
  rasterAreaRatio: number
  fullPageRaster: boolean
  warnings: readonly string[]
}): SceneExportQuality {
  if (options.fullPageRaster || hasBlockingWarning(options.warnings)) return 'raster-heavy'
  if (options.rasterAreaRatio < HIGH_RASTER_RATIO_MAX) return 'high'
  if (options.rasterAreaRatio <= MIXED_RASTER_RATIO_MAX) return 'mixed'
  return 'raster-heavy'
}

export function buildSceneExportReport(scene: SceneLike): SceneExportReport {
  const nativeKinds = createNativeKinds()
  const rasterNodes = scene.nodes.filter((node) => node.kind === 'raster')
  const rasterRects = rasterNodes
    .map((node) => clipRect(node, scene.width, scene.height))
    .filter((rect): rect is ClippedRect => rect !== null)

  for (const node of scene.nodes) {
    if (node.kind === 'raster') continue
    if (node.kind === 'text') nativeKinds.text += 1
    else if (node.kind === 'image') nativeKinds.image += 1
    else if (node.kind === 'table') nativeKinds.table += 1
    else if (node.kind === 'shape') nativeKinds.shape += 1
    else if (node.kind === 'chart') nativeKinds.chart += 1
  }

  const slideArea = Math.max(scene.width * scene.height, 1)
  const rasterAreaRatio = clamp(rasterUnionArea(rasterRects) / slideArea, 0, 1)
  const warnings = (scene.warnings ?? []).map((warning) => sanitizeDiagnosticCode(warning))
  const fullPageRaster = rasterRects.some(
    (rect) => Math.abs((rect.right - rect.left) * (rect.bottom - rect.top) - slideArea) <= FULL_PAGE_EPSILON
  )

  return {
    nativeCount: scene.nodes.length - rasterNodes.length,
    rasterCount: rasterNodes.length,
    rasterAreaRatio,
    rasterReasons: rasterNodes.map((node) => sanitizeDiagnosticCode(node.reason)),
    warnings: uniqueOrdered(warnings),
    quality: classifyQuality({ rasterAreaRatio, fullPageRaster, warnings }),
    nativeKinds
  }
}

export function buildDeckExportReport(reports: readonly SceneExportReport[]): DeckExportReport {
  const nativeKinds = createNativeKinds()
  const qualityCounts: Record<SceneExportQuality, number> = {
    high: 0,
    mixed: 0,
    'raster-heavy': 0
  }

  for (const report of reports) {
    nativeKinds.text += report.nativeKinds.text
    nativeKinds.image += report.nativeKinds.image
    nativeKinds.table += report.nativeKinds.table
    nativeKinds.shape += report.nativeKinds.shape
    nativeKinds.chart += report.nativeKinds.chart
    qualityCounts[report.quality] += 1
  }

  const rasterAreaRatio =
    reports.length > 0 ? clamp(reports.reduce((sum, report) => sum + report.rasterAreaRatio, 0) / reports.length, 0, 1) : 0
  const warnings = uniqueOrdered(reports.flatMap((report) => report.warnings))
  const rasterReasons = uniqueOrdered(reports.flatMap((report) => report.rasterReasons))
  const quality =
    qualityCounts['raster-heavy'] > 0
      ? 'raster-heavy'
      : classifyQuality({
          rasterAreaRatio,
          fullPageRaster: false,
          warnings
        })

  return {
    slideCount: reports.length,
    nativeCount: reports.reduce((sum, report) => sum + report.nativeCount, 0),
    rasterCount: reports.reduce((sum, report) => sum + report.rasterCount, 0),
    rasterAreaRatio,
    rasterReasons,
    warnings,
    quality,
    nativeKinds,
    qualityCounts
  }
}
