// 「项目管理」独立窗口 renderer 入口（U2）。自包一层 CoreProvider（本窗口用 React Query 任务 hooks，
// 注入形状照主窗 App.tsx）+ 自持 toast 宿主（工作台内委派/新建动作的反馈通道），挂载三栏工作台
// ProjectsWorkbench。import "./globals.css" 即获得全套 cortex-desktop.css（照 agent-trace.tsx 先例）。
//
// 跨窗口数据一致由 main 的 broadcastTasksChanged → React Query invalidate 承担；本窗口不与主窗口
// 直接通信。tasksKeys 刻意不含 wsId（个人任务 main-owned），无 wsId 串场风险（见 KTD3）。

import ReactDOM from "react-dom/client";
import { CoreProvider, useCortexUIStore } from "@cortex-work/core";
import { ProjectsWorkbench, ToastStack } from "@cortex-work/views/cortex-desktop";
import "./globals.css";

const runtimeConfig = typeof window !== "undefined" ? window.desktopAPI?.runtimeConfig : undefined;
const workspaceId = runtimeConfig?.workspaceId || "demo-workspace";
// 个人工作区桌面能力桥（preload personal 与 core DesktopBridge 形状一致；缺桥 → null）。
const desktopBridge = typeof window !== "undefined" ? (window.desktopAPI?.personal ?? null) : null;

// 工作台自持 toast 通道：pushToast 写入 UI store，由本窗口内的 ToastStack 渲染（不依赖主窗口宿主）。
function pushToast(text: string): void {
  useCortexUIStore.getState().pushToast(text, { kind: "info" });
}

function ProjectsWindow() {
  const toasts = useCortexUIStore((s) => s.toasts);
  if (!desktopBridge) {
    return <div className="pw-scard-empty">Desktop bridge 不可用</div>;
  }
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
      <ProjectsWorkbench onToast={pushToast} />
      <ToastStack items={toasts} />
    </CoreProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<ProjectsWindow />);
