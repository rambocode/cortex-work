// 图鉴里的一张宠物卡。
//
// 只画第 0 帧、不起定时器:一页 24 张,同时跑 24 个逐帧动画会明显掉帧。用 CSS 背景
// 而不是 canvas 也是为此 —— 卡片不需要精确取帧,把 sheet 缩放成「N 列 × M 行」个容器
// 大小、定位到左上角那一格即可,零 JS 开销。
// loading="lazy" 的等价物:背景图不支持 lazy,故用 IntersectionObserver 延迟设置背景,
// 翻页时快速划过的卡片不会真的发起请求。

import { useEffect, useRef, useState } from "react";
import type { PetdexEntry } from "@cortex-work/core/desktop/petdex-types";

export interface PetdexCardProps {
  entry: PetdexEntry;
  active: boolean;
  onPick: () => void;
}

export function PetdexCard({ entry, active, onPick }: PetdexCardProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    // jsdom / 老环境没有 IntersectionObserver:直接显示,不因为观察不了就永远空白。
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      className={`pw-petdex-card ${active ? "is-active" : ""}`}
      onClick={onPick}
      title={entry.displayName}
    >
      <span
        className="pw-petdex-thumb"
        aria-hidden="true"
        // 网格行列在这里是未知的(要解码才知道),但卡片只取左上第一格,
        // 用固定的 8 列 × 9 行按主流布局缩放即可——多数 sprite 正是这个网格,
        // 少数 11 行/9 列的会略有偏差,对一张缩略图可以接受。
        style={visible ? { backgroundImage: `url("${entry.spritesheetUrl}")` } : undefined}
      />
      <span className="pw-petdex-name">{entry.displayName}</span>
    </button>
  );
}
