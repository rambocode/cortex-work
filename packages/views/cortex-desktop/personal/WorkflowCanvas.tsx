// WorkflowCanvas.tsx — @xyflow/react 画布封装（SSR 安全）。
//
// 关键设计：@xyflow/react 在服务端（Next.js SSR）无法加载（依赖 DOM API）。
// 本文件使用与 TerminalPanel.tsx / MonacoViewer.tsx 相同的模式：
//   - 顶层只 import 类型（import type），不 import 运行时模块。
//   - 实际组件通过 useEffect 内 import() 动态加载，仅在浏览器环境执行。
//   - WorkflowEditorView 导入本文件时不会触发 @xyflow/react 的顶层 import。
//
// WorkflowNodes.tsx 同样不能静态 import（它依赖 @xyflow/react 运行时），
// 因此在 loadCanvas() 函数内一起动态加载。

import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
// ReactFlow 基础样式表（纯 CSS，SSR 安全）。缺它则 Controls/MiniMap 失去绝对定位，
// 挤到画布左上角渲染成无样式黑框，点阵网格也不生效——必须导入。
import "@xyflow/react/dist/style.css";
import { Icon } from "@cortex-work/ui/icons";
import type { WorkflowNodeKind, WorkflowNode, WorkflowNodeRunStatus, WorkflowConnection } from "@cortex-work/core";
import { WORKFLOW_NODE_KINDS } from "@cortex-work/core";
import {
  createWorkflowNode,
  flowToWorkflowGraph,
  toFlowEdges,
  toFlowNodes,
  WORKFLOW_PALETTE_GROUPS,
  TRIGGER_KINDS,
  NODE_ICONS,
  type WorkflowFlowNode,
  type WorkflowFlowEdge,
} from "./workflow-flow";

// ── 动态加载的 ReactFlow 和 WorkflowNodes 运行时类型（仅供 ref 存储）─────────

// 动态加载后存入 ref，避免在 SSR 环境下静态引用运行时 API。
type ReactFlowModule = typeof import("@xyflow/react");
type WorkflowNodesModule = typeof import("./WorkflowNodes");

// ── DnD 类型常量 ─────────────────────────────────────────────────────────────
const DND_MIME = "application/x-workflow-node";

// ── Props ────────────────────────────────────────────────────────────────────

export type WorkflowCanvasProps = {
  /** 当前工作流的节点列表（受控）。 */
  nodes: WorkflowNode[];
  /** 当前工作流的连接列表（受控）。 */
  connections: WorkflowConnection[];
  /** 节点运行状态（画布中节点展示 running/success/error 视觉反馈）。 */
  runStatus: Record<string, WorkflowNodeRunStatus>;
  /** 画布变更回调：nodes/connections 更新时触发，调用方维护受控状态。 */
  onChange: (nodes: WorkflowNode[], connections: WorkflowConnection[]) => void;
  /** 节点被点击选中时的回调。 */
  onSelectNode: (nodeId: string | null) => void;
  /** 当前选中节点 id（null = 无选中）。 */
  selectedNodeId: string | null;
  /** 节点操作回调（上下文菜单或节点工具栏触发）。 */
  onRunNode: (nodeId: string) => void;
  onToggleDisabled: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
};

// ── WorkflowCanvas ────────────────────────────────────────────────────────────

/**
 * 工作流可视化画布，封装 @xyflow/react。
 * SSR 安全：@xyflow/react 及 WorkflowNodes 通过 useEffect 动态加载，
 * 加载完成前展示骨架占位。
 */
