import { useEffect } from "react";
import {
  CoreProvider,
  useCortexUIStore,
  usePersonalStore,
  useReplyStore,
} from "@cortex-work/core";
import { CortexDesktopView } from "@cortex-work/views/cortex-desktop";

// macOS uses a frameless window (titleBarStyle: hiddenInset) so the app's
// titlebar must reserve space for the native traffic lights.
const isMac = typeof window !== "undefined" && window.desktopAPI?.appInfo.os === "macos";
const runtimeConfig = typeof window !== "undefined" ? window.desktopAPI?.runtimeConfig : undefined;
const workspaceId = runtimeConfig?.workspaceId || "demo-workspace";
// 个人工作区的桌面能力桥（preload personal 与 core DesktopBridge 形状一致）。
const rawDesktopBridge = typeof window !== "undefined" ? (window.desktopAPI?.personal ?? null) : null;

// 核心路径埋点的 dev/prod 级别 gating（U7）:dev/prod 判断只能留在壳（core/views 禁用 import.meta.env）。
// dev 透传全部级别；prod 只透传 warn/error，丢弃 info/debug 以免高频核心路径埋点污染生产日志。
// 仅包一层 logMessage，其余能力原样透传（壳就近装配，core 只调注入抽象）。
const desktopBridge =
  rawDesktopBridge && !import.meta.env.DEV
    ? {
        ...rawDesktopBridge,
        logMessage: (level: "debug" | "info" | "warn" | "error", message: string): Promise<void> =>
          level === "warn" || level === "error"
            ? (rawDesktopBridge.logMessage?.(level, message) ?? Promise.resolve())
            : Promise.resolve(),
      }
    : rawDesktopBridge;

// 闪记浮层入口:壳就近注入(views 不直接碰 window.desktopAPI)。缺桥/旧壳无方法时 → undefined,
// 透传到 composer 后隐藏图标(可选链兜底)。降级后此入口仍可用(不依赖全局热键)。
const openFlashNote =
  typeof window !== "undefined" && window.desktopAPI?.notesOverlay?.show
    ? () => window.desktopAPI?.notesOverlay?.show?.()
    : undefined;

// 「项目管理」独立窗口入口:壳就近注入(views 不直接碰 window.desktopAPI,KTD2)。缺桥/旧壳无
// projectsWindow 能力时 → undefined,透传到侧栏后隐藏入口(与任务能力门控 tasksListProjects 双门控)。
const openProjectsWindow =
  typeof window !== "undefined" && window.desktopAPI?.projectsWindow?.open
    ? () => void window.desktopAPI?.projectsWindow?.open?.()
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

  // 快捷回复设置快照 → 主进程（KTD3）：起草在主进程组装 prompt 需要最新 reply 设置（含专属
  // providerId/model 与 userProfile），它们活在渲染端 store。此处推给主进程缓存
  // （getLastReplySnapshot）;生成模型的回退链解析在 main 侧做（resolveReplyModel 读持久化
  // providerSettings）。KTD6 修订：分区记忆已迁 main-owned memory.json，快照不再携带 memory。
  // 用 key 去重避免 IPC 风暴。壳就近接线。
  useEffect(() => {
    const sync = window.desktopAPI?.personal?.replySyncSettings;
    if (!sync) return;
    let lastKey = "";
    const push = (): void => {
      const reply = useReplyStore.getState();
      const key = JSON.stringify(reply.settings);
      if (key === lastKey) return;
      lastKey = key;
      void sync({ settings: reply.settings });
    };
    push(); // 挂载即推一次,保证首次起草前主进程已有快照。
    return useReplyStore.subscribe(push);
  }, []);

  // 快捷回复气泡「去设置」：主进程发 reply:openSettings → 打开设置整页并跳到快捷回复分区。
  // 壳就近订阅(views/core 不直接碰 window.desktopAPI);旧壳无此方法则静默。返回退订清理。
  useEffect(() => {
    return window.desktopAPI?.personal?.onReplyOpenSettings?.(() => {
      usePersonalStore.getState().openSettings("reply");
    });
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
      <CortexDesktopView nativeTitlebar={isMac} onOpenFlashNote={openFlashNote} onOpenProjectsWindow={openProjectsWindow} />
    </CoreProvider>
  );
}
