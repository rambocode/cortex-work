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
  // macOS:主进程已给主窗口启用原生「sidebar」vibrancy(见 main/index.ts)。此处在 <html> 挂
  // data-vibrancy="sidebar",驱动共享样式表把左侧菜单栏背后的背景链打透、透出磨砂材质
  // (见 cortex-desktop.css §Sidebar vibrancy)。门控与主进程一致——仅 macOS;Web/非 mac 从不设此标记,
  // 样式完全不受影响。
  useEffect(() => {
    if (!isMac) return;
    document.documentElement.setAttribute("data-vibrancy", "sidebar");
  }, []);

  // 全局热键被占用时拉取一次主进程的降级提示 → 浮层 toast(consume-pending,旧壳无此方法则静默)。
  useEffect(() => {
    window.desktopAPI?.consumeNotesHotkeyDegraded?.().then((text) => {
      if (text) useCortexUIStore.getState().pushToast(text, { kind: "info" });
    });
  }, []);

  // 全局提醒焦点路由:订阅 UI store,新增 toast 时按主窗焦点态分流。
  //  - 主窗失焦/最小化:转发到独立通知窗体,并从应用内移除(避免回到前台重复显示)。
  //  - 主窗在前台:用户就在应用里,确认/信息类提醒(已保存/已触发运行等)纯属噪音 → 直接丢弃;
  //    仅保留 error 类应用内卡片(操作失败必须当场可见)。这样「只有不在当前应用上时才提醒」。
  // 壳就近实现(views/core 不直接碰 window.desktopAPI);主窗重获焦点的清空在主进程侧(index.ts)。
  useEffect(() => {
    const ntf = window.desktopAPI?.notification;
    if (!ntf) return;
    const seen = new Set(useCortexUIStore.getState().toasts.map((t) => t.id));
    return useCortexUIStore.subscribe((state) => {
      const fresh = state.toasts.filter((t) => !seen.has(t.id));
      if (fresh.length === 0) return;
      fresh.forEach((t) => seen.add(t.id));
      if (document.hasFocus()) {
        // 前台:仅 error 留作应用内卡片,其余确认/信息类立即移除(同步发生在 pushToast 的
        // set 回调内,ToastStack 尚未渲染,无一闪而过)。
        for (const t of fresh) {
          if (t.kind !== "error") useCortexUIStore.getState().dismissToast(t.id);
        }
        return;
      }
      for (const t of fresh) {
        ntf.push({
          id: t.id,
          kind: t.kind,
          text: t.text,
          title: t.title,
          description: t.description,
          iconName: t.iconName,
          duration: t.duration,
        });
        useCortexUIStore.getState().dismissToast(t.id);
      }
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
