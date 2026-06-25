/**
 * 自定义模块（custom module）注册表与字段强制类型转换工具（U11）。
 *
 * 自定义模块是「custom 节点」的底层：一段 JS/Python/Bash 脚本 + 一组命名字段（fields），
 * 字段在画布上生成表单，用户填值后以 $fields 注入脚本运行。
 *
 * 持久化存储由 U15 ModuleManager 完善（modules.json 原子写）。
 * 本文件提供运行时 getModule / coerceModuleFields，以及一个内存注册表接口。
 * U11 code 节点测试无需真实持久化，直接调用 registerModule 注入 mock 模块即可。
 *
 * TODO（U15）：改为从 modules.json 加载，与 store.ts 同范式；
 *              ModuleManager IPC handler 调用 registerModule / unregisterModule 更新内存注册表。
 */

import type { WorkflowCodeLanguage } from '../types.js'

// ── 类型定义 ──────────────────────────────────────────────────────────────────

/** 模块字段声明（与 Kun WorkflowModuleFieldV1 保持语义对齐）。 */
export interface WorkflowModuleField {
  key: string
  label: string
  /** 字段类型，决定 coerceModuleFields 的强制转换规则。 */
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select'
  defaultValue: string
  options: string[]
  placeholder: string
}

/** 自定义模块定义（与 Kun WorkflowCustomModuleV1 保持语义对齐）。 */
export interface WorkflowCustomModule {
  id: string
  name: string
  description: string
  icon: string
  language: WorkflowCodeLanguage
  fields: WorkflowModuleField[]
  code: string
}

// ── 内存注册表 ────────────────────────────────────────────────────────────────

/**
 * 运行时模块注册表（内存）。
 * 用于 U11 测试注入 mock 模块，以及后续 U15 从 modules.json 加载后的缓存层。
 *
 * 注意：此 Map 在主进程生命周期内持久，进程重启后清空。
 * U15 ModuleManager 完善时，进程启动时从磁盘 modules.json 初始化此 Map。
 */
const moduleRegistry = new Map<string, WorkflowCustomModule>()

/**
 * 向注册表注册（或覆盖）一个模块。
 * 供 U15 ModuleManager（模块创建/更新 IPC handler）和测试用。
 */
export function registerModule(module: WorkflowCustomModule): void {
  moduleRegistry.set(module.id, module)
}

/**
 * 从注册表移除模块。
 * 供 U15 ModuleManager（模块删除 IPC handler）用。
 */
export function unregisterModule(moduleId: string): void {
  moduleRegistry.delete(moduleId)
}

/**
 * 按 ID 查找模块；未找到返回 undefined。
 *
 * TODO（U15 ModuleManager 完善）：
 *   本函数目前仅查内存注册表（进程重启后为空）。
 *   U15 完善持久化后，模块会在进程启动时从 modules.json 预加载到 moduleRegistry，
 *   本函数查找逻辑无需改变，只需确保 U15 的加载代码在 executeCustom 首次调用前执行。
 */
export function getModule(moduleId: string): WorkflowCustomModule | undefined {
  return moduleRegistry.get(moduleId)
}

/**
 * 返回当前注册表中的全部模块（数组快照）。
 * 供 U15 ModuleManager UI 列表查询。
 */
export function listModules(): WorkflowCustomModule[] {
  return Array.from(moduleRegistry.values())
}

// ── 字段强制类型转换 ──────────────────────────────────────────────────────────

/**
 * 把 custom 节点的 string 字段值按模块字段声明类型强制转换，
 * 返回注入脚本的 $fields 对象（对齐 Kun coerceModuleFields）。
 *
 * 转换规则：
 *   number  → Number(raw)；空字符串或非数字 → 0
 *   boolean → raw === 'true' || raw === '1'
 *   text/textarea/select → 原字符串（或 defaultValue 兜底）
 */
export function coerceModuleFields(
  module: WorkflowCustomModule,
  values: Record<string, string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const field of module.fields) {
    const raw = values[field.key] ?? field.defaultValue ?? ''

    if (field.type === 'number') {
      out[field.key] = raw === '' ? 0 : Number(raw) || 0
    } else if (field.type === 'boolean') {
      out[field.key] = raw === 'true' || raw === '1'
    } else {
      // text / textarea / select
      out[field.key] = raw
    }
  }

  return out
}
