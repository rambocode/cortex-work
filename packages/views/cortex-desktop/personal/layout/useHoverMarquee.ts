// 悬停滚动显示超长标题(借鉴 Codex 侧栏):标题被截断时,悬停后文字左右往返平移,露出被截掉的部分。
// 未截断的标题不滚动;鼠标移开立即复位并恢复省略号。

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

// 滚动速度(px/s)与最短单程时长:短溢出也别一闪而过。
const MARQUEE_SPEED = 40;
const MARQUEE_MIN_SECONDS = 1.5;

export function useHoverMarquee() {
  // 外层:截断容器(overflow:hidden);内层:被平移的文字。
  const containerRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  const frameRef = useRef<number | null>(null);

  const cancelFrame = () => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  };
  useEffect(() => cancelFrame, []);

  // 悬停时 CSS 会给行加右内边距(给操作钮让位),标题可用宽度随之变窄,
  // 所以要等下一帧布局生效后再量溢出量,否则会少滚一截。
  const start = useCallback(() => {
    cancelFrame();
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      const overflow = el.scrollWidth - el.clientWidth;
      setShift(overflow > 1 ? overflow : 0);
    });
  }, []);

  const stop = useCallback(() => {
    cancelFrame();
    setShift(0);
  }, []);

  const scrolling = shift > 0;
  // 平移距离与时长经 CSS 变量交给 @keyframes pw-title-marquee(见 cortex-desktop.css)。
  const style: CSSProperties | undefined = scrolling
    ? ({
        "--pw-marquee-shift": `-${shift}px`,
        "--pw-marquee-duration": `${Math.max(MARQUEE_MIN_SECONDS, shift / MARQUEE_SPEED)}s`,
      } as CSSProperties)
    : undefined;

  return { containerRef, scrolling, style, start, stop };
}
