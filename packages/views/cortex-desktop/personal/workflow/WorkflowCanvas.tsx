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

import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
// ReactFlow 基础样式表（纯 CSS，SSR 安全）。缺它则 Controls/MiniMap 失去绝对定位，
// 挤到画布左上角渲染成无样式黑框，点阵网格也不生效——必须导入。
import "@xyflow/react/dist/style.css";
import { Icon } from "@cortex-work/ui/icons";
import type {
  WorkflowNodeKind,
  WorkflowNode,
  WorkflowNodeRunStatus,
  WorkflowConnection,
} from "@cortex-work/core";
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
import { WorkflowCanvasContextMenu } from "./WorkflowCanvasContextMenu";

// 画布右键菜单 state：空白处=添加便签(带落点流坐标)；便签节点=改色/删除(带 nodeId)。
type StickyMenuState =
  | { mode: "add"; x: number; y: number; flowPos: { x: number; y: number } }
  | { mode: "node"; x: number; y: number; nodeId: string };

// ── 动态加载的 ReactFlow 和 WorkflowNodes 运行时类型（仅供 ref 存储）─────────

// 动态加载后存入 ref，避免在 SSR 环境下静态引用运行时 API。
type ReactFlowModule = typeof import("@xyflow/react");
type WorkflowNodesModule = typeof import("./WorkflowNodes");

// ── DnD 类型常量 ─────────────────────────────────────────────────────────────
const DND_MIME = "application/x-workflow-node";

// 功能节点卡片的近似半宽/半高（卡片 w-[216px]），用于把「落点」换算成节点左上角，
// 让新节点的视觉中心对准落点，而不是左上角贴在落点上。
const NODE_HALF_W = 108;
const NODE_HALF_H = 28;

type ScreenToFlow = (p: { x: number; y: number }) => { x: number; y: number };

