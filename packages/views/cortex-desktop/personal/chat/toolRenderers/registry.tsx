// 工具步骤渲染注册表（pi-web-ui 的 registerToolRenderer 模式移植）:按 AgentLogItem.toolName
// 为特定工具挂自定义渲染组件,叠在现有 agentLog 步骤列表上,不推翻默认渲染。
//
// 渲染器是 React 组件(可用 hooks),经 `fallback` prop 拿到默认渲染节点——识别不了当前条目
// (如 store 里查不到对应产物)时渲染 fallback,保证永不产生空行。模块级 Map + 模块加载时
// 注册(builtins.ts),引用稳定,不破坏 AgentLogMessage 的 memo。

import type { AgentLogItem } from "@cortex-work/core";
import type React from "react";

export interface ToolStepRendererProps {
  item: AgentLogItem;
  /** 默认渲染节点:渲染器接不住时原样返回它。 */
  fallback: React.ReactNode;
}

export type ToolStepRenderer = React.ComponentType<ToolStepRendererProps>;

const registry = new Map<string, ToolStepRenderer>();

/** 注册工具渲染器（同名覆盖,后注册者赢——与 pi customTools 的覆盖语义一致）。 */
export function registerToolRenderer(toolName: string, renderer: ToolStepRenderer): void {
  registry.set(toolName, renderer);
}

/** 按原始工具名查渲染器;未注册返回 undefined（调用方走默认渲染）。 */
export function getToolRenderer(toolName: string): ToolStepRenderer | undefined {
  return registry.get(toolName);
}

/** 测试用:清空注册表。 */
export function __clearToolRenderersForTest(): void {
  registry.clear();
}
