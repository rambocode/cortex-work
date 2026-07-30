// 关窗草稿 flush 缝合层（R21/KTD6）：从 desktop renderer 入口抽出为可测组件。必须挂在 CoreProvider
// 内部，才能拿到本窗口的 QueryClient 判断 mutation 是否落库。
//
// 契约：main 拦截项目管理窗口 close → 发 flush-request（经 onFlushRequest 回调）→ 本组件提交所有
// pending 草稿并等 update mutation 落库 → flushDone 回执 → main 销毁窗口。beforeunload 为 app 退出
// 等不走握手直接销毁 renderer 的路径做同步兜底（至少把草稿的 mutate 发出去）。
//
// 边界：views 不直接触碰 window.desktopAPI，故窗口专属通道由外壳（projects-window.tsx）以 `api`
// prop 注入（Web 端无此桥 → 不挂载本组件 / 传 undefined）。
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { flushPendingDrafts } from "../tasks/useTaskDraftField";

// 窗口专属 flush 握手通道（形状对齐 preload 的 window.desktopAPI.projectsWindow）。
export interface ProjectsFlushApi {
  // 注册 flush 请求监听；返回取消订阅函数。
  onFlushRequest?: (cb: () => void) => () => void;
  // 草稿落库完成回执，通知 main 可销毁窗口。
  flushDone?: () => void;
}

export function ProjectsFlushBridge({ api }: { api?: ProjectsFlushApi }): null {
  const qc = useQueryClient();
  // api 走 ref：外壳每次渲染重取 window.desktopAPI?.projectsWindow 可能是新引用，
  // 若入 effect 依赖会反复重订阅 IPC。契约上 api 单例稳定，故只订阅一次、从 ref 取最新。
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    const a = apiRef.current;

    // 等所有进行中 mutation 落库（tasksUpdate 非乐观、mutationFn 即 IPC，isMutating>0 表征在途）。
    // 含最长等待兜底：极端卡死时也不能吊住关窗握手（main 侧另有独立超时，双保险）。
    async function waitMutationsIdle(maxMs = 2000): Promise<void> {
      const start = Date.now();
      while (qc.isMutating() > 0 && Date.now() - start < maxMs) {
        await new Promise((r) => setTimeout(r, 30));
      }
    }

    const off = a?.onFlushRequest?.(() => {
      flushPendingDrafts(); // 同步触发所有 pending 草稿的 update mutation
      void waitMutationsIdle().then(() => a?.flushDone?.());
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
