// 右栏面板 chunk 空闲预热:app 启动后趁空闲逐个预取 11 个懒加载面板。
// 动机(2026-08 实机反馈):dev 模式下 Vite 按需编译,首开某面板要现场编译整个模块子树,
// 有可感知的顿挫;预热后点击即时。打包版代价只是空闲期读本地 chunk,不占启动关键路径。
// 逐个串行而非一次 Promise.all:避免并发编译把 dev server 打满,反过来卡住 HMR。

import { useEffect } from "react";
import { ALL_PANELS } from "./registry";

/** enabled=false(如 web 无 bridge 的降级页)时完全不预热。 */
export function usePrewarmPanels(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // jsdom/旧环境没有 requestIdleCallback,退化为固定延时(测试里 2s 后组件早已卸载,cancelled 兜住)。
    const idle = (cb: () => void) =>
      typeof requestIdleCallback === "function"
        ? void requestIdleCallback(() => cb(), { timeout: 5000 })
        : void window.setTimeout(cb, 2000);
    const queue = [...ALL_PANELS];
    const next = () => {
      if (cancelled) return;
      const panel = queue.shift();
      if (!panel) return;
      // load() 与宿主 React.lazy 走同一 ESM 模块缓存,预热过的面板首开零请求。
      void panel.load().catch(() => {}).finally(() => idle(next));
    };
    idle(next);
    return () => {
      cancelled = true;
    };
  }, [enabled]);
}
