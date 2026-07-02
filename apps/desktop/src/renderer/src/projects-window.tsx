// 「项目管理」独立窗口 renderer 入口（U2）。自包一层 CoreProvider（本窗口用 React Query 任务 hooks，
// 注入形状照主窗 App.tsx）+ 自持 toast 宿主（工作台内委派/新建动作的反馈通道），挂载三栏工作台
// ProjectsWorkbench。import "./globals.css" 即获得全套 cortex-desktop.css（照 agent-trace.tsx 先例）。
//
// 跨窗口数据一致由 main 的 broadcastTasksChanged → React Query invalidate 承担；本窗口不与主窗口
// 直接通信。tasksKeys 刻意不含 wsId（个人任务 main-owned），无 wsId 串场风险（见 KTD3）。

import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { useQueryClient } from "@tanstack/react-query";
import { CoreProvider, useCortexUIStore } from "@cortex-work/core";
import { ProjectsWorkbench, ToastStack, flushPendingDrafts } from "@cortex-work/views/cortex-desktop";
import "./globals.css";

const runtimeConfig = typeof window !== "undefined" ? window.desktopAPI?.runtimeConfig : undefined;
const workspaceId = runtimeConfig?.workspaceId || "demo-workspace";
// 个人工作区桌面能力桥（preload personal 与 core DesktopBridge 形状一致；缺桥 → null）。
const desktopBridge = typeof window !== "undefined" ? (window.desktopAPI?.personal ?? null) : null;

// 工作台自持 toast 通道：pushToast 写入 UI store，由本窗口内的 ToastStack 渲染（不依赖主窗口宿主）。
function pushToast(text: string): void {
  useCortexUIStore.getState().pushToast(text, { kind: "info" });
}

// 关窗草稿 flush 桥（R21/KTD6）：必须挂在 CoreProvider 内部，才能拿到本窗口的 QueryClient
// 判断 mutation 是否落库。main 拦截 close → 发 flush-request → 本组件提交所有 pending 草稿并
// 等 update mutation 落库 → flushDone 回执 → main 销毁窗口。beforeunload 为 app 退出等
// 不走握手直接销毁 renderer 的路径做同步兜底（至少把草稿的 mutate 发出去）。
function ProjectsFlushBridge() {
  const qc = useQueryClient();
  useEffect(() => {
    const api = window.desktopAPI?.projectsWindow;

    // 等所有进行中 mutation 落库（tasksUpdate 非乐观、mutationFn 即 IPC，isMutating>0 表征在途）。
    // 含最长等待兜底：极端卡死时也不能吊住关窗握手（main 侧另有独立超时，双保险）。
    async function waitMutationsIdle(maxMs = 2000): Promise<void> {
      const start = Date.now();
      while (qc.isMutating() > 0 && Date.now() - start < maxMs) {
        await new Promise((r) => setTimeout(r, 30));
      }
    }

    const off = api?.onFlushRequest?.(() => {
      flushPendingDrafts(); // 同步触发所有 pending 草稿的 update mutation
      void waitMutationsIdle().then(() => api?.flushDone?.());
    });

    // app 退出（main 直接销毁 renderer、不走握手）的同步兜底：beforeunload 里只能同步执行，
    // 无法 await mutation，尽力把草稿 mutate 发出去（IPC invoke 同步入队）。
    const onBeforeUnload = (): void => {
      flushPendingDrafts();
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      off?.();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [qc]);
  return null;
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
      <ProjectsFlushBridge />
      <ProjectsWorkbench onToast={pushToast} />
      <ToastStack items={toasts} />
    </CoreProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<ProjectsWindow />);