/** 画布对外暴露的命令式接口（供左侧节点面板「点击添加」取落点）。 */
export type WorkflowCanvasApi = {
  /**
   * 返回「用户当前看到的画布区域」中心、并已减去节点半尺寸的流坐标（可直接作为节点 position）。
   * 画布未加载完（拿不到 screenToFlowPosition）时返回 null，调用方自行兜底。
   */
  getViewportCenterPosition: () => { x: number; y: number } | null;
};

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
  /** 画布内节点编辑回调（便签双击改文本/改色），与右面板 onNodeChange 同语义。 */
  onNodeChange: (node: WorkflowNode) => void;
  /** 可选：接收画布命令式接口（见 WorkflowCanvasApi）。 */
  apiRef?: React.MutableRefObject<WorkflowCanvasApi | null>;
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
  onNodeChange,
  apiRef,
}: WorkflowCanvasProps) {
  // 容器 ref（动态加载后 ReactFlow 挂载到此 div）
  const containerRef = useRef<HTMLDivElement>(null);

  // screenToFlowPosition 只能在 ReactFlowProvider 内经 useReactFlow 取得，
  // 由 ReactFlowInner 回填到这里，供外层（拖放落点 / apiRef）换算坐标——它已含平移与缩放。
  const screenToFlowRef = useRef<ScreenToFlow | null>(null);

  // 暴露「当前视口中心」：取画布容器可见矩形的中心点（屏幕坐标）再换算成流坐标。
  // 不能用固定坐标——用户平移/缩放后，固定坐标可能落在视口之外，看起来像「节点没加上」。
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      getViewportCenterPosition: () => {
        const toFlow = screenToFlowRef.current;
        const container = containerRef.current;
        if (!toFlow || !container) return null;
        const rect = container.getBoundingClientRect();
        const c = toFlow({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        return { x: c.x - NODE_HALF_W, y: c.y - NODE_HALF_H };
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  // 动态加载的模块缓存（避免重复 import）
  const rfModRef = useRef<ReactFlowModule | null>(null);
  const nodesModRef = useRef<WorkflowNodesModule | null>(null);

  // 动态加载后用于强制刷新的 state
  const [loaded, setLoaded] = useState(false);

  // RF 受控状态（本地持有，通过 onChange 同步给父组件）
  const [rfNodes, setRfNodes] = useState<WorkflowFlowNode[]>(() =>
    toFlowNodes(nodes),
  );
  const [rfEdges, setRfEdges] = useState<WorkflowFlowEdge[]>(() =>
    toFlowEdges(connections),
  );

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
      const { nodes: wfNodes, connections: wfConns } = flowToWorkflowGraph(
        nextNodes,
        nextEdges,
      );
      onChange(wfNodes, wfConns);
    },
    [onChange],
  );

  // 节点操作（经 context 传给每个节点组件）。useMemo 稳定引用——否则每次渲染
  // (含拖动每帧 setRfNodes 触发的重渲染) 都产生新对象，使 NodeActionsContext 的 value
  // 变化，导致所有节点组件重渲染 → 拖动时全画布闪烁。
  const nodeActions = useMemo(
    () => ({
      runNode: onRunNode,
      toggleDisabled: onToggleDisabled,
      deleteNode: (nodeId: string) => {
        setRfNodes((prev) => {
          const next = prev.filter((n) => n.id !== nodeId);
          setRfEdges((edges) => {
            const nextEdges = edges.filter(
              (e) => e.source !== nodeId && e.target !== nodeId,
            ) as WorkflowFlowEdge[];
            notifyChange(next, nextEdges);
            return nextEdges;
          });
          return next;
        });
        onDeleteNode(nodeId);
      },
      // 画布内编辑：替换匹配节点的 data.node（即时反映新文本/颜色）并回写父级。
      updateNode: (updated: WorkflowNode) => {
        setRfNodes((prev) => {
          const next = prev.map((n) =>
            n.id === updated.id
              ? { ...n, data: { ...n.data, node: updated } }
              : n,
          );
          setRfEdges((edges) => {
            notifyChange(next, edges);
            return edges;
          });
          return next;
        });
        onNodeChange(updated);
      },
    }),
    [onRunNode, onToggleDisabled, onDeleteNode, onNodeChange, notifyChange],
  );

  // 带运行状态样式（running 边动画）的边。useMemo 仅依赖 rfEdges/runStatus：
  // 连线关系只来自 rfEdges，节点「位置」变化不改变连线，故拖动时不重建边数组
  // （避免每帧产生新 edges → 边/handle 重绘闪烁）。
  const styledEdges = useMemo(
    () =>
      toFlowEdges(flowToWorkflowGraph(rfNodes, rfEdges).connections, runStatus),
    // rfNodes 仅供 flowToWorkflowGraph 的节点部分（被丢弃），连线只取自 rfEdges。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rfEdges, runStatus],
  );

  // 连接拖拽起点 ref（拖拽到画布空白处展示「添加节点」菜单，与 Kun onConnectEnd 对齐）
  const connectingRef = useRef<{ nodeId: string; handleId: string } | null>(
    null,
  );

  // 「拖到空白处后添加节点」快捷菜单 state
  const [connectMenu, setConnectMenu] = useState<{
    x: number;
    y: number;
    sourceId: string;
    sourceHandle: string;
    screenPos: { x: number; y: number };
  } | null>(null);

  // 画布右键菜单 state（添加便签 / 便签节点改色删除）
  const [stickyMenu, setStickyMenu] = useState<StickyMenuState | null>(null);

  // 在画布落点(流坐标)创建便签并选中。用 toFlowNodes 生成 RF 节点，确保带上
  // 便签所需的顶层 width/height 与 zIndex（见 toFlowNodes）。
  const handleAddSticky = useCallback(
    (flowPos: { x: number; y: number }) => {
      const newNode = createWorkflowNode("sticky-note", flowPos);
      const rfNode = toFlowNodes([newNode])[0]!;
      setRfNodes((prev) => {
        const next = [...prev, rfNode] as WorkflowFlowNode[];
        setRfEdges((edges) => {
          notifyChange(next, edges);
          return edges;
        });
        return next;
      });
      onSelectNode(newNode.id);
    },
    [notifyChange, onSelectNode],
  );

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

      // 落点屏幕坐标 → 流坐标（含平移与缩放），再让节点中心对准鼠标位置。
      const toFlow = screenToFlowRef.current;
      if (!toFlow) return;
      const p = toFlow({ x: e.clientX, y: e.clientY });
      const position = { x: p.x - NODE_HALF_W, y: p.y - NODE_HALF_H };
      const newNode = createWorkflowNode(kind, position);
      setRfNodes((prev) => {
        const next = [
          ...prev,
          {
            id: newNode.id,
            type: newNode.type,
            position: newNode.position,
            data: { node: newNode },
          },
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
        className="absolute inset-0 flex items-center justify-center bg-ds-main"
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
  const { ReactFlowProvider, addEdge, applyNodeChanges, applyEdgeChanges } =
    rfMod;

  const {
    workflowNodeTypes,
    WorkflowRunStatusContext,
    WorkflowNodeActionsContext,
  } = nodesMod;

  return (
    <div
      ref={containerRef}
      // 绝对填充父级（WorkflowEditorView 的 relative min-w-0 flex-1 画布区）。
      // 原 `flex-1` 无效：父级不是 flex 容器，本 div 退化为 block，子元素(ReactFlow/overlay)
      // 又都是 absolute 不撑高 → 高度塌陷为 0 → 画布不显示。父级为 relative 且有确定高度
      // (flex 行 stretch)，故 absolute inset-0 取确定像素高度。
      className="absolute inset-0"
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
              setStickyMenu={setStickyMenu}
              screenToFlowRef={screenToFlowRef}
              onSelectNode={onSelectNode}
              onNodesChangeExternal={(changes) => {
                setRfNodes((prev) => {
                  const next = applyNodeChanges(
                    changes,
                    prev,
                  ) as WorkflowFlowNode[];
                  // 拖动进行中（position 变更且 dragging:true）不回写父级——否则父组件
                  // setState(nodes) → nodes prop 变化 → 同步 effect setRfNodes(toFlowNodes)
                  // 重建全部节点对象，与正在进行的拖动相互覆盖 → 全画布闪烁/抖动。
                  // 只在拖动结束（dragging:false/undefined）或非拖动的结构性变更时回写。
                  const midDrag = changes.some(
                    (c) => c.type === "position" && c.dragging === true,
                  );
                  if (
                    !midDrag &&
                    changes.some(
                      (c) => c.type !== "select" && c.type !== "dimensions",
                    )
                  ) {
                    notifyChange(next, rfEdges);
                  }
                  return next;
                });
              }}
              onEdgesChangeExternal={(changes) => {
                setRfEdges((prev) => {
                  const next = applyEdgeChanges(
                    changes,
                    prev,
                  ) as WorkflowFlowEdge[];
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
                const newNode = createWorkflowNode(kind, {
                  x: connectMenu.screenPos.x,
                  y: connectMenu.screenPos.y,
                });
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
          <div
            className="fixed inset-0 z-[70]"
            onClick={() => setConnectMenu(null)}
          />
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
                            const newNode = createWorkflowNode(
                              kind,
                              m.screenPos,
                            );
                            setRfNodes((prev) => {
                              const next = [
                                ...prev,
                                {
                                  id: newNode.id,
                                  type: newNode.type,
                                  position: newNode.position,
                                  data: { node: newNode },
                                } as WorkflowFlowNode,
                              ];
                              setRfEdges((edges) => {
                                const nextEdges = addEdge(
                                  {
                                    source: m.sourceId,
                                    sourceHandle: m.sourceHandle,
                                    target: newNode.id,
                                    targetHandle: "in",
                                  },
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
                            return NodeIcon ? (
                              <NodeIcon size={13} sw={1.8} />
                            ) : null;
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

      {/* 画布右键菜单：添加便签 / 便签节点改色删除 */}
      {stickyMenu
        ? (() => {
            if (stickyMenu.mode === "add") {
              return (
                <WorkflowCanvasContextMenu
                  x={stickyMenu.x}
                  y={stickyMenu.y}
                  items={[
                    {
                      label: "添加便签",
                      icon: Icon.StickyNote,
                      onSelect: () => handleAddSticky(stickyMenu.flowPos),
                    },
                  ]}
                  onClose={() => setStickyMenu(null)}
                />
              );
            }
            // node 模式：从 rfNodes 取出便签节点，提供改色 + 删除。
            const node = rfNodes.find((n) => n.id === stickyMenu.nodeId)?.data
              .node;
            if (!node || node.type !== "sticky-note") return null;
            return (
              <WorkflowCanvasContextMenu
                x={stickyMenu.x}
                y={stickyMenu.y}
                colorPicker={{
                  current: node.config.color,
                  onPick: (color) =>
                    nodeActions.updateNode({
                      ...node,
                      config: { ...node.config, color },
                    }),
                }}
                items={[
                  {
                    label: "删除便签",
                    icon: Icon.Trash,
                    danger: true,
                    onSelect: () => nodeActions.deleteNode(stickyMenu.nodeId),
                  },
                ]}
                onClose={() => setStickyMenu(null)}
              />
            );
          })()
        : null}
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
  connectingRef: React.MutableRefObject<{
    nodeId: string;
    handleId: string;
  } | null>;
  connectMenu: {
    x: number;
    y: number;
    sourceId: string;
    sourceHandle: string;
    screenPos: { x: number; y: number };
  } | null;
  setConnectMenu: React.Dispatch<
    React.SetStateAction<{
      x: number;
      y: number;
      sourceId: string;
      sourceHandle: string;
      screenPos: { x: number; y: number };
    } | null>
  >;
  setStickyMenu: (m: StickyMenuState | null) => void;
  /** 回填 screenToFlowPosition 给外层（外层不在 ReactFlowProvider 内，拿不到 useReactFlow）。 */
  screenToFlowRef: React.MutableRefObject<ScreenToFlow | null>;
  onSelectNode: (id: string | null) => void;
  onNodesChangeExternal: (
    changes: ReturnType<ReactFlowModule["applyNodeChanges"]> extends never[]
      ? never
      : Parameters<ReactFlowModule["applyNodeChanges"]>[0],
  ) => void;
  onEdgesChangeExternal: (
    changes: Parameters<ReactFlowModule["applyEdgeChanges"]>[0],
  ) => void;
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
  setStickyMenu,
  screenToFlowRef,
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

  useEffect(() => {
    screenToFlowRef.current = screenToFlowPosition;
    return () => {
      screenToFlowRef.current = null;
    };
  }, [screenToFlowRef, screenToFlowPosition]);

  const onConnectStart = useCallback(
    (
      _: unknown,
      params: { nodeId?: string | null; handleId?: string | null },
    ) => {
      connectingRef.current = params.nodeId
        ? { nodeId: params.nodeId, handleId: params.handleId ?? "out" }
        : null;
    },
    [connectingRef],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const source = connectingRef.current;
      connectingRef.current = null;
      if (!source) return;
      const target = event.target as HTMLElement | null;
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
      // 画布空白处右键 → 添加便签菜单（落点转流坐标）
      onPaneContextMenu={((e: MouseEvent) => {
        e.preventDefault();
        setStickyMenu({
          mode: "add",
          x: e.clientX,
          y: e.clientY,
          flowPos: screenToFlowPosition({ x: e.clientX, y: e.clientY }),
        });
      }) as never}
      // 便签节点右键 → 改色/删除菜单（仅便签，功能节点不拦截默认）
      onNodeContextMenu={((
        e: React.MouseEvent,
        node: { id: string; type?: string },
      ) => {
        if (node.type !== "sticky-note") return;
        e.preventDefault();
        setStickyMenu({
          mode: "node",
          x: e.clientX,
          y: e.clientY,
          nodeId: node.id,
        });
      }) as never}
      fitView
      fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      {/* 默认缩放控件（左下角 + / − / 适应）+ 右下角缩略图 MiniMap */}
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
