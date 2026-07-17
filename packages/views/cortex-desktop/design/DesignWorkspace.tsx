// 设计工作台容器：cortex 侧对 Kun「workbench design 路由」的对等物。
// 组装左(DesignSidebar 设计稿树) / 中(DesignWorkspaceView 画布) / 右(DesignAIRail 设计对话),
// 并在挂载时装配 design 运行时(startCli 管线 + 文件系统端口 + designUi 存储)。
// 设计回合的派发/流式/取消全部经 core 的 design-run-manager,不触碰个人会话管线。
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useDesktopBridge } from "@cortex-work/core/provider";
import { usePersonalStore, resolveDefaultAgent } from "@cortex-work/core/store/personal";
import type { AgentKind } from "@cortex-work/core";
import { buildDesignAgentSwitchPatch } from "@cortex-work/core/design/compat/app-settings";
import {
  cancelActiveDesignRuns,
  installDesignRuntime,
  sendDesignMessage,
} from "@cortex-work/core/design/run/design-run-manager";
import { buildSlidesTurnPrompt } from "@cortex-work/core/design/slides/slides-prompt";
import { useSlidesStore } from "./slides/slides-store";
import { implementDesignInProject } from "@cortex-work/core/design/run/design-implement";
import { useChatStore } from "@cortex-work/core/design/compat/chat-store";
import { useCanvasShapeStore } from "@cortex-work/core/design/canvas/canvas-shape-store";
import { useCanvasSelectionStore } from "@cortex-work/core/design/canvas/canvas-selection-store";
import { useDesignWorkspaceStore } from "@cortex-work/core/design/design-workspace-store";
import { designDocumentKind, type DesignArtifact } from "@cortex-work/core/design/design-types";
import { DesignAIRail } from "./DesignAIRail";
import { DesignSidebar } from "./DesignSidebar";
import { DesignWorkspaceView } from "./DesignWorkspaceView";
import { useDesignComposerContextState } from "./useDesignComposerContextState";
import { useDesignPromptController } from "./useDesignPromptController";
import type { ComposerReasoningEffort } from "./compat/FloatingComposerModelPicker";

/**
 * 右栏发送的路由决策(纯函数,便于测试)。
 *
 * slides 稿必须绕开 design 的 prompt 路由:那条路会过 multi-page 闸门,把一句话展开成
 * 自由画布流水线(设计规格 → 设计系统与令牌 → 品牌标识 → 并行多页),产物落在
 * `.cortex-design/<doc>/` 的自由画布里,与 deck.json / slot HTML 无关、也不会出现在
 * 缩略图栏(用户实测踩到)。slides 走 buildSlidesTurnPrompt 的合同回合。
 */
export function routeDesignComposerSend(options: {
  input: string;
  slidesMode: boolean;
}): { kind: "ignore" } | { kind: "design-prompt" } | { kind: "slides-turn"; text: string } {
  const text = options.input.trim();
  if (!text) return { kind: "ignore" };
  return options.slidesMode ? { kind: "slides-turn", text } : { kind: "design-prompt" };
}

