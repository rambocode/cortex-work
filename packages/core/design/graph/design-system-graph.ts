import type { CanvasDocument, CanvasShape } from '../canvas/canvas-types'
import type { ComponentDef, DesignSystem, DesignToken } from '../canvas/design-system-types'
import type {
  DesignGraphDesignSystem,
  DesignGraphObject,
  DesignGraphTokenUsage
} from './design-graph-types'

const MAX_USAGE_PER_ENTRY = 24

function slug(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned.slice(0, 96) || 'unnamed'
}

export function tokenGraphObjectId(tokenName: string): string {
  return `token_${slug(tokenName)}`
}

export function componentGraphObjectId(componentId: string): string {
  return `component_${slug(componentId)}`
}

function shapes(document?: CanvasDocument): CanvasShape[] {
  return Object.values(document?.objects ?? {}).filter((shape): shape is CanvasShape => Boolean(shape))
}

function tokenUsage(document?: CanvasDocument): Map<string, DesignGraphTokenUsage[]> {
  const map = new Map<string, DesignGraphTokenUsage[]>()
  for (const shape of shapes(document)) {
    for (const [prop, tokenName] of Object.entries(shape.tokenBindings ?? {})) {
      if (!tokenName) continue
      const list = map.get(tokenName) ?? []
      list.push({ objectId: shape.id, prop })
      map.set(tokenName, list)
    }
  }
  return map
}

function componentUsage(document?: CanvasDocument): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const shape of shapes(document)) {
    if (!shape.componentId) continue
    const list = map.get(shape.componentId) ?? []
    list.push(shape.id)
    map.set(shape.componentId, list)
  }
  return map
}

function tokenValue(token: DesignToken): unknown {
  return token.value
}

function tokenSummary(token: DesignToken, usage: DesignGraphTokenUsage[]) {
  return {
    name: token.name,
    kind: token.kind,
    usageCount: usage.length,
    usedBy: usage.slice(0, MAX_USAGE_PER_ENTRY)
  }
}

function componentSummary(component: ComponentDef, instanceIds: string[]) {
  return {
    id: component.id,
    name: component.name,
    version: component.version,
    // slots/tree 同样兜底:脏数据不该让摘要抛错(权威校验在 parseDesignSystem)。
    slotCount: component.slots?.length ?? 0,
    rootShapeCount: component.tree?.length ?? 0,
    usageCount: instanceIds.length,
    instanceIds: instanceIds.slice(0, MAX_USAGE_PER_ENTRY)
  }
}

export function summarizeDesignSystemForGraph(
  system: DesignSystem | undefined,
  document?: CanvasDocument
): DesignGraphDesignSystem | undefined {
  if (!system) return undefined
  const tokenUsageByName = tokenUsage(document)
  const componentUsageById = componentUsage(document)
  // 排序键一律兜底成空串:本函数在 CanvasToolbar 渲染期同步跑,磁盘上混进一条缺 name 的
  // 记录就会让 `name.localeCompare` 抛错、炸掉整棵 React 树(打开设计稿白屏,用户实测)。
  // 权威校验在 parseDesignSystem,这里是纵深防御——渲染路径不该因数据脏就整屏挂掉。
  const tokens = Object.values(system.tokens ?? {})
    .filter((token): token is DesignToken => Boolean(token))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    .map((token) => tokenSummary(token, tokenUsageByName.get(token.name) ?? []))
  const components = Object.values(system.components ?? {})
    .filter((component): component is ComponentDef => Boolean(component))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || (a.id ?? '').localeCompare(b.id ?? ''))
    .map((component) => componentSummary(component, componentUsageById.get(component.id) ?? []))
  return {
    tokenCount: tokens.length,
    componentCount: components.length,
    tokenUsageCount: tokens.reduce((sum, token) => sum + token.usageCount, 0),
    componentInstanceCount: components.reduce((sum, component) => sum + component.usageCount, 0),
    tokens,
    components
  }
}

function tokenGraphObject(token: DesignToken, usage: DesignGraphTokenUsage[]): DesignGraphObject {
  return {
    id: tokenGraphObjectId(token.name),
    kind: 'token',
    name: token.name,
    parentId: null,
    children: [],
    source: { tokenName: token.name },
    metadata: {
      kind: token.kind,
      value: tokenValue(token),
      usageCount: usage.length,
      usedBy: usage.slice(0, MAX_USAGE_PER_ENTRY)
    }
  }
}

function componentGraphObject(component: ComponentDef, instanceIds: string[]): DesignGraphObject {
  return {
    id: componentGraphObjectId(component.id),
    kind: 'component',
    name: component.name,
    parentId: null,
    children: [],
    source: { componentId: component.id },
    metadata: {
      version: component.version,
      slots: component.slots ?? [],
      rootShapeCount: component.tree?.length ?? 0,
      usageCount: instanceIds.length,
      instanceIds: instanceIds.slice(0, MAX_USAGE_PER_ENTRY)
    }
  }
}

export function designSystemToGraphObjects(
  system: DesignSystem | undefined,
  document?: CanvasDocument
): Record<string, DesignGraphObject> {
  if (!system) return {}
  const tokenUsageByName = tokenUsage(document)
  const componentUsageById = componentUsage(document)
  const objects: Record<string, DesignGraphObject> = {}
  // 与 summarizeDesignSystemForGraph 同一条纵深防御:缺 name/id 的脏记录跳过而非让 slug() 抛。
  for (const token of Object.values(system.tokens ?? {})) {
    if (!token?.name) continue
    const object = tokenGraphObject(token, tokenUsageByName.get(token.name) ?? [])
    objects[object.id] = object
  }
  for (const component of Object.values(system.components ?? {})) {
    if (!component?.id) continue
    const object = componentGraphObject(component, componentUsageById.get(component.id) ?? [])
    objects[object.id] = object
  }
  return objects
}
