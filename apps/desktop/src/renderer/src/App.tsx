import { useEffect } from "react";
import { CoreProvider, useCortexUIStore } from "@cortex-work/core";
import { CortexDesktopView } from "@cortex-work/views/cortex-desktop";

// macOS uses a frameless window (titleBarStyle: hiddenInset) so the app's
// titlebar must reserve space for the native traffic lights.
const isMac = typeof window !== "undefined" && window.desktopAPI?.appInfo.os === "macos";
const runtimeConfig = typeof window !== "undefined" ? window.desktopAPI?.runtimeConfig : undefined;
const workspaceId = runtimeConfig?.workspaceId || "demo-workspace";
// 个人工作区的桌面能力桥（preload personal 与 core DesktopBridge 形状一致）。
const desktopBridge = typeof window !== "undefined" ? (window.desktopAPI?.personal ?? null) : null;

// 闪记浮层入口:壳就近注入(views 不直接碰 window.desktopAPI)。缺桥/旧壳无方法时 → undefined,
// 透传到 composer 后隐藏图标(可选链兜底)。降级后此入口仍可用(不依赖全局热键)。
const openFlashNote =
  typeof window !== "undefined" && window.desktopAPI?.notesOverlay?.show
    ? () => window.desktopAPI?.notesOverlay?.show?.()
    : undefined;

export default function App() {
  // 全局热键被占用时拉取一次主进程的降级提示 → 浮层 toast(consume-pending,旧壳无此方法则静默)。
  useEffect(() => {
    window.desktopAPI?.consumeNotesHotkeyDegraded?.().then((text) => {
      if (text) useCortexUIStore.getState().pushToast(text, { kind: "info" });
    });
  }, []);

  return (
    <CoreProvider
      wsId={workspaceId}
      identity={{ userId: "me", name: "我" }}
      apiConfig={{
        enabled: !!runtimeConfig?.apiUrl && (!!runtimeConfig?.workspaceId || !!runtimeConfig?.workspaceSlug),
        baseUrl: runtimeConfig?.apiUrl,
        token: runtimeConfig?.authToken,
        workspaceId: runtimeConfig?.workspaceId,
        workspaceSlug: runtimeConfig?.workspaceSlug,
        platform: "desktop",
        version: window.desktopAPI?.appInfo.version,
        os: window.desktopAPI?.appInfo.os,
      }}
      desktopBridge={desktopBridge}
    >
      <CortexDesktopView nativeTitlebar={isMac} onOpenFlashNote={openFlashNote} />
    </CoreProvider>
  );
}
