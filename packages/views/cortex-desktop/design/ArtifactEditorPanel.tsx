import { useEffect, useState } from "react";
import type { ConversationArtifactRef } from "@cortex-work/core";
import { useDesktopBridge } from "@cortex-work/core";
import { useDesignWorkspaceStore } from "@cortex-work/core/design/design-workspace-store";
import { installDesignRuntime } from "@cortex-work/core/design/run/design-run-manager";
import { DesignWorkspaceView } from "./DesignWorkspaceView";
import { useArtifactConversationTurn } from "./useArtifactConversationTurn";
import { useDesignArtifactAutoRefresh } from "./useDesignArtifactAutoRefresh";

interface ArtifactWorkspaceSwitch {
  workspaceRoot: string;
  resetWorkspace: () => void;
  setWorkspaceRoot: (workspaceRoot: string) => void;
}

export function switchArtifactWorkspace(
  store: ArtifactWorkspaceSwitch,
  workspaceRoot: string,
): void {
  if (store.workspaceRoot !== workspaceRoot) store.resetWorkspace();
  store.setWorkspaceRoot(workspaceRoot);
}

export function ArtifactEditorPanel({
  artifact,
}: {
  artifact: ConversationArtifactRef;
}) {
  const bridge = useDesktopBridge();
  const loadDesignSettings = useDesignWorkspaceStore((state) => state.loadDesignSettings);
  const switchActiveDocument = useDesignWorkspaceStore((state) => state.switchActiveDocument);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // 面板内的动作(提纲审批、画布智能操作)要发回打开该产物的会话,而不是设计工作台的隐形对话。
  useArtifactConversationTurn(artifact);
  // agent 这一轮写完设计稿后重扫目录,否则画布要等下次打开面板才更新。
  useDesignArtifactAutoRefresh(artifact);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void (async () => {
      if (!bridge?.artifactValidate) {
        if (!cancelled) {
          setError("当前客户端不支持会话产物");
          setLoading(false);
        }
        return;
      }
      try {
        const checked = await bridge.artifactValidate(artifact);
        if (!checked.ok) {
          if (!cancelled) {
            setError(checked.error);
            setLoading(false);
          }
          return;
        }
        installDesignRuntime(bridge);
        switchArtifactWorkspace(useDesignWorkspaceStore.getState(), artifact.workspaceRoot);
        await loadDesignSettings();
        if (
          cancelled ||
          useDesignWorkspaceStore.getState().workspaceRoot !== artifact.workspaceRoot
        ) return;
        switchActiveDocument(artifact.documentId);
        setLoading(false);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    artifact.documentId,
    artifact.workspaceRoot,
    bridge,
    loadDesignSettings,
    switchActiveDocument,
  ]);

  return (
    <div className="pw-artifact-editor" data-artifact-kind={artifact.kind}>
      {loading ? (
        <div className="pw-center-hint">正在打开产物…</div>
      ) : error ? (
        <div className="pw-center-hint">{error}</div>
      ) : (
        <DesignWorkspaceView
          leftSidebarCollapsed
          // 刻意不传 onToggleLeftSidebar:产物面板里没有可折叠的设计侧栏,渲染出来也是死按钮。
          // chromeless:演示文稿的标题与播放/导出由右栏顶栏承担;设计画布隐藏助手开关。
          chromeless
        />
      )}
    </div>
  );
}
