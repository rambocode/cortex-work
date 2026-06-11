import { CoreProvider } from "@cortex-work/core";
import { CortexDesktopView } from "@cortex-work/views/cortex-desktop";

// macOS uses a frameless window (titleBarStyle: hiddenInset) so the app's
// titlebar must reserve space for the native traffic lights.
const isMac = typeof window !== "undefined" && window.desktopAPI?.appInfo.os === "macos";
const runtimeConfig = typeof window !== "undefined" ? window.desktopAPI?.runtimeConfig : undefined;
const workspaceId = runtimeConfig?.workspaceId || "demo-workspace";
// 个人工作区的桌面能力桥（preload personal 与 core DesktopBridge 形状一致）。
const desktopBridge = typeof window !== "undefined" ? (window.desktopAPI?.personal ?? null) : null;

export default function App() {
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
      <CortexDesktopView nativeTitlebar={isMac} />
    </CoreProvider>
  );
}
