// 当窗口宽度低于断点时自动收缩左栏，恢复宽度后自动展开。
// 用户可在窄屏下主动打开左栏；跨越断点时断点侧决定状态。
import { useEffect } from "react";
import { useCortexUIStore } from "@cortex-work/core";

const NARROW_BREAKPOINT_PX = 760;

export function useResponsiveLeftCollapsed() {
  const setLeftCollapsed = useCortexUIStore((s) => s.setLeftCollapsed);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`);

    // 只自动收缩；窗口恢复宽时不自动展开，由用户主动打开。
    const handler = (e: MediaQueryList | MediaQueryListEvent) => {
      if (e.matches) setLeftCollapsed(true);
    };

    // 初始同步：挂载时立即检测当前宽度，避免首屏闪烁
    handler(mql);

    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [setLeftCollapsed]);
}
