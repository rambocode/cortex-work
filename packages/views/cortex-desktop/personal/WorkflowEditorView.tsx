// WorkflowEditorView.tsx — 工作流画布编辑器壳。
// 对应 Kun WorkflowEditorView.tsx（精简版，守 1200 行）。
// U7 已落地：右侧面板接入真实 NodeConfigPanel + WorkflowRunLogPanel。
//
// 布局：
//   左侧 Sidebar（节点 palette，按分组折叠）
//   中间 WorkflowCanvas（@xyflow/react 画布）
//   右侧 右侧面板（配置 / 运行日志 tab）
//   顶部 header（返回 / 名称 / 已启用 / 环境变量 / 保存 / 运行一次）
//
// onNodeChange 流转：
//   NodeConfigPanel.onNodeChange(updatedNode)
//     → WorkflowEditorView.handleNodeChange(updatedNode)
//       → setNodes(prev => prev.map(n => n.id === updatedNode.id ? updatedNode : n))
//       → setDirty(true)
//   用户点保存 → updateWorkflow.mutateAsync({ id, patch: { nodes, ... } })
//
// ⚠️ SSR 安全：WorkflowCanvas 内部用动态 import，本文件无需特殊处理。
// ⚠️ views 包不得引入 next/* 或 react-router-dom（路由由外层 PersonalWorkspace 管理）。

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useWorkflowRuns,
  useUpdateWorkflow,
  useRunWorkflowNow,
  useStopWorkflowRun,
  useWorkflows,
} from "@cortex-work/core";
import type {
  WorkflowDef,
  WorkflowNode,
  WorkflowConnection,
  WorkflowNodeRunStatus,
  WorkflowEnvVar,
  WorkflowNodeKind,
} from "@cortex-work/core";
import {
  WORKFLOW_PALETTE_GROUPS,
  createWorkflowNode,
  NODE_ICONS,
} from "./workflow-flow";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { NodeConfigPanel } from "./node-config/NodeConfigPanel";
import { WorkflowRunLogPanel } from "./WorkflowRunLogPanel";

// 节点图标：动态加载前用文本，加载后用真实 icon（画布在 WorkflowCanvas 处理动态加载）
// palette 图标仅在 sidebar 中用，使用轻量文本符号即可。
const PALETTE_GROUP_LABELS: Record<string, string> = {
  trigger: "触发器",
  ai: "AI",
  flow: "流程控制",
  data: "数据处理",
  action: "动作",
};

