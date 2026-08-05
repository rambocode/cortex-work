// 宠物 sprite 序列帧渲染层。
//
// 用「百分比 sprite」技法逐帧播放,完全不依赖像素、自动跟随 --pet-scale:
//   background-size: calc(frames * 100%) 100%   → 整张 sheet 被缩放成 N 个容器宽,
//                                                  每帧恰好铺满容器一格。
//   @keyframes 把 background-position-x 从 0% 走到 100%,用 steps(frames-1, jump-none)
//   精确停在每一帧(0%、1/(N-1)、…、100% 共 N 个位置 = 帧 0..N-1)。
// 动画/timing 在 cortex-desktop.css 的 .pet-sprite;本组件只注入 CSS 变量与 background。
//
// 角色无 sprite 资产时 resolveSpriteAnim 返回 null → 渲染 null,由 Pet.tsx 回退 SVG。

import { useMemo } from "react";
import type { CSSProperties } from "react";
import type { PetKind, PetState } from "@cortex-work/core";
import { resolveSpriteAnim, spriteKeyFor } from "./sprites";

interface SpriteLayerProps {
  kind: PetKind;
  state: PetState;
}

// CSS 自定义属性需要字符串值;这里扩展 CSSProperties 以容纳 --sprite-* 变量。
type SpriteStyle = CSSProperties & Record<"--sprite-frames" | "--sprite-steps" | "--sprite-dur", string>;

export function SpriteLayer({ kind, state }: SpriteLayerProps) {
  const anim = useMemo(() => resolveSpriteAnim(kind, state), [kind, state]);

  if (!anim) return null;

  // 单帧(frames<=1)无需逐帧动画:steps(<2,jump-none) 非法,退化为静态贴图。
  const animated = anim.frames > 1;
  const durSec = anim.fps > 0 ? anim.frames / anim.fps : 0;

  const style: SpriteStyle = {
    "--sprite-frames": String(anim.frames),
    // jump-none 在 0%→100% 上停 N 个位置(0, 1/(N-1), … 1),恰好命中 N 帧;
    // 故步数 = 帧数 N(不是 N-1,否则会停在两帧中间,出现「半帧+半帧」鬼影)。
    "--sprite-steps": String(Math.max(2, anim.frames)),
    "--sprite-dur": `${durSec}s`,
    // 双引号包裹:资产经打包器内联为 data: URI 时会含括号/引号,裸 url() 无法解析。
    backgroundImage: `url("${anim.src}")`,
    // 一次性动画(loop:false)播完停末帧;pingpong 往复;其余无限循环。
    animationIterationCount: anim.loop === false ? 1 : "infinite",
    animationDirection: anim.loop === "pingpong" ? "alternate" : "normal",
    animationFillMode: anim.loop === false ? "forwards" : "none",
    ...(animated ? null : { animationName: "none" }),
  };

  // key 绑定到动画键:切到不同动画(如 idle→happy)时重挂载节点,使一次性 / 往复
  // 动画从头播放;而 idle/typing 等同映射到 idle 的状态不变 key,保持呼吸连续不闪。
  const animKey = `${kind}:${spriteKeyFor(state)}`;

  return (
    <div
      key={animKey}
      className="pet-sprite"
      data-anim-frames={anim.frames}
      data-anim={`${kind}:${state}`}
      style={style}
      aria-hidden="true"
    />
  );
}
