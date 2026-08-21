// 会话产物面板（设计稿/演示文稿,落盘型）的右栏注册描述。无 rail 入口:由会话内产物卡/
// 轮末回跳等程序性入口打开。usePresence:产物被解绑后自动收起。renderHead:slides 产物把
// 播放/导出并入头行(省一行高度),其余产物走默认标题——组件形态,可在内部读 store 判 kind。
import { usePersonalStore } from "@cortex-work/core";
import type { RightPanelDescriptor } from "../personal/right-panel/types";
import { PanelHeadTitle } from "../personal/right-panel/PanelHeadTitle";
import { SlidesDeckHeadActions } from "./slides/SlidesDeckHeadActions";

/** 当前活跃会话的落盘产物引用（无会话/无产物为 undefined）。 */
function useActiveArtifact() {
  return usePersonalStore(
    (s) => s.sessions.find((session) => session.id === s.activeSessionId)?.activeArtifact,
  );
}

function ArtifactPanelHead() {
  const activeArtifact = useActiveArtifact();
  if (activeArtifact?.kind === "slides") {
    return <SlidesDeckHeadActions fallbackTitle={activeArtifact.title} />;
  }
  return <PanelHeadTitle title="产物" />;
}

export const artifactPanel = {
  id: "artifact",
  title: "产物",
  widthTier: "wide",
  canMaximize: true,
  usePresence: () => {
    const activeArtifact = useActiveArtifact();
    return !!activeArtifact;
  },
  renderHead: ArtifactPanelHead,
  load: () => import("./artifact-panel"),
} as const satisfies RightPanelDescriptor;
