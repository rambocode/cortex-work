// NodeConfigPanel.tsx — 节点配置面板容器。
// 职责：
//   1. 据 node.type 分发到对应的 XxxNodeForm 子组件。
//   2. 顶部通用字段：name / disabled / onError / retries。
//   3. 无选中节点 → 提示「选择一个节点进行编辑」。
//   4. 传入 onNodeChange 把更新后的节点回传给 WorkflowEditorView。
//
// 节点 kind → form 分发表：
//   trigger group    → TriggerNodeForm (manual-trigger / schedule-trigger / webhook-trigger)
//   ai group         → AiNodeForm (ai-agent / parameter-extractor / question-classifier)
//   flow group       → FlowNodeForm (condition / switch / filter / merge / loop / subworkflow / delay)
//   data group       → DataNodeForm (set-fields / sort / limit / aggregate / template / json / output)
//   code group       → CodeNodeForm (code / custom)
//   http group       → HttpNodeForm (http-request)
//   approval group   → ApprovalNodeForm (human-approval / generate-image)
//
// ⚠️ views 包不引入 next/* 或 react-router-dom。

import { useState } from "react";
import type { WorkflowNode, WorkflowNodeErrorMode, WorkflowDef, WorkflowEnvVar } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { TriggerNodeForm } from "./TriggerNodeForm";
import { AiNodeForm } from "./AiNodeForm";
import { FlowNodeForm } from "./FlowNodeForm";
import { DataNodeForm } from "./DataNodeForm";
import { CodeNodeForm } from "./CodeNodeForm";
import { HttpNodeForm } from "./HttpNodeForm";
import { ApprovalNodeForm } from "./ApprovalNodeForm";
import { VariablePicker } from "./VariablePicker";
import { INPUT_CLS, FIELD_LABEL_CLS } from "./TriggerNodeForm";

// ── 节点 kind 分组 ────────────────────────────────────────────────────────────

const TRIGGER_KINDS = new Set([
  "manual-trigger",
  "schedule-trigger",
  "webhook-trigger",
] as const);

const AI_KINDS = new Set([
  "ai-agent",
  "parameter-extractor",
  "question-classifier",
] as const);

const FLOW_KINDS = new Set([
  "condition",
  "switch",
  "filter",
  "merge",
  "loop",
  "subworkflow",
  "delay",
] as const);

const DATA_KINDS = new Set([
  "set-fields",
  "sort",
  "limit",
  "aggregate",
  "template",
  "json",
  "output",
] as const);

const CODE_KINDS = new Set(["code", "custom"] as const);

const HTTP_KINDS = new Set(["http-request"] as const);

const APPROVAL_KINDS = new Set(["human-approval", "generate-image"] as const);

// ── kind → 中文名 ──────────────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  "manual-trigger": "手动触发",
  "schedule-trigger": "定时触发",
  "webhook-trigger": "Webhook",
  "ai-agent": "AI 智能体",
  "generate-image": "生成图片",
  condition: "条件",
  switch: "分支",
  filter: "过滤",
  "set-fields": "设置字段",
  code: "代码",
  sort: "排序",
  limit: "限制",
  aggregate: "聚合",
  "http-request": "HTTP 请求",
  merge: "合并",
  subworkflow: "子工作流",
  loop: "循环",
  delay: "延迟",
  template: "模板",
  json: "JSON",
  output: "输出",
  "parameter-extractor": "参数提取",
  "question-classifier": "问题分类",
  "human-approval": "人工审批",
  custom: "自定义",
};

const ERROR_MODE_OPTIONS: Array<{ value: WorkflowNodeErrorMode; label: string }> = [
  { value: "fail", label: "停止（fail）" },
  { value: "continue", label: "忽略继续（continue）" },
  { value: "fallback", label: "兜底值（fallback）" },
];

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  /** 当前选中节点；null = 无选中 → 渲染提示。 */
  node: WorkflowNode | null;
  /** 所有节点（VariablePicker 推导上游变量用）*/
  allNodes: WorkflowNode[];
  /** 工作流环境变量（VariablePicker 渲染 $env 变量用）*/
  envVars: WorkflowEnvVar[];
  /** 工作流 id（webhook 预览 URL 用）*/
  workflowId?: string;
  /** 全量工作流列表（loop/subworkflow workflowId 选择器用）*/
  workflows?: WorkflowDef[];
  /** 字段变更回调：更新后的节点 → 上层收集回 WorkflowEditorView。 */
  onNodeChange: (updated: WorkflowNode) => void;
};

