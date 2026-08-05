// 锚定浮层：把一个 portal 到 `document.body` 的 `position: fixed` 面板钉在触发按钮旁边。
//
// 为什么不用同目录的 useOverflowSafePlacement：那套解决的是「浮层内容撑出容器」，本体仍是
// `position: absolute`，一旦祖先里有 `overflow: auto`（设置页整个躺在 `.pw-dlg-body` 里）
// 就会被滚动容器整块裁掉——翻转与钳制都救不回来，因为裁剪发生在祖先那一层。
// 连接测试的确认/过程面板正是这个场景：行在列表底部时浮层下半截直接消失。
//
// 所以这里换一条路：portal 出 DOM 层级 + fixed 定位 + 自己按锚点 rect 算坐标。
// 代价是「不跟随祖先滚动」这件事得自己补上 —— 监听 scroll(capture) / resize 重算，
// 用户滚动设置页内容区时面板必须跟着按钮走，否则就成了飘在半空的孤儿浮层。
//
// 定位规则：默认贴在锚点左下方，放不下就翻到上方；两个方向都按 MARGIN 钳回视口。
// 刻意**左对齐**而不是右对齐——右对齐（旧 `.pw-pip-test-pop { right: 0 }`）会让宽面板
// 从窄按钮向左整体溢出到卡片外，正是这次要修的走位。

import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

/** 浮层与视口边缘的最小留白。 */
const MARGIN = 8;
/** 浮层与锚点之间的间距。 */
const GAP = 6;

export interface AnchoredLayerPlacement {
  /** 挂到浮层根元素上。 */
  ref: RefObject<HTMLDivElement | null>;
  /** 直接展开到浮层 style 上（含 position: fixed）。 */
  style: CSSProperties;
  /** 是否翻到了锚点上方；调用方可据此调箭头/动画方向。 */
  flipUp: boolean;
}

export function useAnchoredLayer(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
): AnchoredLayerPlacement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0, flipUp: false });

  const measure = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const el = ref.current;
    // 自身尺寸可能还没布局出来（首帧 / jsdom 里恒为 0）。此时只按锚点定位，
    // 尺寸相关的钳制与翻转全部跳过——凭 0 宽高算出来的位移是纯噪声。
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = anchor.left;
    let top = anchor.bottom + GAP;
    let flipUp = false;

    if (w > 0) {
      // 先处理右越界，再处理左越界——左侧优先，宁可右边被裁也不能让浮层左缘跑出视口。
      if (left + w > vw - MARGIN) left = vw - MARGIN - w;
      if (left < MARGIN) left = MARGIN;
    }
    if (h > 0 && top + h > vh - MARGIN) {
      const above = anchor.top - GAP - h;
      // 上方装得下就翻上去；两边都装不下（超高面板）就贴着视口底部，至少保证头部可见。
      if (above >= MARGIN) {
        top = above;
        flipUp = true;
      } else {
        top = Math.max(MARGIN, vh - MARGIN - h);
      }
    }

    // 必须做等值判断：本 effect 会因 pos 变化而重跑，不比对就是无限 setState 循环。
    setPos((prev) => (prev.left === left && prev.top === top && prev.flipUp === flipUp ? prev : { left, top, flipUp }));
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();

    // scroll 用 capture：设置页的滚动容器是 `.pw-dlg-body` 而不是 window，
    // 不捕获就收不到它的 scroll，面板会僵在原地不跟随。
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    // 面板自身高度会随状态变化（确认态 → 过程态步骤逐条追加），高度一变就得重新钳位，
    // 否则从「刚好放得下」长到「放不下」时下半截会掉出视口。
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (observer && ref.current) observer.observe(ref.current);

    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [open, measure]);

  return {
    ref,
    style: { position: "fixed", left: pos.left, top: pos.top },
    flipUp: pos.flipUp,
  };
}
