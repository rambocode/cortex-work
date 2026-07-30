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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useWorkflowRuns,
  useUpdateWorkflow,
  useRunWorkflowNow,
  useRunWorkflowNode,
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
  TRIGGER_KINDS,
} from "./workflow-flow";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { NodeConfigPanel } from "./node-config/NodeConfigPanel";
import { WorkflowRunLogPanel } from "./WorkflowRunLogPanel";
import { WorkflowRunHistoryModal } from "./WorkflowRunHistoryModal";

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
  "sticky-note": "便签",
};

const DND_MIME = "application/x-workflow-node";

// ── 画布状态条：上次运行状态 → 文案 / 圆点色 ─────────────────────────────────
const RUN_STATUS_LABELS: Record<string, string> = {
  success: "成功",
  error: "失败",
  running: "运行中",
  canceled: "已取消",
  idle: "尚未运行",
};
const RUN_STATUS_DOT: Record<string, string> = {
  success: "bg-emerald-500",
  error: "bg-red-500",
  running: "bg-amber-500 animate-pulse",
  canceled: "bg-ds-faint/60",
};

// 运行时间格式化：当天「今天 HH:MM」，否则「M月D日 HH:MM」。
function formatRunTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `今天 ${hhmm}`
    : `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

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
  const runNode = useRunWorkflowNode();
  const stopRun = useStopWorkflowRun();
  const { data: runs = [] } = useWorkflowRuns(workflow.id);
  // 全量工作流列表（loop/subworkflow 选择器用）
  const { data: allWorkflows = [] } = useWorkflows();

  // ── 本地编辑状态 ────────────────────────────────────────────────────────

  const [name, setName] = useState(workflow.name);
  const [enabled, setEnabled] = useState(workflow.enabled);
  const [env, setEnv] = useState<WorkflowEnvVar[]>(workflow.env);
  const [nodes, setNodes] = useState<WorkflowNode[]>(workflow.nodes);
  const [connections, setConnections] = useState<WorkflowConnection[]>(
    workflow.connections,
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [showEnv, setShowEnv] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [rightTab, setRightTab] = useState<"config" | "log">("config");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // onToast 最新引用：异步流程中用 ref 取最新回调，避免闭包失效。
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  // 单节点运行的状态（nodeId → running/success/error）：覆盖在整体 runStatus 之上，
  // 让画布节点的状态圆点实时反映「运行该节点」的结果（单节点运行不产生整体 run 记录）。
  const [nodeRunStatus, setNodeRunStatus] = useState<
    Record<string, WorkflowNodeRunStatus>
  >({});
  // 居中 loop 名称输入框 ref（铅笔图标点击聚焦用）
  const nameInputRef = useRef<HTMLInputElement>(null);

  // 运行历史缓存最新在前（upsertRun/listRuns 均按 unshift 语义维护）。
  const latestRun = runs[0];
  const activeRun = activeRunId
    ? runs.find((run) => run.id === activeRunId)
    : undefined;

  // 运行状态：取最近一次 run 的 nodeResults 映射，完成后也保留 success/error 状态点。
  const runStatus = useMemo<Record<string, WorkflowNodeRunStatus>>(() => {
    if (!latestRun) return {};
    const map: Record<string, WorkflowNodeRunStatus> = {};
    for (const r of latestRun.nodeResults) {
      map[r.nodeId] = r.status as WorkflowNodeRunStatus;
    }
    return map;
  }, [latestRun]);

  // 画布最终状态：单节点运行状态覆盖在整体 run 状态之上（单节点运行的圆点优先）。
  const mergedRunStatus = useMemo<Record<string, WorkflowNodeRunStatus>>(
    () => ({ ...runStatus, ...nodeRunStatus }),
    [runStatus, nodeRunStatus],
  );

  // 运行中检测：只跟踪本页面点击「运行一次」启动的 run，避免历史 running 记录让初始页面误显示停止。
  // !activeRun 兜底：run 刚创建、runs 缓存尚未反映时也立即显示「停止」。
  // 注：按钮卡死的真因是后端 run 未收尾(持久化状态卡 running)，已由 stopRun 强制收尾 +
  // sync/markOrphanRunsKilled 修复；run 正常进入终态后此处 activeRun.status 即非 running，按钮回落。
  const running =
    activeRunId !== null && (!activeRun || activeRun.status === "running");

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
      setActiveRunId(null);
      setNodeRunStatus({});
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

  // successText：保存成功提示文案。「发布」复用本逻辑（发布 = 持久化当前版本），
  // 仅提示语不同，避免再造一套 mutate 流程。
  const handleSave = useCallback(
    async (successText = "已保存", silent = false) => {
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
        // silent：单节点运行前的预保存，不弹「已保存」噪音（运行反馈由调用方给）。
        if (!silent) onToast(successText);
      } catch (e) {
        onToast(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSaving(false);
      }
    },
    [
      updateWorkflow,
      workflow.id,
      name,
      enabled,
      env,
      nodes,
      connections,
      onToast,
    ],
  );

  // ── 运行一次 ──────────────────────────────────────────────────────────────

  const handleRun = useCallback(async () => {
    // 整体运行：清掉单节点运行的圆点，交还给本次 run 的 nodeResults 驱动。
    setNodeRunStatus({});
    // 运行前先保存（与 Kun handleRun 同款逻辑）
    await handleSave();
    try {
      const run = await runNow.mutateAsync(workflow.id);
      if (run?.id) setActiveRunId(run.id);
      onToast("已触发运行");
    } catch (e) {
      onToast(`运行失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [handleSave, runNow, workflow.id, onToast]);

  // ── 停止运行 ──────────────────────────────────────────────────────────────

  const handleStop = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await stopRun.mutateAsync({
        workflowId: workflow.id,
        runId: activeRunId,
      });
      onToast("已发送停止信号");
    } catch (e) {
      onToast(`停止失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [stopRun, workflow.id, activeRunId, onToast]);

  // ── 节点操作（传给 WorkflowCanvas）──────────────────────────────────────

  // 单节点运行：先保存当前编辑(后端按 workflowId+nodeId 从存储读取最新 config)，
  // 再调 workflow:node:run，结果以 toast 反馈。
  const handleRunNode = useCallback(
    async (nodeId: string) => {
      // 点击即把该节点圆点置「运行中」(即时视觉反馈)；静默预保存后调单节点运行。
      setNodeRunStatus((s) => ({ ...s, [nodeId]: "running" }));
      await handleSave("", true);
      try {
        const res = await runNode.mutateAsync({
          workflowId: workflow.id,
          nodeId,
        });
        setNodeRunStatus((s) => ({
          ...s,
          [nodeId]: res?.ok ? "success" : "error",
        }));
        // 仅失败时给通知(说明失败原因)；成功只靠圆点反馈，不打扰。
        if (!res?.ok)
          onToastRef.current(`节点运行失败：${res?.error ?? "未知错误"}`);
      } catch (e) {
        setNodeRunStatus((s) => ({ ...s, [nodeId]: "error" }));
        onToastRef.current(
          `节点运行失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [handleSave, runNode, workflow.id],
  );

  const handleToggleDisabled = useCallback((nodeId: string) => {
    setNodes((prev) =>
      prev.map((n) => (n.id === nodeId ? { ...n, disabled: !n.disabled } : n)),
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
    setNodes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
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

  // ── 自动布局 ─────────────────────────────────────────────────────────────
  // 按连接关系做 BFS 分层：从触发器/无入度节点向右逐层铺开（COL 列距 / ROW 行距）。
  // 孤立节点（未被任何连线触及）统一放到末层，避免重叠在原点。
  const handleAutoLayout = useCallback(() => {
    setNodes((prev) => {
      if (prev.length === 0) return prev;
      // 便签是画布注释、无连接：排除出自动布局，否则会被当作 in-degree=0 的 root
      // 放到 depth=0 列、覆盖用户手动摆放的位置。便签保留原 position。
      const layoutNodes = prev.filter((n) => n.type !== "sticky-note");
      const incoming = new Map<string, number>();
      layoutNodes.forEach((n) => incoming.set(n.id, 0));
      const adj = new Map<string, string[]>();
      connections.forEach((c) => {
        incoming.set(c.target, (incoming.get(c.target) ?? 0) + 1);
        const list = adj.get(c.source) ?? [];
        list.push(c.target);
        adj.set(c.source, list);
      });
      const roots = layoutNodes
        .filter((n) => (incoming.get(n.id) ?? 0) === 0)
        .map((n) => n.id);
      const depth = new Map<string, number>();
      const visited = new Set<string>();
      const firstId = layoutNodes[0]?.id;
      let frontier = roots.length ? roots : firstId ? [firstId] : [];
      let d = 0;
      while (frontier.length) {
        const next: string[] = [];
        frontier.forEach((id) => {
          if (visited.has(id)) return;
          visited.add(id);
          depth.set(id, d);
          (adj.get(id) ?? []).forEach((t) => {
            if (!visited.has(t)) next.push(t);
          });
        });
        frontier = next;
        d += 1;
      }
      let maxD = 0;
      depth.forEach((v) => {
        maxD = Math.max(maxD, v);
      });
      const byDepth = new Map<number, string[]>();
      layoutNodes.forEach((n) => {
        const dd = depth.get(n.id) ?? maxD + 1;
        const list = byDepth.get(dd) ?? [];
        list.push(n.id);
        byDepth.set(dd, list);
      });
      const COL = 300;
      const ROW = 150;
      const X0 = 80;
      const Y0 = 80;
      const pos = new Map<string, { x: number; y: number }>();
      byDepth.forEach((ids, dd) => {
        ids.forEach((id, i) =>
          pos.set(id, { x: X0 + dd * COL, y: Y0 + i * ROW }),
        );
      });
      // 便签不在 pos 中：保留原 position 不动。
      return prev.map((n) =>
        n.type === "sticky-note"
          ? n
          : { ...n, position: pos.get(n.id) ?? n.position },
      );
    });
    setDirty(true);
    onToast("已自动布局");
  }, [connections, onToast]);

  // ── Palette DnD（sidebar 拖入画布）───────────────────────────────────────

  const onPaletteDragStart = useCallback(
    (e: DragEvent, kind: WorkflowNodeKind) => {
      e.dataTransfer.setData(DND_MIME, kind);
      e.dataTransfer.effectAllowed = "move";
    },
    [],
  );

  const onPaletteClick = useCallback(
    (kind: WorkflowNodeKind) => {
      const offset = nodes.length * 28;
      const node = createWorkflowNode(kind, {
        x: 360 + (offset % 180),
        y: 140 + offset,
      });
      setNodes((prev) => [...prev, node]);
      setSelectedNodeId(node.id);
      setDirty(true);
    },
    [nodes.length],
  );

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
    () =>
      selectedNodeId
        ? (nodes.find((n) => n.id === selectedNodeId) ?? null)
        : null,
    [nodes, selectedNodeId],
  );

  // 右侧面板内容存在性：选中了节点 或 本会话已触发过运行（activeRunId 非空）。
  // 初始空画布（无选中 + 未运行）下整列隐藏，保持画布更宽敞；
  // 点击「运行一次」→ setActiveRunId → 面板出现并自动切到运行日志 tab。
  const hasRightContent = selectedNode !== null || activeRunId !== null;

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  // 画布状态条数据（真实数据：上次运行状态/时间 + 触发类型 + 节点数；不杜撰「处理 N 条」）
  const runLabel = RUN_STATUS_LABELS[latestRun?.status ?? "idle"] ?? "尚未运行";
  const runDot = RUN_STATUS_DOT[latestRun?.status ?? ""] ?? "bg-ds-faint/50";
  const runTime = formatRunTime(latestRun?.startedAt);
  const triggerNode = nodes.find((n) => TRIGGER_KINDS.has(n.type));
  const triggerLabel = triggerNode ? NODE_LABELS[triggerNode.type] : "";

  return (
    <div className="ds-workflow-scope ds-no-drag fixed inset-0 z-[60] flex flex-col bg-ds-main">
      {/* ── 全宽顶栏：左红绿灯安全区 + 居中 loop 名称（绝对居中）+ 右操作区 ──────── */}
      <header className="ds-drag relative flex h-[52px] shrink-0 items-center gap-2 border-b border-ds-border bg-ds-card/40 pl-[78px] pr-4">
        {/* 侧栏折叠时在顶栏补一个返回入口（默认返回在侧栏搜索框上方）*/}
        {leftCollapsed ? (
          <button
            type="button"
            onClick={onBack}
            className="ds-no-drag flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <Icon.Back size={16} sw={1.8} />
            返回
          </button>
        ) : null}

        {/* 可编辑 loop 名称：左对齐到画布区域左侧（侧栏宽 240px；折叠时贴近顶栏左侧）*/}
        <div
          className="pointer-events-none absolute flex items-center gap-1.5"
          style={{ left: leftCollapsed ? 140 : 248 }}
        >
          {/* 宽 240px、文字左对齐；聚焦(点击编辑)时底色转纯白 + 描边 */}
          <input
            ref={nameInputRef}
            className="ds-no-drag pointer-events-auto w-[240px] rounded-md border border-transparent bg-transparent px-1.5 py-1 text-left text-[14.5px] font-semibold text-ds-ink outline-none transition focus:border-ds-border focus:bg-white"
            value={name}
            placeholder="工作流名称"
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
          {/* 铅笔：点击聚焦输入框进入编辑 */}
          <button
            type="button"
            onClick={() => nameInputRef.current?.focus()}
            aria-label="编辑名称"
            className="ds-no-drag pointer-events-auto flex h-6 w-6 shrink-0 items-center justify-center"
          >
            <Icon.Edit
              size={14}
              sw={1.7}
              className="text-ds-faint transition hover:text-ds-muted"
            />
          </button>
        </div>

        <div className="flex-1" />

        {/* 右侧操作区 */}
        <div className="ds-no-drag flex shrink-0 items-center gap-2.5">
          {/* 启用开关：pill 滑块（对齐 mockup Enabled Toggle）——开启绿、关闭灰，旋钮位移切换 */}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => {
              setEnabled(!enabled);
              setDirty(true);
            }}
            className="wf-tb-ghost"
          >
            <span
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                enabled ? "bg-emerald-500" : "bg-ds-border"
              }`}
            >
              {/* 旋钮用显式 left 定位（避免缺省 left 导致位置异常 / 遮挡文字）*/}
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                  enabled ? "left-[18px]" : "left-0.5"
                }`}
              />
            </span>
            <span className="text-[13.5px] font-medium text-ds-ink">
              {enabled ? "已启用" : "已停用"}
            </span>
          </button>

          {/* 环境变量：{ } 靛色符号 + 文字，无边框 ghost */}
          <button
            type="button"
            onClick={() => setShowEnv(true)}
            className="wf-tb-ghost"
          >
            <span className="font-semibold text-[#5B50E6]">{"{ }"}</span>
            <span className="text-ds-ink">环境变量</span>
            {env.length > 0 ? (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#5B50E6]/12 px-1 text-[10px] font-semibold text-[#5B50E6]">
                {env.length}
              </span>
            ) : null}
          </button>

          {/* 保存：save 图标 + 文字，无边框 ghost */}
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="wf-tb-ghost"
          >
            <Icon.Save size={16} sw={1.8} className="text-ds-muted" />
            {dirty ? "保存" : "已保存"}
          </button>

          {/* 分隔线（对齐 mockup tb-sep）*/}
          <div aria-hidden className="h-5 w-px bg-ds-border" />

          {/* 运行/停止：灰描边 outline 按钮 */}
          {running ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              className="wf-tb-stop"
            >
              <Icon.Stop size={15} sw={2} />
              停止
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleRun()}
              className="wf-tb-run"
            >
              <Icon.Run size={15} sw={2} className="text-ds-muted" />
              运行一次
            </button>
          )}

          {/* 历史：图标按钮 → 弹出可检索的运行历史 */}
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            aria-label="运行历史"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <Icon.Clock size={18} sw={1.8} />
          </button>

          {/* 发布：靛色主 CTA（对齐 mockup primary #5B50E6）。发布 = 持久化当前版本
              （复用 handleSave），提示「已发布」。启用与否由 pill 开关控制。*/}
          <button
            type="button"
            onClick={() => void handleSave("已发布")}
            disabled={saving}
            className="wf-tb-publish"
          >
            <Icon.Check size={15} sw={2.4} />
            发布
          </button>
        </div>
      </header>

      {/* ── 主体行（左 palette + 画布 + 右 inspector）──────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* ── 左侧 Palette sidebar ─────────────────────────────────────────── */}
        {!leftCollapsed ? (
          <aside className="flex w-[240px] shrink-0 flex-col border-r border-ds-border bg-ds-card/40">
            {/* 返回（搜索框上方）*/}
            <div className="shrink-0 pb-0.5 pl-4 pr-3.5 pt-3">
              <button
                type="button"
                onClick={onBack}
                className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
              >
                <Icon.Back size={16} sw={1.8} />
                返回
              </button>
            </div>
            {/* 节点搜索（对齐 mockup pal-search）：过滤节点标签；有查询时强制展开所有分组 */}
            <div className="shrink-0 pb-2 pl-5 pr-3.5 pt-1">
              <div className="flex h-11 items-center gap-2.5 rounded-2xl border border-ds-border bg-ds-card px-3.5 text-ds-faint transition focus-within:border-accent">
                <Icon.Search size={16} sw={1.9} />
                <input
                  value={paletteQuery}
                  onChange={(e) => setPaletteQuery(e.target.value)}
                  placeholder="搜索节点…"
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-ds-ink outline-none placeholder:text-ds-faint"
                />
              </div>
            </div>
            {/* 节点列表：分组间 gap-4（拉开）；图标用分类软底芯片，行宽松（py-1.5 + 30px 芯片），
                组内项 gap-1.5，+ 仅 hover 浮现——对齐 mockup 左侧菜单。 */}
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4 pl-5 pr-3 pt-1">
              {WORKFLOW_PALETTE_GROUPS.map((group) => {
                const q = paletteQuery.trim().toLowerCase();
                const kinds = q
                  ? group.kinds.filter((k) =>
                      (NODE_LABELS[k] ?? k).toLowerCase().includes(q),
                    )
                  : group.kinds;
                if (kinds.length === 0) return null;
                // 搜索时强制展开分组，无视手动折叠态
                const collapsed = !q && collapsedGroups.has(group.id);
                return (
                  <div key={group.id} className="flex flex-col">
                    {/* 一级分组头:hover 蓝底由 .ds-palette-group:hover(CSS)实现 */}
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                      className="ds-palette-group flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-semibold tracking-wide text-ds-faint transition"
                    >
                      {/* 展开时 chevron 指右（对齐 mockup），折叠时转为指下 */}
                      <Icon.ChevronRight
                        size={13}
                        sw={2}
                        className={`shrink-0 transition-transform ${collapsed ? "rotate-90" : ""}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-left">
                        {PALETTE_GROUP_LABELS[group.id] ?? group.id}
                      </span>
                    </button>
                    {!collapsed ? (
                      <div className="mt-1 flex flex-col gap-1.5">
                        {kinds.map((kind) => (
                          <button
                            key={kind}
                            type="button"
                            draggable
                            onDragStart={(e) => onPaletteDragStart(e, kind)}
                            onClick={() => onPaletteClick(kind)}
                            className="ds-palette-node group flex cursor-grab items-center gap-3 rounded-md px-2 py-1.5 text-left text-[14.5px] text-ds-ink transition active:cursor-grabbing"
                          >
                            {/* 纯描边分类着色图标（无底色芯片）；30px 方框仅用于对齐 */}
                            <span
                              className={`wf-cat-${group.id} wf-ink flex h-[30px] w-[30px] shrink-0 items-center justify-center`}
                            >
                              {(() => {
                                const NodeIcon = NODE_ICONS[kind];
                                return NodeIcon ? (
                                  <NodeIcon size={18} sw={1.8} />
                                ) : null;
                              })()}
                            </span>
                            <span className="min-w-0 flex-1 truncate">
                              {NODE_LABELS[kind] ?? kind}
                            </span>
                            {/* + 仅整行 hover 时浮现（对齐 mockup pal-add）*/}
                            <Icon.Plus
                              size={16}
                              sw={1.8}
                              className="shrink-0 text-ds-faint opacity-0 transition group-hover:text-accent group-hover:opacity-100"
                            />
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </aside>
        ) : null}

        {/* 画布列：状态条 + 画布 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 画布状态条（对齐 mockup canvas-bar：上次运行 / 触发 / 节点数 / 自动布局）*/}
          <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-ds-border bg-ds-card/30 px-4 text-[12px] text-ds-muted">
            <span className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${runDot}`} />
              上次运行 <b className="font-semibold text-ds-ink">{runLabel}</b>
            </span>
            {runTime ? (
              <>
                <span className="text-ds-faint">·</span>
                <span>{runTime}</span>
              </>
            ) : null}
            {triggerLabel ? (
              <>
                <span className="text-ds-faint">·</span>
                <span>
                  触发{" "}
                  <b className="font-semibold text-ds-ink">{triggerLabel}</b>
                </span>
              </>
            ) : null}
            <div className="flex-1" />
            <span className="inline-flex items-center gap-1.5 rounded-md bg-ds-hover px-2 py-1 text-[11.5px] font-medium text-ds-muted">
              <Icon.Clock size={13} sw={1.9} />
              {nodes.length} 个节点
            </span>
            <button
              type="button"
              onClick={handleAutoLayout}
              className="inline-flex items-center gap-1.5 rounded-md bg-ds-hover px-2 py-1 text-[11.5px] font-medium text-ds-muted transition hover:text-ds-ink"
            >
              <Icon.ChevronRight size={13} sw={1.9} />
              自动布局
            </button>
          </div>

          {/* 画布 */}
          <div className="relative min-w-0 flex-1">
            <WorkflowCanvas
              nodes={nodes}
              connections={connections}
              runStatus={mergedRunStatus}
              onChange={handleCanvasChange}
              onSelectNode={setSelectedNodeId}
              selectedNodeId={selectedNodeId}
              onRunNode={handleRunNode}
              onToggleDisabled={handleToggleDisabled}
              onDeleteNode={handleDeleteNode}
              onNodeChange={handleNodeChange}
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

            {/* 右侧面板折叠/展开按钮（无内容时一并隐藏，避免悬空切换按钮）*/}
            {hasRightContent ? (
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
            ) : null}
          </div>
        </div>

        {/* 右侧面板（配置 / 运行日志 tab）：仅在有内容（选中节点或已运行）时渲染 */}
        {hasRightContent && !rightCollapsed ? (
          <aside className="flex w-[360px] shrink-0 flex-col overflow-hidden border-l border-ds-border bg-ds-card/40">
            {/* tab bar：内边距/字号/文字色直接用 Tailwind 工具类——全局 button reset 已移入
                @layer base（见 cortex-desktop.css），工具类(@layer utilities)可正常覆盖按钮，
                无需再造未分层 .wf-* 绕过类。容器加 pb-2 让按钮不贴分隔线。 */}
            <div className="flex shrink-0 items-center gap-1.5 border-b border-ds-border px-3 pb-2 pt-3">
              {(["config", "log"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setRightTab(tab)}
                  className={`relative inline-flex items-center gap-1.5 rounded-[9px] px-3.5 py-2 text-[13px] font-semibold transition ${
                    rightTab === tab
                      ? "text-ds-ink"
                      : "text-ds-faint hover:bg-ds-hover hover:text-ds-muted"
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

            {/* 面板内容（NodeConfigPanel + WorkflowRunLogPanel）*/}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
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
      {/* 运行历史弹窗（可检索）*/}
      {showHistory ? (
        <WorkflowRunHistoryModal
          runs={runs}
          allNodes={nodes}
          onClose={() => setShowHistory(false)}
        />
      ) : null}

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
            <span className="text-[14px] font-semibold text-ds-ink">
              环境变量
            </span>
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
            <p className="py-6 text-center text-[12.5px] text-ds-faint">
              暂无环境变量
            </p>
          ) : (
            env.map((item, index) => {
              const update = (patch: Partial<WorkflowEnvVar>) =>
                onChange(
                  env.map((entry, i) =>
                    i === index ? { ...entry, ...patch } : entry,
                  ),
                );
              return (
                <div key={index} className="flex items-center gap-2">
                  <input
                    className={`${inputClass} basis-40 shrink-0 font-mono`}
                    value={item.key}
                    placeholder="变量名"
                    onChange={(e) => update({ key: e.target.value })}
                  />
                  <select
                    className={`${inputClass} basis-24 shrink-0`}
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
              onChange([
                ...env,
                { key: `KEY_${env.length + 1}`, value: "", type: "string" },
              ])
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