// ── NodeConfigPanel ───────────────────────────────────────────────────────────

export function NodeConfigPanel({
  node,
  allNodes,
  envVars,
  workflowId,
  workflows,
  onNodeChange,
}: Props) {
  // 通用字段展开/折叠（errorMode/retries 折叠在「高级」区域，默认折叠）
  const [advancedOpen, setAdvancedOpen] = useState(false);

  if (!node) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <Icon.MousePointer size={32} sw={1.4} className="text-ds-faint/40" />
        <p className="text-[12.5px] text-ds-faint">选择一个节点进行编辑</p>
      </div>
    );
  }

  // ── 通用字段更新工具 ─────────────────────────────────────────────────────
  function patchNode(patch: Partial<WorkflowNode>) {
    // 使用类型断言保持类型安全（patch 只触碰顶层通用字段，不改 config/type）
    onNodeChange({ ...node, ...patch } as WorkflowNode);
  }

  // ── VariablePicker 插入回调 ──────────────────────────────────────────────
  // 这里只提供 VariablePicker 按钮；实际插入到哪个字段由用户在聚焦后点击决定。
  // 简化实现：复制到剪贴板并提示（与 Kun 差异：Kun 做光标位置插入，我们做最简方案）。
  function handleVarInsert(expr: string) {
    navigator.clipboard?.writeText(expr).catch(() => {});
    // 也可通过 document.execCommand（已废弃）或 focus 跟踪；此处采用剪贴板方案
  }

  // ── 渲染对应 form ─────────────────────────────────────────────────────────
  // 注意：node 在此已通过 if(!node) return 排除 null，
  // 但 TypeScript 不穿透嵌套函数的 narrowing，所以用局部变量显式重新绑定。
  function renderForm(n: WorkflowNode) {
    const kind = n.type;

    if (TRIGGER_KINDS.has(kind as "manual-trigger" | "schedule-trigger" | "webhook-trigger")) {
      return (
        <TriggerNodeForm
          node={n as WorkflowNode & { type: "manual-trigger" | "schedule-trigger" | "webhook-trigger" }}
          onChange={onNodeChange}
          workflowId={workflowId}
        />
      );
    }
    if (AI_KINDS.has(kind as "ai-agent" | "parameter-extractor" | "question-classifier")) {
      return (
        <AiNodeForm
          node={n as WorkflowNode & { type: "ai-agent" | "parameter-extractor" | "question-classifier" }}
          onChange={onNodeChange}
        />
      );
    }
    if (
      FLOW_KINDS.has(
        kind as "condition" | "switch" | "filter" | "merge" | "loop" | "subworkflow" | "delay",
      )
    ) {
      return (
        <FlowNodeForm
          node={
            n as WorkflowNode & {
              type: "condition" | "switch" | "filter" | "merge" | "loop" | "subworkflow" | "delay";
            }
          }
          onChange={onNodeChange}
          workflows={workflows}
        />
      );
    }
    if (
      DATA_KINDS.has(
        kind as "set-fields" | "sort" | "limit" | "aggregate" | "template" | "json" | "output",
      )
    ) {
      return (
        <DataNodeForm
          node={
            n as WorkflowNode & {
              type: "set-fields" | "sort" | "limit" | "aggregate" | "template" | "json" | "output";
            }
          }
          onChange={onNodeChange}
        />
      );
    }
    if (CODE_KINDS.has(kind as "code" | "custom")) {
      return (
        <CodeNodeForm
          node={n as WorkflowNode & { type: "code" | "custom" }}
          onChange={onNodeChange}
        />
      );
    }
    if (HTTP_KINDS.has(kind as "http-request")) {
      return (
        <HttpNodeForm
          node={n as WorkflowNode & { type: "http-request" }}
          onChange={onNodeChange}
        />
      );
    }
    if (APPROVAL_KINDS.has(kind as "human-approval" | "generate-image")) {
      return (
        <ApprovalNodeForm
          node={n as WorkflowNode & { type: "human-approval" | "generate-image" }}
          onChange={onNodeChange}
        />
      );
    }
    return (
      <p className="text-[12px] text-ds-faint">
        节点类型 <code className="text-accent">{kind}</code> 暂未实现配置面板。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── 节点头部 ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-[13px] font-semibold text-ds-ink">
            {KIND_LABELS[node.type] ?? node.type}
          </span>
          <span className="rounded-full bg-ds-border/60 px-2 py-0.5 text-[10px] font-mono text-ds-faint">
            {node.id.slice(0, 8)}
          </span>
        </div>
        {/* VariablePicker（点击「插入变量」→ 复制到剪贴板）*/}
        <VariablePicker
          currentNodeId={node.id}
          allNodes={allNodes}
          envVars={envVars}
          onInsert={handleVarInsert}
        />
      </div>

      {/* ── 节点名称 ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>节点名称</label>
        <input
          className={INPUT_CLS}
          value={node.name}
          placeholder={KIND_LABELS[node.type] ?? node.type}
          onChange={(e) => patchNode({ name: e.target.value })}
        />
      </div>

      {/* ── 分隔线 ───────────────────────────────────────────────────────── */}
      <div className="h-px bg-ds-border" />

      {/* ── 节点特定配置 ─────────────────────────────────────────────────── */}
      {renderForm(node)}

      {/* ── 高级：错误处理 / 禁用 ────────────────────────────────────────── */}
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-ds-faint transition hover:text-ds-muted"
        >
          <Icon.ChevronRight
            size={12}
            sw={2}
            className={`shrink-0 transition-transform ${advancedOpen ? "rotate-90" : ""}`}
          />
          高级设置
        </button>

        {advancedOpen ? (
          <div className="mt-2 flex flex-col gap-3 rounded-xl border border-ds-border bg-ds-card/60 p-3">
            {/* 禁用 */}
            <label className="flex items-center gap-2 text-[12px] text-ds-muted">
              <input
                type="checkbox"
                checked={node.disabled}
                onChange={(e) => patchNode({ disabled: e.target.checked })}
              />
              禁用此节点（运行时跳过）
            </label>

            {/* 失败策略 */}
            <div className="flex flex-col gap-1">
              <label className={FIELD_LABEL_CLS}>失败策略</label>
              <select
                className={INPUT_CLS}
                value={node.onError ?? "fail"}
                onChange={(e) =>
                  patchNode({ onError: e.target.value as WorkflowNodeErrorMode })
                }
              >
                {ERROR_MODE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 重试次数（fail 模式下生效）*/}
            <div className="flex flex-col gap-1">
              <label className={FIELD_LABEL_CLS}>重试次数（0 = 不重试）</label>
              <input
                type="number"
                className={INPUT_CLS}
                value={node.retries ?? 0}
                min={0}
                max={10}
                onChange={(e) => patchNode({ retries: Number(e.target.value) })}
              />
            </div>

            {/* 重试间隔 */}
            {(node.retries ?? 0) > 0 ? (
              <div className="flex flex-col gap-1">
                <label className={FIELD_LABEL_CLS}>重试间隔（ms）</label>
                <input
                  type="number"
                  className={INPUT_CLS}
                  value={node.retryDelayMs ?? 1000}
                  min={0}
                  max={60000}
                  step={500}
                  onChange={(e) => patchNode({ retryDelayMs: Number(e.target.value) })}
                />
              </div>
            ) : null}

            {/* fallbackJson（fallback 模式下显示）*/}
            {node.onError === "fallback" ? (
              <div className="flex flex-col gap-1">
                <label className={FIELD_LABEL_CLS}>兜底 JSON</label>
                <textarea
                  className={`${INPUT_CLS} min-h-[60px] resize-y font-mono text-[12px]`}
                  value={node.fallbackJson ?? ""}
                  placeholder='{"result": null}'
                  onChange={(e) => patchNode({ fallbackJson: e.target.value || undefined })}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