const NODE_LABELS: Record<WorkflowNodeKind, string> = {
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

const DND_MIME = "application/x-workflow-node";

// ── Props ────────────────────────────────────────────────────────────────────

type Props = {
  /** 当前编辑的工作流（外层传入，最新版本）。 */
  workflow: WorkflowDef;
  /** 返回列表页。 */
  onBack: () => void;
  /** Toast 通知（成功/失败信息）。 */
  onToast: (text: string) => void;
};

// ── WorkflowEditorView ───────────────────────────────────────────────────────

export function WorkflowEditorView({ workflow, onBack, onToast }: Props) {
  const updateWorkflow = useUpdateWorkflow();
  const runNow = useRunWorkflowNow();
  const stopRun = useStopWorkflowRun();
  const { data: runs = [] } = useWorkflowRuns(workflow.id);
  // 全量工作流列表（loop/subworkflow 选择器用）
  const { data: allWorkflows = [] } = useWorkflows();

  // ── 本地编辑状态 ────────────────────────────────────────────────────────

  const [name, setName] = useState(workflow.name);
  const [enabled, setEnabled] = useState(workflow.enabled);
  const [env, setEnv] = useState<WorkflowEnvVar[]>(workflow.env);
  const [nodes, setNodes] = useState<WorkflowNode[]>(workflow.nodes);
  const [connections, setConnections] = useState<WorkflowConnection[]>(workflow.connections);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [showEnv, setShowEnv] = useState(false);
  const [rightTab, setRightTab] = useState<"config" | "log">("config");

  // 运行状态：取最近一次 run 的 nodeResults 映射
  const runStatus = useMemo<Record<string, WorkflowNodeRunStatus>>(() => {
    const latestRun = runs[runs.length - 1];
    if (!latestRun || latestRun.status !== "running") return {};
    const map: Record<string, WorkflowNodeRunStatus> = {};
    for (const r of latestRun.nodeResults) {
      map[r.nodeId] = r.status as WorkflowNodeRunStatus;
    }
    return map;
  }, [runs]);

  // 运行中检测（任意一个节点 running）
  const running = Object.values(runStatus).some((s) => s === "running");

  // 运行开始时自动切到 log 标签；选中节点时切回 config
  useEffect(() => {
    if (running) setRightTab("log");
  }, [running]);
  useEffect(() => {
    if (selectedNodeId) setRightTab("config");
  }, [selectedNodeId]);

  // 当外部 workflow 更新（保存成功后父组件刷新）时同步非脏状态
  const prevWorkflowId = useRef(workflow.id);
  useEffect(() => {
    if (workflow.id !== prevWorkflowId.current) {
      // 切换了工作流，全量重置
      prevWorkflowId.current = workflow.id;
      setName(workflow.name);
      setEnabled(workflow.enabled);
      setEnv(workflow.env);
      setNodes(workflow.nodes);
      setConnections(workflow.connections);
      setDirty(false);
    }
    // 未切换但外部有变（如广播刷新）且本地无脏修改，同步
    else if (!dirty) {
      setName(workflow.name);
      setEnabled(workflow.enabled);
      setEnv(workflow.env);
      setNodes(workflow.nodes);
      setConnections(workflow.connections);
    }
  }, [workflow, dirty]);

  // ── 保存 ─────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateWorkflow.mutateAsync({
        id: workflow.id,
        patch: {
          name: name.trim() || "未命名 loop",
          enabled,
          env,
          nodes,
          connections,
        },
      });
      setDirty(false);
      onToast("已保存");
    } catch (e) {
      onToast(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [updateWorkflow, workflow.id, name, enabled, env, nodes, connections, onToast]);

  // ── 运行一次 ──────────────────────────────────────────────────────────────

  const handleRun = useCallback(async () => {
    // 运行前先保存（与 Kun handleRun 同款逻辑）
    await handleSave();
    try {
      await runNow.mutateAsync(workflow.id);
      onToast("已触发运行");
    } catch (e) {
      onToast(`运行失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [handleSave, runNow, workflow.id, onToast]);

  // ── 停止运行 ──────────────────────────────────────────────────────────────

  const handleStop = useCallback(async () => {
    const latestRun = runs[runs.length - 1];
    if (!latestRun) return;
    try {
      await stopRun.mutateAsync({ workflowId: workflow.id, runId: latestRun.id });
      onToast("已发送停止信号");
    } catch (e) {
      onToast(`停止失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [stopRun, workflow.id, runs, onToast]);

  // ── 节点操作（传给 WorkflowCanvas）──────────────────────────────────────

  const handleRunNode = useCallback(
    (_nodeId: string) => {
      // U6 阶段：单节点运行 IPC 待 U7 配置面板完成后配合，此处 toast 提示
      onToast("单节点运行将在 U7 配置面板落地后支持");
    },
    [onToast],
  );

  const handleToggleDisabled = useCallback((nodeId: string) => {
    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId ? { ...n, disabled: !n.disabled } : n,
      ),
    );
    setDirty(true);
  }, []);

  const handleDeleteNode = useCallback((nodeId: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setConnections((prev) =>
      prev.filter((c) => c.source !== nodeId && c.target !== nodeId),
    );
    setSelectedNodeId((id) => (id === nodeId ? null : id));
    setDirty(true);
  }, []);

  // ── 节点配置变更回调（NodeConfigPanel → 更新本地 nodes 状态）────────────
  // 节点 config/name/disabled/onError/retries 等均在此单点更新，
  // 用户再点保存时统一回写 backend（不自动保存，避免频繁 IPC）。
  const handleNodeChange = useCallback((updated: WorkflowNode) => {
    setNodes((prev) =>
      prev.map((n) => (n.id === updated.id ? updated : n)),
    );
    setDirty(true);
  }, []);

  // ── 画布变更回调 ─────────────────────────────────────────────────────────

  const handleCanvasChange = useCallback(
    (nextNodes: WorkflowNode[], nextConns: WorkflowConnection[]) => {
      setNodes(nextNodes);
      setConnections(nextConns);
      setDirty(true);
    },
    [],
  );

  // ── Palette DnD（sidebar 拖入画布）───────────────────────────────────────

  const onPaletteDragStart = useCallback((e: DragEvent, kind: WorkflowNodeKind) => {
    e.dataTransfer.setData(DND_MIME, kind);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const onPaletteClick = useCallback((kind: WorkflowNodeKind) => {
    const offset = nodes.length * 28;
    const node = createWorkflowNode(kind, { x: 360 + (offset % 180), y: 140 + offset });
    setNodes((prev) => [...prev, node]);
    setSelectedNodeId(node.id);
    setDirty(true);
  }, [nodes.length]);

  // ── 分组折叠 ─────────────────────────────────────────────────────────────

  const toggleGroup = useCallback((id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── 选中节点数据 ─────────────────────────────────────────────────────────

  const selectedNode = useMemo(
    () => (selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) ?? null : null),
    [nodes, selectedNodeId],
  );

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  return (
    <div className="ds-no-drag fixed inset-0 z-[60] flex bg-ds-main">
      {/* ── 左侧 Palette sidebar ───────────────────────────────────────────── */}
      {!leftCollapsed ? (
        <aside className="ds-drag flex w-[184px] shrink-0 flex-col border-r border-ds-border bg-ds-card/40">
          <div className="shrink-0 px-2 pb-2 pt-3">
            <div aria-hidden className="ds-titlebar-safe-block" />
            <button
              type="button"
              onClick={onBack}
              className="ds-no-drag flex h-9 items-center gap-2 rounded-xl px-2 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            >
              <Icon.Back size={16} sw={1.8} />
              返回
            </button>
          </div>
          <div className="ds-no-drag flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-3">
            <span className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ds-faint">
              节点
            </span>
            {WORKFLOW_PALETTE_GROUPS.map((group) => {
              const collapsed = collapsedGroups.has(group.id);
              return (
                <div key={group.id} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    className="flex items-center gap-1 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-ds-faint transition hover:text-ds-muted"
                  >
                    <Icon.ChevronRight
                      size={12}
                      sw={2}
                      className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {PALETTE_GROUP_LABELS[group.id] ?? group.id}
                    </span>
                  </button>
                  {!collapsed
                    ? group.kinds.map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          draggable
                          onDragStart={(e) => onPaletteDragStart(e, kind)}
                          onClick={() => onPaletteClick(kind)}
                          className="flex cursor-grab items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-[12.5px] text-ds-ink transition hover:border-ds-border hover:bg-ds-hover active:cursor-grabbing"
                        >
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                            {(() => {
                              const NodeIcon = NODE_ICONS[kind];
                              return NodeIcon ? <NodeIcon size={14} sw={1.8} /> : null;
                            })()}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {NODE_LABELS[kind] ?? kind}
                          </span>
                          <Icon.Plus size={14} sw={1.8} className="shrink-0 text-ds-faint" />
                        </button>
                      ))
                    : null}
                </div>
              );
            })}
          </div>
        </aside>
      ) : null}

      {/* ── 主区（顶部 header + 画布 + 右侧面板）──────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶部 header */}
        <header className="ds-drag flex shrink-0 items-center gap-3 border-b border-ds-border px-4">
          <div aria-hidden className="ds-titlebar-safe-block" />
          {leftCollapsed ? (
            <button
              type="button"
              onClick={onBack}
              className="ds-no-drag flex h-9 items-center gap-2 rounded-xl px-2 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink shrink-0"
            >
              <Icon.Back size={16} sw={1.8} />
              返回
            </button>
          ) : null}

          {/* 工作流名称输入框 */}
          <input
            className="ds-no-drag min-w-0 flex-1 rounded-xl border border-transparent bg-transparent px-2 py-1.5 text-[15px] font-medium text-ds-ink outline-none focus:border-ds-border focus:bg-ds-card"
            value={name}
            placeholder="工作流名称"
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />

          {/* 已启用 toggle */}
          <label className="ds-no-drag flex shrink-0 items-center gap-2 text-[13px] font-medium text-ds-muted">
            已启用
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setDirty(true);
              }}
            />
          </label>

          {/* 环境变量 */}
          <button
            type="button"
            onClick={() => setShowEnv(true)}
            className="ds-no-drag relative inline-flex h-9 items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <Icon.Variable size={16} sw={1.8} />
            环境变量
            {env.length > 0 ? (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent/15 px-1 text-[10px] font-semibold text-accent">
                {env.length}
              </span>
            ) : null}
          </button>

          {/* 保存按钮 */}
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="ds-no-drag inline-flex h-9 items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-medium text-ds-ink transition hover:bg-ds-hover disabled:opacity-60"
          >
            <Icon.Save size={16} sw={1.8} />
            {dirty ? "保存" : "已保存"}
          </button>

          {/* 运行/停止按钮 */}
          {running ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              className="ds-no-drag inline-flex h-9 items-center gap-1.5 rounded-xl bg-red-500/90 px-4 text-[13px] font-semibold text-white shadow-sm transition hover:bg-red-500"
            >
              <Icon.Stop size={14} sw={2} />
              停止
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleRun()}
              className="ds-no-drag inline-flex h-9 items-center gap-1.5 rounded-xl bg-ds-userbubble px-4 text-[13px] font-semibold text-ds-userbubbleFg shadow-sm transition hover:opacity-90"
            >
              <Icon.Run size={16} sw={2} />
              运行一次
            </button>
          )}
        </header>

        {/* 画布 + 右侧面板行 */}
        <div className="flex min-h-0 flex-1">
          {/* 画布区 */}
          <div className="relative min-w-0 flex-1">
            <WorkflowCanvas
              nodes={nodes}
              connections={connections}
              runStatus={runStatus}
              onChange={handleCanvasChange}
              onSelectNode={setSelectedNodeId}
              selectedNodeId={selectedNodeId}
              onRunNode={handleRunNode}
              onToggleDisabled={handleToggleDisabled}
              onDeleteNode={handleDeleteNode}
            />

            {/* 左侧面板折叠/展开按钮 */}
            <button
              type="button"
              onClick={() => setLeftCollapsed((v) => !v)}
              className="absolute left-0 top-1/2 z-10 flex h-12 w-5 -translate-y-1/2 items-center justify-center rounded-r-lg border border-l-0 border-ds-border bg-ds-card text-ds-faint shadow-sm transition hover:text-ds-ink"
            >
              {leftCollapsed ? (
                <Icon.ChevronRight size={16} sw={2} />
              ) : (
                <Icon.ChevronLeft size={16} sw={2} />
              )}
            </button>

            {/* 右侧面板折叠/展开按钮 */}
            <button
              type="button"
              onClick={() => setRightCollapsed((v) => !v)}
              className="absolute right-0 top-1/2 z-10 flex h-12 w-5 -translate-y-1/2 items-center justify-center rounded-l-lg border border-r-0 border-ds-border bg-ds-card text-ds-faint shadow-sm transition hover:text-ds-ink"
            >
              {rightCollapsed ? (
                <Icon.ChevronLeft size={16} sw={2} />
              ) : (
                <Icon.ChevronRight size={16} sw={2} />
              )}
            </button>
          </div>

          {/* 右侧面板（U7 占位：配置 / 运行日志 tab）*/}
          {!rightCollapsed ? (
            <aside className="flex w-[320px] shrink-0 flex-col overflow-hidden border-l border-ds-border bg-ds-card/40">
              {/* tab bar */}
              <div className="flex shrink-0 items-center gap-1 border-b border-ds-border px-2 pt-2">
                {(["config", "log"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setRightTab(tab)}
                    className={`relative flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-medium transition ${
                      rightTab === tab ? "text-ds-ink" : "text-ds-faint hover:text-ds-muted"
                    }`}
                  >
                    {tab === "config" ? "配置" : "运行日志"}
                    {tab === "log" && running ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                    ) : null}
                    {rightTab === tab ? (
                      <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
                    ) : null}
                  </button>
                ))}
              </div>

              {/* 面板内容（U7：NodeConfigPanel + WorkflowRunLogPanel）*/}
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
                {rightTab === "config" ? (
                  // NodeConfigPanel：分发到各节点 form；无选中时提示
                  <NodeConfigPanel
                    node={selectedNode}
                    allNodes={nodes}
                    envVars={env}
                    workflowId={workflow.id}
                    workflows={allWorkflows}
                    onNodeChange={handleNodeChange}
                  />
                ) : (
                  // WorkflowRunLogPanel：拉取运行历史，按节点展示结果
                  <WorkflowRunLogPanel
                    workflowId={workflow.id}
                    allNodes={nodes}
                  />
                )}
              </div>
            </aside>
          ) : null}
        </div>
      </div>

      {/* 环境变量编辑 modal */}
      {showEnv ? (
        <EnvVarsModal
          env={env}
          onChange={(next) => {
            setEnv(next);
            setDirty(true);
          }}
          onClose={() => setShowEnv(false)}
        />
      ) : null}
    </div>
  );
}

