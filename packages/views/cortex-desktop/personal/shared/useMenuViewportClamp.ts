// 弹层视口收敛 hook：菜单打开后按实际渲染尺寸测量,溢出视口时用 translate 平移回可视范围。
// 背景:个人任务工作台的下拉弹层(pw-tb-menu / pw-view-options 体系)全是 CSS absolute 锚定、
// 方向写死(left:0 或 right:0)——触发按钮贴近窗口边缘(工具栏最右的字段设置、窄侧栏树行的
// ＋/移动/模式菜单)时菜单会被顶出窗口。本 hook 不改锚定范式,只做打开瞬间的一次性校正:
// useLayoutEffect 在浏览器绘制前量 rect 并应用位移,用户不会看到"先溢出再跳回"的闪动。
// 菜单内容在打开期间静态,故只在 open 翻转时测一次即可;关闭时清空位移,避免下次开残留旧值。
import { useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";

// 收敛后与视口边缘保留的最小间距(px),与 ProjectMenu 的 fixed 定位收敛逻辑一致。
const MARGIN = 8;

export function useMenuViewportClamp(open: boolean): {
  menuRef: MutableRefObject<HTMLDivElement | null>;
  clampStyle: CSSProperties | undefined;
} {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [clampStyle, setClampStyle] = useState<CSSProperties | undefined>(undefined);

  useLayoutEffect(() => {
    if (!open) {
      setClampStyle(undefined);
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 水平:先按右缘回收,再按左缘兜底——左缘后算,菜单比视口还宽时优先保住左侧(阅读起点)。
    let dx = 0;
    if (rect.right > window.innerWidth - MARGIN) dx = window.innerWidth - MARGIN - rect.right;
    if (rect.left + dx < MARGIN) dx = MARGIN - rect.left;
    // 垂直同理:先收下缘,再兜上缘。
    let dy = 0;
    if (rect.bottom > window.innerHeight - MARGIN) dy = window.innerHeight - MARGIN - rect.bottom;
    if (rect.top + dy < MARGIN) dy = MARGIN - rect.top;
    setClampStyle(dx !== 0 || dy !== 0 ? { transform: `translate(${dx}px, ${dy}px)` } : undefined);
  }, [open]);

  return { menuRef, clampStyle };
}
