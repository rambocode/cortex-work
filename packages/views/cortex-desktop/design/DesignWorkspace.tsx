// 设计工作台容器：cortex 侧对 Kun「workbench design 路由」的对等物。
// 组装左(DesignSidebar 设计稿树) / 中(DesignWorkspaceView 画布) / 右(DesignAIRail 设计对话),
// 并在挂载时装配 design 运行时(startCli 管线 + 文件系统端口 + designUi 存储)。
// 设计回合的派发/流式/取消全部经 core 的 design-run-manager,不触碰个人会话管线。
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useDesktopBridge } from "@cortex-work/core/provider";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import {
  cancelActiveDesignRuns,
  installDesignRuntime,
  sendDesignMessage,
} from "@cortex-work/core/design/run/design-run-manager";
import { useChatStore } from "@cortex-work/core/design/compat/chat-store";
import { useCanvasShapeStore } from "@cortex-work/core/design/canvas/canvas-shape-store";
import { useCanvasSelectionStore } from "@cortex-work/core/design/canvas/canvas-selection-store";
import { useDesignWorkspaceStore } from "@cortex-work/core/design/design-workspace-store";
import type { DesignArtifact } from "@cortex-work/core/design/design-types";
import { DesignAIRail } from "./DesignAIRail";
import { DesignSidebar } from "./DesignSidebar";
import { DesignWorkspaceView } from "./DesignWorkspaceView";
import { useDesignComposerContextState } from "./useDesignComposerContextState";
import { useDesignPromptController } from "./useDesignPromptController";
import type { ComposerReasoningEffort } from "./compat/FloatingComposerModelPicker";

export function DesignWorkspace(): ReactElement {
  const bridge = useDesktopBridge();
  const closeDesign = usePersonalStore((s) => s.closeDesign);
  const openSettings = usePersonalStore((s) => s.openSettings);
  const designSettings = usePersonalStore((s) => s.designSettings);

  // 挂载即装配运行时(幂等;bridge 为 null 时 design 树各能力自动降级)。
  useEffect(() => {
    installDesignRuntime(bridge);
  }, [bridge]);

  // composer 本地态(输入/模式/模型档位)。模型缺省沿用设计设置。
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"plan" | "agent">("agent");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composerModel, setComposerModel] = useState(designSettings.model);
  const [composerReasoningEffort, setComposerReasoningEffort] =
    useState<ComposerReasoningEffort>("auto");

  // 设计对话镜像(design-run-manager 折叠 CliStreamEvent 写入)。
  const busy = useChatStore((s) => s.busy);
  const blocks = useChatStore((s) => s.blocks);
  const liveAssistant = useChatStore((s) => s.liveAssistant);
  const activeThreadId = useChatStore((s) => s.activeThreadId);

  const assistantOpen = useDesignWorkspaceStore((s) => s.canvasAssistantOpen);
  const setAssistantOpen = useDesignWorkspaceStore((s) => s.setCanvasAssistantOpen);
  const workspaceRoot = useDesignWorkspaceStore((s) => s.workspaceRoot);
  const activeDocumentId = useDesignWorkspaceStore((s) => s.activeDocumentId);
  const canvasDocument = useCanvasShapeStore((s) => s.document);
  const selectedIds = useCanvasSelectionStore((s) => s.selectedIds);

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

  // 「用代码实现」入口在批8 接线;先给出可见但明确的占位提示,避免静默无响应。
  const onImplementDesign = useMemo(
    () => (_artifact: DesignArtifact) => {
      setError("「用代码实现」流程尚未接线(开发中)");
    },
    [],
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {leftCollapsed ? null : (
        <DesignSidebar
          onCodeOpen={closeDesign}
          onWriteOpen={closeDesign}
          onDesignOpen={() => {}}
          onOpenSettings={() => openSettings("design")}
          // cortex 的主题由宿主壳统一管理;这里沿用 Kun 语义翻转 data-theme,
          // DesignSidebar 自带 MutationObserver 会同步图标态。
          onToggleTheme={() => {
            const el = document.documentElement;
            el.setAttribute("data-theme", el.getAttribute("data-theme") === "dark" ? "light" : "dark");
          }}
        />
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
      {assistantOpen ? (
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
          onSend={() => void promptController.sendDesignPrompt(input)}
          onInterrupt={() => void cancelActiveDesignRuns()}
          onRetryConnection={() => installDesignRuntime(bridge)}
          onOpenSettings={() => openSettings("design")}
          onNewConversation={() => useChatStore.getState().resetMirror()}
          designThreads={[]}
          onSwitchThread={() => {}}
          onCollapse={() => setAssistantOpen(false)}
        />
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
