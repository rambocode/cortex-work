// 当窗口宽度低于断点时自动收缩左栏，恢复宽度后自动展开。
// 用户可在窄屏下主动打开左栏；跨越断点时断点侧决定状态。
import { useEffect } from "react";
import { useCortexUIStore } from "@cortex-work/core";

// 770 ≈ 左栏 271 + 中栏最小宽 440(--pw-center-min)+ 右侧 rail 48:低于它左栏与中栏
// 下限放不下同屏,自动收左栏保会话区。与 CSS 的 --pw-center-min 联动,改一处同步另一处。
const NARROW_BREAKPOINT_PX = 770;

export function useResponsiveLeftCollapsed() {
  const setLeftCollapsed = useCortexUIStore((s) => s.setLeftCollapsed);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`);

    // 双向同步：窄于断点自动收缩，恢复到断点以上自动展开。
    // 断点内（宽屏下手动收、窄屏下手动开）的用户操作不受影响——只有跨越断点才改状态。
    const handler = (e: MediaQueryList | MediaQueryListEvent) => {
      setLeftCollapsed(e.matches);
    };

    // 初始同步：挂载时立即检测当前宽度，避免首屏闪烁
    handler(mql);

    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [setLeftCollapsed]);
}
