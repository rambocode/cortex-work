// artifact 面板的懒加载入口:产物编辑器随会话的 activeArtifact 渲染,无产物渲染空
// （PresenceGuard 会随即收起面板,这里不做空态 UI）。
import { usePersonalStore } from "@cortex-work/core";
import { ArtifactEditorPanel } from "./ArtifactEditorPanel";

export default function ArtifactPanelEntry() {
  const activeArtifact = usePersonalStore(
    (s) => s.sessions.find((session) => session.id === s.activeSessionId)?.activeArtifact,
  );
  return activeArtifact ? <ArtifactEditorPanel artifact={activeArtifact} /> : null;
}