export function DesignWorkspace(): ReactElement {
  const bridge = useDesktopBridge();
  const closeDesign = usePersonalStore((s) => s.closeDesign);
  const openSettings = usePersonalStore((s) => s.openSettings);
  const designSettings = usePersonalStore((s) => s.designSettings);
  const projects = usePersonalStore((s) => s.projects);
  const addProject = usePersonalStore((s) => s.addProject);
  // 设计助手栏 agent 选择器所需的状态与 setter（provider/general/探测结果/落盘）。
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const generalSettings = usePersonalStore((s) => s.generalSettings);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const derivedAgents = usePersonalStore((s) => s.derivedAgents);
  const setDesignSettings = usePersonalStore((s) => s.setDesignSettings);
  const setAgentsAvailable = usePersonalStore((s) => s.setAgentsAvailable);
  const setDerivedAgents = usePersonalStore((s) => s.setDerivedAgents);

  const setDesignWorkspaceRoot = useDesignWorkspaceStore((s) => s.setWorkspaceRoot);
  const loadDesignSettings = useDesignWorkspaceStore((s) => s.loadDesignSettings);

  // 挂载引导:装配运行时 → 解析设计工作区根(设置值优先,否则默认 Documents/cortex/design)
  // → 同步进 design store 的 workspaceRoot(画布 board 加载依赖它,否则卡在 Loading)
  // → loadDesignSettings 把 settingsLoaded 置真。顺序关键:root 必须先于 board 加载就位。
  useEffect(() => {
    installDesignRuntime(bridge);
    void (async () => {
      const st = usePersonalStore.getState();
      let root = st.designSettings.defaultWorkspaceRoot;
      if (!root && bridge?.designWorkspaceRoot) {
        try {
          root = await bridge.designWorkspaceRoot();
          st.setDesignSettings({ defaultWorkspaceRoot: root });
        } catch {
          /* 拿不到默认根:留空,发送时再兜底提示 */
        }
      }
      if (root) setDesignWorkspaceRoot(root);
      await loadDesignSettings();
    })();
  }, [bridge, setDesignWorkspaceRoot, loadDesignSettings]);

  // composer 本地态(输入/模式/模型档位)。模型缺省沿用设计设置。
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"plan" | "agent">("agent");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composerModel, setComposerModel] = useState(designSettings.model);
  const [composerReasoningEffort, setComposerReasoningEffort] =
    useState<ComposerReasoningEffort>("auto");

  // 设计助手栏当前显示的 base agent：显式选择优先,未选择则跟随系统「新会话默认 Agent」。
  const displayAgent: AgentKind =
    (designSettings.agent as AgentKind) || resolveDefaultAgent({ generalSettings, agentsAvailable });
  // 切 agent:落 designSettings 的联动 patch(pi 配齐 provider+model、其余清空),同步 composer 模型显示。
  const onSwitchAgent = (agent: AgentKind, derived?: Parameters<typeof buildDesignAgentSwitchPatch>[2]): void => {
    const patch = buildDesignAgentSwitchPatch(agent, providerSettings, derived);
    setDesignSettings(patch);
    setComposerModel(patch.model ?? "");
  };

  // 兜底探测已安装 agent 与用户派生 agent(bridge 具备时),回填 store 供选择器门控/展示。
  // 主窗口个人工作区通常已探测,这里仅补齐设计模式独立入口(直接进设计台)时缺失的情况。
  useEffect(() => {
    bridge?.detectAgents?.().then(setAgentsAvailable).catch(() => {});
    bridge?.listAgentProfiles?.().then(setDerivedAgents).catch(() => {});
  }, [bridge, setAgentsAvailable, setDerivedAgents]);

  // 设计对话镜像(design-run-manager 折叠 CliStreamEvent 写入)。
  const busy = useChatStore((s) => s.busy);
  const blocks = useChatStore((s) => s.blocks);
  const liveAssistant = useChatStore((s) => s.liveAssistant);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  // 设计会话线程(由 sendDesignMessage 注册);DesignAIRail 用它 gate 消息渲染,不能传空数组。
  const designThreads = useChatStore((s) => s.threads);

  const assistantOpen = useDesignWorkspaceStore((s) => s.canvasAssistantOpen);
  const setAssistantOpen = useDesignWorkspaceStore((s) => s.setCanvasAssistantOpen);
  const workspaceRoot = useDesignWorkspaceStore((s) => s.workspaceRoot);
  const activeDocumentId = useDesignWorkspaceStore((s) => s.activeDocumentId);
  const documents = useDesignWorkspaceStore((s) => s.documents);
  // 右栏与中间区域共享同一会话管线,但 slides 设计稿的上下文语义不同(见 DesignAIRail.slidesMode)。
  const activeDoc = documents.find((d) => d.id === activeDocumentId) ?? null;
  const slidesMode = activeDoc ? designDocumentKind(activeDoc) === "slides" : false;
  // deck 状态决定本轮该做什么(主题/提纲/逐页生成);未加载时按 draft。
  const slidesStatus = useSlidesStore((s) => s.manifest?.status);
  const slidesThemeName = useSlidesStore((s) => s.manifest?.theme.name);

  const handleSend = (): void => {
    const decision = routeDesignComposerSend({ input, slidesMode });
    if (decision.kind === "ignore") return;
    if (decision.kind === "design-prompt") {
      void promptController.sendDesignPrompt(input);
      return;
    }
    setInput("");
    // 舞台选区(用户点选元素后发话):并入本轮上下文,让 Agent 只精准调整所选。
    // 从 getState 取而非订阅:发送瞬间的快照即可,不需要因选区变化重渲染本组件。
    const slidesState = useSlidesStore.getState();
    const stageSelection = slidesState.stageSelection;
    const slotOrder = slidesState.manifest
      ? [...slidesState.manifest.slides].sort((a, b) => a.order - b.order).map((s) => s.id)
      : [];
    const selection =
      stageSelection && stageSelection.items.length > 0
        ? {
            slotId: stageSelection.slotId,
            slideIndex:
              slotOrder.indexOf(stageSelection.slotId) >= 0 ? slotOrder.indexOf(stageSelection.slotId) + 1 : undefined,
            items: stageSelection.items.map((item) => ({
              id: item.elementId,
              tag: item.tagName,
              text: item.text || undefined,
            })),
          }
        : undefined;
    void sendDesignMessage(
      buildSlidesTurnPrompt({ text: decision.text, stage: slidesStatus, themeName: slidesThemeName, selection }),
      "agent",
      { displayText: decision.text },
    );
  };
  const canvasDocument = useCanvasShapeStore((s) => s.document);
  const selectedIds = useCanvasSelectionStore((s) => s.selectedIds);

  // 每个设计稿是独立会话(sessionId=design-<docId>)。切换/新建/删除后落到不同设计稿时,
  // 清空聊天镜像——否则上一稿的对话消息会跨稿累积在右侧面板。仅当镜像已绑定到别的
  // 设计稿会话时才清(初次挂载 activeThreadId 为空,不误清)。
  useEffect(() => {
    if (!activeDocumentId) return;
    const wantThread = `design-${activeDocumentId}`;
    const cur = useChatStore.getState().activeThreadId;
    if (cur && cur !== wantThread) useChatStore.getState().resetMirror();
  }, [activeDocumentId]);

  const contextState = useDesignComposerContextState({
    route: "design",
    canvasDocument,
    selectedIds,
    setInput,
  });

  const runtimeConnection = bridge ? "ready" : "offline";

  const promptController = useDesignPromptController({
    route: "design",
    runtimeConnection,
    busy,
    workspaceRoot,
    composerAttachments: [],
    // v1 附件上传未接线(bridge 无剪贴板图片对等能力),入口降级隐藏。
    attachmentUploadEnabled: false,
    composerReasoningEffort,
    composerModelGroups: [],
    designContextSuppressedIds: contextState.designContextSuppressedIds,
    designHtmlElementContext: contextState.designHtmlElementContext,
    setInput,
    setAttachmentUploadError: () => {},
    setError,
    setDesignAssistantOpen: setAssistantOpen,
    // 线程 = design-<docId> 逻辑会话(chat:load/save 命名空间),无需真正"创建"。
    ensureDesignThreadForWorkspace: async (_root, docId) => `design-${docId}`,
    sendMessage: sendDesignMessage,
    getAttachmentScope: () => "design",
    clearComposerAttachments: () => {},
    clearHtmlElementContext: () => contextState.handleDesignHtmlElementAsContext(null),
  });

  // 「用代码实现」:选目标项目(单项目直接用/多项目取活跃或第一个/无项目则 pickDirectory
  // 顺手注册),把设计产物拷进项目并经 SpotlightIntent handoff 起实现会话。
  const onImplementDesign = useMemo(
    () => async (artifact: DesignArtifact) => {
      if (!bridge) {
        setError("用代码实现需要桌面端环境");
        return;
      }
      const activeProjectId = usePersonalStore.getState().activeProjectId;
      let project =
        projects.find((p) => p.id === activeProjectId && !p.archivedAt) ??
        projects.find((p) => !p.archivedAt);
      if (!project) {
        // 无可用项目:让用户选一个文件夹作为实现目标并注册为项目。
        const dir = await bridge.pickDirectory();
        if (!dir) return;
        project = addProject(dir);
      }
      const result = await implementDesignInProject({ bridge, artifact, project });
      if (!result.ok) setError(result.error);
      // 成功时 closeDesign 已在函数内触发,handoff 会切到实现会话。
    },
    [bridge, projects, addProject],
  );

  return (
    // 设计模式整窗接管:fixed 覆盖层盖住个人工作区侧栏,自成左(设计稿树)/中(画布)/右(对话)三栏。
    <div className="fixed inset-0 z-40 flex min-h-0 min-w-0 overflow-hidden bg-ds-main">
      {/* 左栏固定宽度(DesignSidebar 内部是 w-full,需外层约束,否则铺满挤没画布)。
          红绿灯避让由 SidebarFrame 自带的 titlebar spacer 负责,这里不再额外 pt
          (否则双重预留导致顶部留白过大);外层仅作拖拽区(ds-drag)。 */}
      {leftCollapsed ? null : (
        // relative z-10:让右缘阴影盖在中间区之上(否则被后绘制的兄弟节点遮住),强化侧栏与文档区的层级
        <div className="ds-drag relative z-10 grid min-h-0 w-[260px] shrink-0 bg-ds-sidebar shadow-[1px_0_0_rgba(0,0,0,0.06),6px_0_16px_rgba(0,0,0,0.05)] dark:shadow-[1px_0_0_rgba(255,255,255,0.07),6px_0_16px_rgba(0,0,0,0.45)]">
          <div className="ds-no-drag grid min-h-0 overflow-hidden">
            <DesignSidebar
              onCodeOpen={closeDesign}
              onWriteOpen={closeDesign}
              onDesignOpen={() => {}}
              onOpenSettings={() => openSettings("design")}
              // 选中文稿后自动折叠左侧栏,聚焦设计/演示核心区(工具栏的折叠按钮可随时展开)
              onDocumentSelected={() => setLeftCollapsed(true)}
              // cortex 的主题由宿主壳统一管理;这里沿用 Kun 语义翻转 data-theme,
              // DesignSidebar 自带 MutationObserver 会同步图标态。
              onToggleTheme={() => {
                const el = document.documentElement;
                el.setAttribute("data-theme", el.getAttribute("data-theme") === "dark" ? "light" : "dark");
              }}
            />
          </div>
        </div>
      )}
      <DesignWorkspaceView
        leftSidebarCollapsed={leftCollapsed}
        onToggleLeftSidebar={() => setLeftCollapsed((v) => !v)}
        busy={busy}
        onOpenAgentSettings={() => openSettings("design")}
        onImplementDesign={onImplementDesign}
        onUseElementAsContext={contextState.handleDesignHtmlElementAsContext}
        onRuntimeQualityFindings={promptController.handleDesignRuntimeQualityFindings}
        onRequestQualityRepair={promptController.handleDesignQualityRepairRequest}
      />
      {/* 右栏(设计对话)固定宽度;DesignAIRail 内部 aside 无宽度,需外层约束。 */}
      {assistantOpen ? (
        <div className="grid min-h-0 w-[360px] shrink-0">
        <DesignAIRail
          input={input}
          setInput={setInput}
          mode={mode}
          setMode={setMode}
          busy={busy}
          runtimeConnection={runtimeConnection}
          activeThreadId={activeThreadId}
          blocks={blocks}
          liveReasoning=""
          liveAssistant={liveAssistant}
          composerModel={composerModel}
          composerPickList={composerModel ? [composerModel] : []}
          composerReasoningEffort={composerReasoningEffort}
          setComposerModel={(modelId) => setComposerModel(modelId)}
          setComposerReasoningEffort={setComposerReasoningEffort}
          queuedMessages={[]}
          removeQueuedMessage={() => {}}
          onSend={handleSend}
          onInterrupt={() => void cancelActiveDesignRuns()}
          onRetryConnection={() => installDesignRuntime(bridge)}
          onOpenSettings={() => openSettings("design")}
          onNewConversation={() => useChatStore.getState().resetMirror()}
          designThreads={designThreads}
          onSwitchThread={() => {}}
          onCollapse={() => setAssistantOpen(false)}
          slidesMode={slidesMode}
          designAgent={displayAgent}
          designDerivedAgentId={designSettings.derivedAgentId || undefined}
          agentsAvailable={agentsAvailable}
          derivedAgents={derivedAgents}
          onSwitchAgent={onSwitchAgent}
        />
        </div>
      ) : null}
      {error ? (
        <div className="absolute bottom-3 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#c0392b] px-3 py-1.5 text-xs text-white shadow-lg">
          <button type="button" onClick={() => setError(null)}>
            {error}
          </button>
        </div>
      ) : null}
      {/* 记录活跃设计稿供重进恢复(activeDesignDocId 持久化于导航 store) */}
      <DesignDocTracker activeDocumentId={activeDocumentId} />
    </div>
  );
}

// 把 design store 的活跃文档同步到导航 store(仅在变化时写,避免渲染循环)。
function DesignDocTracker({ activeDocumentId }: { activeDocumentId: string | null }): null {
  useEffect(() => {
    if (!activeDocumentId) return;
    const s = usePersonalStore.getState();
    if (s.activeDesignDocId !== activeDocumentId) {
      usePersonalStore.setState({ activeDesignDocId: activeDocumentId });
    }
  }, [activeDocumentId]);
  return null;
}
