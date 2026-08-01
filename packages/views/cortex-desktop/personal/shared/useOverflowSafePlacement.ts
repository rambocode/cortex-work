// 浮层视口避让：先翻转，翻不动就钳回视口内。
//
// 为什么不只用翻转（useAutoFlipUp / pw-mt-sub--left 那套）：翻转的前提是「另一侧空间够」。
// 窄容器里两侧都可能不够——写作助手栏只有 ~370px、侧栏 270px——再叠加内容撑宽
// （长模型名 "GPT-5.3 Codex Spark" 能把 min-width:180px 的 flyout 撑到 230px+），
// 翻转后照样漏出窗口。用户反复反馈「模型选择右侧显示不全」，根因就在这。
//
// 两阶段测量（都在 useLayoutEffect 里，绘制前完成，无可见闪烁）：
//   ① 按默认方向渲染后测一次 → 越界则置 flipX / flipY，让 CSS 换到对侧；
//   ② 翻转生效后再测一次 → 仍越界就算出像素差，用 translate 把浮层整体推回视口内。
// 第二阶段的依赖只有 [open, flipX, flipY]，shift 自身不进依赖，因此不会自激循环。
//
// 调用方把 ref 挂到浮层根元素，按 flipX/flipY 加自己的翻转类，并把 style 展开上去。

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

// 浮层与视口边缘的最小留白。
const MARGIN = 8;

export interface OverflowSafePlacement {
  flipX: boolean;
  flipY: boolean;
  // 钳制位移（px）。翻转已经够用时恒为 0。
  shiftX: number;
  shiftY: number;
  // 直接展开到浮层 style 上；无位移时为空对象，不产生多余的 transform。
  style: CSSProperties;
}

export function useOverflowSafePlacement(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState({ flipX: false, flipY: false });
  const [shift, setShift] = useState({ shiftX: 0, shiftY: 0 });

  // ① 默认方向下测量：越界则翻到对侧。收起时复位，避免下次打开沿用上次的方向。
  useLayoutEffect(() => {
    if (!open) {
      setFlip({ flipX: false, flipY: false });
      setShift({ shiftX: 0, shiftY: 0 });
      return;
    }
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setFlip({
      flipX: r.right > window.innerWidth - MARGIN,
      flipY: r.bottom > window.innerHeight - MARGIN,
    });
  }, [open]);

  // ② 翻转应用后再测：两侧都不够时把浮层推回视口。
  // 先处理右/下越界，再处理左/上——后者优先，宁可右边被裁也不能让左上角跑到视口外
  //（那一侧连滚动都够不着）。
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (r.right > window.innerWidth - MARGIN) dx = window.innerWidth - MARGIN - r.right;
    if (r.left + dx < MARGIN) dx = MARGIN - r.left;
    if (r.bottom > window.innerHeight - MARGIN) dy = window.innerHeight - MARGIN - r.bottom;
    if (r.top + dy < MARGIN) dy = MARGIN - r.top;
    // 已在视口内就不写 state，省一次无谓渲染。
    if (dx !== 0 || dy !== 0) setShift((prev) => ({ shiftX: prev.shiftX + dx, shiftY: prev.shiftY + dy }));
  }, [open, flip.flipX, flip.flipY]);

  const style: CSSProperties =
    shift.shiftX || shift.shiftY
      ? { transform: `translate(${shift.shiftX}px, ${shift.shiftY}px)` }
      : {};

  return { ref, ...flip, ...shift, style };
}