// ── EnvVarsModal ──────────────────────────────────────────────────────────────

const ENV_VAR_TYPES: Array<NonNullable<WorkflowEnvVar["type"]>> = [
  "string",
  "number",
  "boolean",
  "secret",
];

const ENV_TYPE_LABELS: Record<string, string> = {
  string: "文本",
  number: "数值",
  boolean: "布尔",
  secret: "密钥",
};

function EnvVarsModal({
  env,
  onChange,
  onClose,
}: {
  env: WorkflowEnvVar[];
  onChange: (next: WorkflowEnvVar[]) => void;
  onClose: () => void;
}) {
  const inputClass =
    "w-full rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[13px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/25";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-ds-border px-5 py-3.5">
          <div className="flex flex-col">
            <span className="text-[14px] font-semibold text-ds-ink">环境变量</span>
            <span className="text-[11.5px] text-ds-faint">
              在节点中使用 {"{{$env.key}}"} 引用
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <Icon.X size={16} sw={1.8} />
          </button>
        </header>
        <div className="flex flex-col gap-2 overflow-y-auto px-5 py-4">
          {env.length === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-ds-faint">暂无环境变量</p>
          ) : (
            env.map((item, index) => {
              const update = (patch: Partial<WorkflowEnvVar>) =>
                onChange(env.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
              return (
                <div key={index} className="flex items-center gap-2">
                  <input
                    className={`${inputClass} w-40 shrink-0 font-mono`}
                    value={item.key}
                    placeholder="变量名"
                    onChange={(e) => update({ key: e.target.value })}
                  />
                  <select
                    className={`${inputClass} w-24 shrink-0`}
                    value={item.type ?? "string"}
                    onChange={(e) =>
                      update({ type: e.target.value as WorkflowEnvVar["type"] })
                    }
                  >
                    {ENV_VAR_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {ENV_TYPE_LABELS[t] ?? t}
                      </option>
                    ))}
                  </select>
                  <input
                    className={inputClass}
                    type={item.type === "secret" ? "password" : "text"}
                    value={item.value}
                    placeholder="值"
                    onChange={(e) => update({ value: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => onChange(env.filter((_, i) => i !== index))}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ds-faint transition hover:bg-red-500/10 hover:text-red-600"
                    aria-label="删除"
                  >
                    <Icon.X size={14} sw={2} />
                  </button>
                </div>
              );
            })
          )}
          <button
            type="button"
            onClick={() =>
              onChange([...env, { key: `KEY_${env.length + 1}`, value: "", type: "string" }])
            }
            className="mt-1 inline-flex items-center gap-1.5 self-start rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-accent transition hover:bg-accent/10"
          >
            <Icon.Plus size={14} sw={2} />
            添加变量
          </button>
        </div>
      </div>
    </div>
  );
}