export function WorkflowCanvas({
  nodes,
  connections,
  runStatus,
  onChange,
  onSelectNode,
  selectedNodeId,
  onRunNode,
  onToggleDisabled,
  onDeleteNode,
}: WorkflowCanvasProps) {
  // 容器 ref（动态加载后 ReactFlow 挂载到此 div）
  const containerRef = useRef<HTMLDivElement>(null);

  // 动态加载的模块缓存（避免重复 import）
  const rfModRef = useRef<ReactFlowModule | null>(null);
  const nodesModRef = useRef<WorkflowNodesModule | null>(null);

  // 动态加载后用于强制刷新的 state
  const [loaded, setLoaded] = useState(false);

  // RF 受控状态（本地持有，通过 onChange 同步给父组件）
  const [rfNodes, setRfNodes] = useState<WorkflowFlowNode[]>(() => toFlowNodes(nodes));
  const [rfEdges, setRfEdges] = useState<WorkflowFlowEdge[]>(() => toFlowEdges(connections));

  // 外部 nodes/connections 变更时同步（编辑器保存或运行状态刷新时）
  const prevNodesRef = useRef(nodes);
  const prevConnsRef = useRef(connections);
  useEffect(() => {
    // 仅在引用变化时同步，防止 onChange 引起的无限循环
    if (nodes !== prevNodesRef.current) {
      prevNodesRef.current = nodes;
      setRfNodes(toFlowNodes(nodes));
    }
    if (connections !== prevConnsRef.current) {
      prevConnsRef.current = connections;
      setRfEdges(toFlowEdges(connections, runStatus));
    }
  }, [nodes, connections, runStatus]);

  // 运行状态变化时刷新边动画（不重置节点位置）
  useEffect(() => {
    setRfEdges((prev) => {
      const { connections: conns } = flowToWorkflowGraph(rfNodes, prev);
      return toFlowEdges(conns, runStatus);
    });
    // rfNodes 仅读位置，不需要加入 dep（防止循环）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatus]);

  // 从 flow 状态同步回父组件
  const notifyChange = useCallback(
    (nextNodes: WorkflowFlowNode[], nextEdges: WorkflowFlowEdge[]) => {
      const { nodes: wfNodes, connections: wfConns } = flowToWorkflowGraph(nextNodes, nextEdges);
      onChange(wfNodes, wfConns);
    },
    [onChange],
  );

  // 连接拖拽起点 ref（拖拽到画布空白处展示「添加节点」菜单，与 Kun onConnectEnd 对齐）
  const connectingRef = useRef<{ nodeId: string; handleId: string } | null>(null);

  // 「拖到空白处后添加节点」快捷菜单 state
  const [connectMenu, setConnectMenu] = useState<{
    x: number;
    y: number;
    sourceId: string;
    sourceHandle: string;
    screenPos: { x: number; y: number };
  } | null>(null);

  // ── 动态加载 @xyflow/react + WorkflowNodes ────────────────────────────────

  useEffect(() => {
    if (rfModRef.current) return; // 已加载，跳过
    void (async () => {
      const [rfMod, nodesMod] = await Promise.all([
        import("@xyflow/react"),
        import("./WorkflowNodes"),
      ]);
      rfModRef.current = rfMod;
      nodesModRef.current = nodesMod;
      setLoaded(true);
    })();
  }, []);

  // ── DnD：从左侧 palette 拖入节点 ─────────────────────────────────────────

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData(DND_MIME) as WorkflowNodeKind;
      if (!kind || !WORKFLOW_NODE_KINDS.includes(kind)) return;
      const rfMod = rfModRef.current;
      if (!rfMod) return;

      // 将屏幕坐标转换为 flow 坐标（如有 ReactFlow 实例）
      // 无法直接访问 useReactFlow()（hooks 只能在 RF 内调用），
      // 因此降级用容器 boundingRect 估算（误差可接受；U6 正式落地后可用 project API 精确化）
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      // 简单估算：偏移量 - 容器左上角，再除以画布缩放（初始 1.0）
      const position = { x: e.clientX - rect.left - 80, y: e.clientY - rect.top - 20 };
      const newNode = createWorkflowNode(kind, position);
      setRfNodes((prev) => {
        const next = [
          ...prev,
          { id: newNode.id, type: newNode.type, position: newNode.position, data: { node: newNode } },
        ] as WorkflowFlowNode[];
        notifyChange(next, rfEdges);
        return next;
      });
    },
    [notifyChange, rfEdges],
  );

  // ── 仅 ReactFlow 加载完才渲染真实画布 ───────────────────────────────────

  if (!loaded || !rfModRef.current || !nodesModRef.current) {
    // 加载前展示最小骨架（不阻断父组件渲染）
    return (
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center bg-ds-main"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <div className="flex flex-col items-center gap-2 text-ds-faint">
          <Icon.MousePointer size={24} sw={1.4} />
          <span className="text-[12px]">画布加载中…</span>
        </div>
      </div>
    );
  }

  // 解构动态加载的运行时
  const rfMod = rfModRef.current;
  const nodesMod = nodesModRef.current;

  // 只取必要字段（ReactFlow/Background 等在 ReactFlowInner 内使用）
  const {
    ReactFlowProvider,
    addEdge,
    applyNodeChanges,
    applyEdgeChanges,
  } = rfMod;

  const {
    workflowNodeTypes,
    WorkflowRunStatusContext,
    WorkflowNodeActionsContext,
  } = nodesMod;

  // 节点操作（由 context 传入每个节点组件）
  const nodeActions = {
    runNode: onRunNode,
    toggleDisabled: onToggleDisabled,
    deleteNode: (nodeId: string) => {
      setRfNodes((prev) => {
        const next = prev.filter((n) => n.id !== nodeId);
        setRfEdges((edges) => {
          const nextEdges = edges.filter((e) => e.source !== nodeId && e.target !== nodeId) as WorkflowFlowEdge[];
          notifyChange(next, nextEdges);
          return nextEdges;
        });
        return next;
      });
      onDeleteNode(nodeId);
    },
  };

  // 带 styled edges（运行状态动画）
  const styledEdges = toFlowEdges(
    flowToWorkflowGraph(rfNodes, rfEdges).connections,
    runStatus,
  );

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <WorkflowRunStatusContext.Provider value={runStatus}>
        <WorkflowNodeActionsContext.Provider value={nodeActions}>
          <ReactFlowProvider>
            <ReactFlowInner
              rfNodes={rfNodes}
              rfEdges={styledEdges}
              workflowNodeTypes={workflowNodeTypes}
              rfMod={rfMod}
              selectedNodeId={selectedNodeId}
              connectingRef={connectingRef}
              connectMenu={connectMenu}
              setConnectMenu={setConnectMenu}
              onSelectNode={onSelectNode}
              onNodesChangeExternal={(changes) => {
                setRfNodes((prev) => {
                  const next = applyNodeChanges(changes, prev) as WorkflowFlowNode[];
                  if (changes.some((c) => c.type !== "select" && c.type !== "dimensions")) {
                    notifyChange(next, rfEdges);
                  }
                  return next;
                });
              }}
              onEdgesChangeExternal={(changes) => {
                setRfEdges((prev) => {
                  const next = applyEdgeChanges(changes, prev) as WorkflowFlowEdge[];
                  if (changes.some((c) => c.type !== "select")) {
                    notifyChange(rfNodes, next);
                  }
                  return next;
                });
              }}
              onConnectExternal={(conn) => {
                setRfEdges((prev) => {
                  const next = addEdge(conn, prev) as WorkflowFlowEdge[];
                  notifyChange(rfNodes, next);
                  return next;
                });
              }}
              addConnectedNode={(kind) => {
                if (!connectMenu) return;
                const newNode = createWorkflowNode(kind, { x: connectMenu.screenPos.x, y: connectMenu.screenPos.y });
                const rfNode: WorkflowFlowNode = {
                  id: newNode.id,
                  type: newNode.type,
                  position: newNode.position,
                  data: { node: newNode },
                };
                setRfNodes((prev) => {
                  const next = [...prev, rfNode] as WorkflowFlowNode[];
                  setRfEdges((edges) => {
                    const next2 = addEdge(
                      {
                        source: connectMenu.sourceId,
                        sourceHandle: connectMenu.sourceHandle,
                        target: newNode.id,
                        targetHandle: "in",
                      },
                      edges,
                    ) as WorkflowFlowEdge[];
                    notifyChange(next, next2);
                    return next2;
                  });
                  return next;
                });
                onSelectNode(newNode.id);
                setConnectMenu(null);
              }}
            />
          </ReactFlowProvider>
        </WorkflowNodeActionsContext.Provider>
      </WorkflowRunStatusContext.Provider>

      {rfNodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <Icon.MousePointer size={32} sw={1.4} className="text-ds-faint" />
          <p className="text-[13px] text-ds-faint">
            将节点拖入画布，或从左侧面板点击添加
          </p>
        </div>
      ) : null}

      {/* 拖拽连线到空白处后弹出的「添加节点」快捷菜单 */}
      {connectMenu ? (
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setConnectMenu(null)} />
          <div
            className="fixed z-[71] max-h-[60vh] w-44 overflow-y-auto rounded-lg border border-ds-border bg-ds-card p-1 shadow-lg"
            style={{ left: connectMenu.x, top: connectMenu.y }}
          >
            {WORKFLOW_PALETTE_GROUPS.map((group) => {
              const kinds = group.kinds.filter((k) => !TRIGGER_KINDS.has(k));
              if (kinds.length === 0) return null;
              const groupLabels: Record<string, string> = {
                trigger: "触发器",
                ai: "AI",
                flow: "流程控制",
                data: "数据处理",
                action: "动作",
              };
              return (
                <div key={group.id}>
                  <div className="px-2 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-ds-faint">
                    {groupLabels[group.id] ?? group.id}
                  </div>
                  {kinds.map((kind) => {
                    const nodeLabels: Record<string, string> = {
                      "ai-agent": "AI 智能体",
                      "generate-image": "生成图片",
                      "parameter-extractor": "参数提取",
                      condition: "条件",
                      switch: "分支",
                      "question-classifier": "问题分类",
                      filter: "过滤",
                      merge: "合并",
                      loop: "循环",
                      "human-approval": "人工审批",
                      "set-fields": "设置字段",
                      template: "模板",
                      json: "JSON",
                      code: "代码",
                      sort: "排序",
                      limit: "限制",
                      aggregate: "聚合",
                      "http-request": "HTTP 请求",
                      subworkflow: "子工作流",
                      delay: "延迟",
                      output: "输出",
                    };
                    return (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => {
                          setConnectMenu((m) => {
                            if (!m) return null;
                            const newNode = createWorkflowNode(kind, m.screenPos);
                            setRfNodes((prev) => {
                              const next = [
                                ...prev,
                                { id: newNode.id, type: newNode.type, position: newNode.position, data: { node: newNode } } as WorkflowFlowNode,
                              ];
                              setRfEdges((edges) => {
                                const nextEdges = addEdge(
                                  { source: m.sourceId, sourceHandle: m.sourceHandle, target: newNode.id, targetHandle: "in" },
                                  edges,
                                ) as WorkflowFlowEdge[];
                                notifyChange(next, nextEdges);
                                return nextEdges;
                              });
                              return next;
                            });
                            onSelectNode(newNode.id);
                            return null;
                          });
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ds-ink transition hover:bg-ds-hover"
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-accent">
                          {(() => {
                            const NodeIcon = NODE_ICONS[kind];
                            return NodeIcon ? <NodeIcon size={13} sw={1.8} /> : null;
                          })()}
                        </span>
                        {nodeLabels[kind] ?? kind}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── ReactFlowInner：必须在 ReactFlowProvider 内调用 useReactFlow ──────────────

type InnerProps = {
  rfNodes: WorkflowFlowNode[];
  rfEdges: WorkflowFlowEdge[];
  workflowNodeTypes: Record<string, unknown>;
  rfMod: ReactFlowModule;
  selectedNodeId: string | null;
  connectingRef: React.MutableRefObject<{ nodeId: string; handleId: string } | null>;
  connectMenu: { x: number; y: number; sourceId: string; sourceHandle: string; screenPos: { x: number; y: number } } | null;
  setConnectMenu: React.Dispatch<
    React.SetStateAction<{
      x: number;
      y: number;
      sourceId: string;
      sourceHandle: string;
      screenPos: { x: number; y: number };
    } | null>
  >;
  onSelectNode: (id: string | null) => void;
  onNodesChangeExternal: (changes: ReturnType<ReactFlowModule["applyNodeChanges"]> extends never[] ? never : Parameters<ReactFlowModule["applyNodeChanges"]>[0]) => void;
  onEdgesChangeExternal: (changes: Parameters<ReactFlowModule["applyEdgeChanges"]>[0]) => void;
  onConnectExternal: (conn: Parameters<ReactFlowModule["addEdge"]>[0]) => void;
  addConnectedNode: (kind: WorkflowNodeKind) => void;
};

function ReactFlowInner({
  rfNodes,
  rfEdges,
  workflowNodeTypes,
  rfMod,
  selectedNodeId: _selectedNodeId,
  connectingRef,
  setConnectMenu,
  onSelectNode,
  onNodesChangeExternal,
  onEdgesChangeExternal,
  onConnectExternal,
}: InnerProps) {
  const {
    ReactFlow,
    Background,
    BackgroundVariant,
    Controls,
    MiniMap,
    useReactFlow,
  } = rfMod;

  const { screenToFlowPosition } = useReactFlow();

  const onConnectStart = useCallback(
    (_: unknown, params: { nodeId?: string | null; handleId?: string | null }) => {
      connectingRef.current =
        params.nodeId ? { nodeId: params.nodeId, handleId: params.handleId ?? "out" } : null;
    },
    [connectingRef],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const source = connectingRef.current;
      connectingRef.current = null;
      if (!source) return;
      const target = (event.target as HTMLElement | null);
      if (!target?.classList.contains("react-flow__pane")) return;
      const clientX = "clientX" in event ? event.clientX : 0;
      const clientY = "clientY" in event ? event.clientY : 0;
      setConnectMenu({
        x: clientX,
        y: clientY,
        sourceId: source.nodeId,
        sourceHandle: source.handleId,
        screenPos: screenToFlowPosition({ x: clientX, y: clientY }),
      });
    },
    [connectingRef, setConnectMenu, screenToFlowPosition],
  );

  return (
    <ReactFlow
      className="ds-workflow-canvas"
      nodes={rfNodes}
      edges={rfEdges}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodeTypes={workflowNodeTypes as any}
      onNodesChange={onNodesChangeExternal as never}
      onEdgesChange={onEdgesChangeExternal as never}
      onConnect={onConnectExternal as never}
      onConnectStart={onConnectStart as never}
      onConnectEnd={onConnectEnd as never}
      onNodeClick={(_: unknown, node: { id: string }) => onSelectNode(node.id)}
      onPaneClick={() => onSelectNode(null)}
      fitView
      fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        className="ds-workflow-minimap"
        pannable
        zoomable
        style={{ width: 150, height: 96 }}
        nodeColor="var(--accent)"
        nodeStrokeColor="transparent"
        nodeBorderRadius={3}
        maskColor="rgb(15 23 42 / 0.08)"
      />
    </ReactFlow>
  );
}
