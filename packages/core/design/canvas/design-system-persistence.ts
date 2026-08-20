/**
 * Persistence for the doc-level design system (tokens + components). Lives at
 * `<docDir>/design-system.json` — one per DesignDocument, shared by all its
 * artifacts/screens — alongside each artifact's `canvas.json`. Mirrors
 * canvas-persistence (debounced save, lenient load).
 */
import { cortexGuiPort, requireCortexGui } from '../compat/cortex-gui-port'
import type { ComponentDef, DesignSystem, DesignToken, DesignTokenKind } from './design-system-types'
import type { CanvasFilePort } from './canvas-file-port'

const DESIGN_DIR = '.cortex-design'

// 与 code-canvas.ts 的 CODE_CANVAS_DIR 同值；此处用字面量避免与 canvas 模块成环。
const CODE_CANVAS_DIR = '.cortex-canvas'
const LEGACY_CODE_CANVAS_DIR = '.kun-canvas'

export function designSystemPath(baseDir: string = DESIGN_DIR): string {
  return `${baseDir}/design-system.json`
}

export function serializeDesignSystem(system: DesignSystem): string {
  return JSON.stringify(system, null, 2)
}

const TOKEN_KINDS = new Set<DesignTokenKind>(['color', 'gradient', 'type', 'space', 'radius', 'shadow'])

/**
 * 逐项校验 token。**宽松加载 ≠ 不校验**:design-system.json 是磁盘文件,agent 完全可能
 * 按它自己的分类法写(实测:`{ tokens: { colors: {...}, typography: {...} } }`)。
 * 旧实现整块 cast,下游 summarizeDesignSystemForGraph 对无 name 的条目 `name.localeCompare`
 * 直接抛错,炸掉整棵 React 树 → 打开设计稿白屏。
 *
 * name 缺失时用键名补(Record 的键本就是 token 名,只是漏写了字段);kind/value 不合法就丢。
 */
function coerceToken(key: string, value: unknown): DesignToken | null {
  if (!value || typeof value !== 'object') return null
  const token = value as { name?: unknown; kind?: unknown; value?: unknown }
  if (typeof token.kind !== 'string' || !TOKEN_KINDS.has(token.kind as DesignTokenKind)) return null
  if (token.value === undefined || token.value === null) return null
  const name = typeof token.name === 'string' && token.name ? token.name : key
  return { ...(token as object), name } as DesignToken
}

/** 同上,组件按 id/name/tree/slots 校验;id/version 可由键名与 v1 补齐。 */
function coerceComponent(key: string, value: unknown): ComponentDef | null {
  if (!value || typeof value !== 'object') return null
  const component = value as {
    id?: unknown
    name?: unknown
    version?: unknown
    tree?: unknown
    slots?: unknown
  }
  if (typeof component.name !== 'string' || !component.name) return null
  if (!Array.isArray(component.tree) || !Array.isArray(component.slots)) return null
  return {
    ...(component as object),
    id: typeof component.id === 'string' && component.id ? component.id : key,
    name: component.name,
    version: typeof component.version === 'number' ? component.version : 1
  } as ComponentDef
}

function coerceRecord<T>(
  source: unknown,
  coerce: (key: string, value: unknown) => T | null
): Record<string, T> {
  if (!source || typeof source !== 'object') return {}
  const out: Record<string, T> = {}
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const item = coerce(key, value)
    if (item) out[key] = item
  }
  return out
}

export function parseDesignSystem(raw: string): DesignSystem | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as { tokens?: unknown; components?: unknown }
    return {
      tokens: coerceRecord(obj.tokens, coerceToken),
      components: coerceRecord(obj.components, coerceComponent)
    }
  } catch {
    return null
  }
}

const _saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

function designSystemSaveKey(workspaceRoot: string, baseDir: string | undefined): string {
  return [workspaceRoot, baseDir ?? DESIGN_DIR].join('\0')
}

export function persistDesignSystem(
  workspaceRoot: string,
  system: DesignSystem,
  baseDir?: string,
  filePort?: CanvasFilePort
): void {
  if (!workspaceRoot) return
  if (!filePort && typeof cortexGuiPort()?.writeWorkspaceFile !== 'function') return
  const key = designSystemSaveKey(workspaceRoot, baseDir)
  const existingTimer = _saveTimers.get(key)
  if (existingTimer) clearTimeout(existingTimer)
  const timer = setTimeout(() => {
    _saveTimers.delete(key)
    const path = designSystemPath(baseDir)
    const content = serializeDesignSystem(system)
    if (filePort) {
      void filePort.writeText(workspaceRoot, path, content).catch(() => false)
      return
    }
    void cortexGuiPort()!.writeWorkspaceFile({ path, workspaceRoot, content }).catch(() => undefined)
  }, 600)
  _saveTimers.set(key, timer)
}

async function readDesignSystemAt(
  workspaceRoot: string,
  relativePath: string,
  filePort?: CanvasFilePort
): Promise<DesignSystem | null> {
  if (filePort) {
    const content = await filePort.readText(workspaceRoot, relativePath)
    return content == null ? null : parseDesignSystem(content)
  }
  if (typeof cortexGuiPort()?.readWorkspaceFile !== 'function') return null
  const result = await requireCortexGui().readWorkspaceFile({ path: relativePath, workspaceRoot })
  if (!result || !result.ok) return null
  return parseDesignSystem(result.content)
}

export async function loadDesignSystem(
  workspaceRoot: string,
  baseDir?: string,
  filePort?: CanvasFilePort
): Promise<DesignSystem | null> {
  if (!workspaceRoot) return null
  try {
    const system = await readDesignSystemAt(workspaceRoot, designSystemPath(baseDir), filePort)
    if (system) return system
    // 与 loadCanvasDocument 同因：代码画布目录改名后，老工作区的 design-system.json
    // 仍在 .cortex-canvas 下，新目录读空时回退一次旧目录（写侧始终用新目录）。
    if (!baseDir || !baseDir.startsWith(`${CODE_CANVAS_DIR}/`)) return null
    const legacyBaseDir = `${LEGACY_CODE_CANVAS_DIR}${baseDir.slice(CODE_CANVAS_DIR.length)}`
    return await readDesignSystemAt(workspaceRoot, designSystemPath(legacyBaseDir), filePort)
  } catch {
    return null
  }
}
