import { useEffect, useState } from "react";
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
// 个人工作区的桌面能力桥（preload personal 与 core DesktopBridge 形状一致）。
const rawDesktopBridge = typeof window !== "undefined" ? (window.desktopAPI?.personal ?? null) : null;

// 渲染端统一的「已启用后端」配置（W1）。来源三选一，优先级从高到低：
//   ① env 注入（CORTEX_API_URL 等，CI/开发向后兼容）→ 作为初始 state。
//   ② 持久化登录态（auth-config.json，冷启动异步读回）。
//   ③ 应用内登录成功回调（handleAuthenticated）。
// apiConfig（是否启用 ApiClient）单一读此 state，避免双数据源漂移。
interface ActiveConfig {
  apiUrl: string;
  authToken?: string;
  workspaceId?: string;
  workspaceSlug?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
}

const envRuntime = typeof window !== "undefined" ? window.desktopAPI?.runtimeConfig : undefined;
// env 有 apiUrl 即视为最高优先级配置（向后兼容既有 env 注入路径）；否则为 null，挂载后读持久化填充。
const initialEnvConfig: ActiveConfig | null = envRuntime?.apiUrl
  ? {
      apiUrl: envRuntime.apiUrl,
      authToken: envRuntime.authToken,
      workspaceId: envRuntime.workspaceId,
      workspaceSlug: envRuntime.workspaceSlug,
    }
  : null;

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

  // 已启用后端配置的单一数据源（W1）。初始值取 env 注入（最高优先级）；env 缺失时 null，
  // 由下方启动 effect 异步读持久化登录态填充。
  const [config, setConfig] = useState<ActiveConfig | null>(initialEnvConfig);
  const workspaceId = config?.workspaceId || "demo-workspace";

  // 启动接线（W1）：env 配置已作为初始 state（最高优先级，直接返回）；否则读持久化登录态填充。
  // 执行点在服务器侧 daemon（本仓不做桌面执行节点），故此处只恢复渲染端登录态，无需接线主进程。
  // workspaceId 需为 UUID（服务端契约）。
  useEffect(() => {
    if (initialEnvConfig) return;
    let cancelled = false;
    void rawDesktopBridge?.authGetConfig?.().then((persisted) => {
      if (cancelled || !persisted) return;
      setConfig({
        apiUrl: persisted.baseUrl,
        authToken: persisted.token,
        workspaceId: persisted.workspaceId,
        workspaceSlug: persisted.workspaceSlug,
        userId: persisted.userId,
        userName: persisted.userName,
        userEmail: persisted.userEmail,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 应用内登录成功（W1）：更新 state（驱动 apiConfig 启用真实后端）+ 持久化（token 主进程加密）。
  const handleAuthenticated = (cfg: {
    apiUrl: string;
    token: string;
    workspaceId: string;
    workspaceSlug?: string;
    userId?: string;
    userName?: string;
    userEmail?: string;
  }): void => {
    setConfig({
      apiUrl: cfg.apiUrl,
      authToken: cfg.token,
      workspaceId: cfg.workspaceId,
      workspaceSlug: cfg.workspaceSlug,
      userId: cfg.userId,
      userName: cfg.userName,
      userEmail: cfg.userEmail,
    });
    void rawDesktopBridge?.authSetConfig?.({
      baseUrl: cfg.apiUrl,
      workspaceId: cfg.workspaceId,
      workspaceSlug: cfg.workspaceSlug,
      userId: cfg.userId,
      userName: cfg.userName,
      userEmail: cfg.userEmail,
      token: cfg.token,
    });
  };

  // 切换团队(workspace):改 state 的 workspaceId(CoreProvider wsId 变 → 全部 query key
  // 自动换命名空间,缓存天然隔离)并持久化,重启后进入所选团队。
  const handleWorkspaceSwitch = (ws: { id: string; name: string; slug?: string }): void => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev, workspaceId: ws.id, workspaceSlug: ws.slug };
      void rawDesktopBridge?.authSetConfig?.({
        baseUrl: next.apiUrl,
        workspaceId: next.workspaceId,
        workspaceSlug: next.workspaceSlug,
        userId: next.userId,
        userName: next.userName,
        userEmail: next.userEmail,
        token: next.authToken,
      });
      return next;
    });
  };

  // 登出（W1）：清持久化 + 清 state（apiConfig 随之停用真实后端，团队侧回落登录卡）。
  // 仅清渲染端登录态与本地持久化，避免登出流程阻塞在网络往返。
  const handleLogout = (): void => {
    void rawDesktopBridge?.authClearConfig?.();
    setConfig(null);
  };

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
      // userId 优先取团队登录态里的真实用户 id(服务端 UUID,与 ApiAvatar.owner.id 同格式，
      // 供"我的角色会话"等 owner 视角功能匹配)；未登录/env 兜底路径无该字段时回退 "me"
      // 占位——个人工作区本地功能不依赖真实 userId，不受影响。
      identity={{ userId: config?.userId || "me", name: "我" }}
      apiConfig={{
        enabled: !!config?.apiUrl && (!!config?.workspaceId || !!config?.workspaceSlug),
        baseUrl: config?.apiUrl,
        token: config?.authToken,
        workspaceId: config?.workspaceId,
        workspaceSlug: config?.workspaceSlug,
        platform: "desktop",
        version: window.desktopAPI?.appInfo.version,
        os: window.desktopAPI?.appInfo.os,
      }}
      desktopBridge={desktopBridge}
    >
      <CortexDesktopView
        nativeTitlebar={isMac}
        onOpenFlashNote={openFlashNote}
        onOpenProjectsWindow={openProjectsWindow}
        auth={{
          // 已登录并可启用真实后端（有 apiUrl + token + workspace）时 enabled=true → 不显示登录卡。
          enabled: !!config?.apiUrl && !!config?.authToken && (!!config?.workspaceId || !!config?.workspaceSlug),
          userName: config?.userName,
          userEmail: config?.userEmail,
          defaultBaseUrl: config?.apiUrl || "http://127.0.0.1:8080",
          onAuthenticated: handleAuthenticated,
          onLogout: handleLogout,
          onWorkspaceSwitch: handleWorkspaceSwitch,
        }}
      />
    </CoreProvider>
  );
}
