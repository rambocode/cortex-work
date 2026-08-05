// 宠物 sprite 序列帧 manifest。
//
// 渲染路线(见 docs/plans/2026-06-27-002):用 CSS `steps()` + 百分比 background
// 逐帧播放角色 sprite sheet,取代内联 SVG。本文件是「数据 + 纯解析函数」,渲染逻辑在
// SpriteLayer.tsx。
//
// 跨打包器约定(关键):资产用纯 ESM `import` 取 URL,让 Vite(desktop)与 Next(web,
// transpilePackages 含 views)各自解析。两端返回值形状不同——Vite 对任意资产返回
// 字符串 URL;Next 对**位图**(.webp/.png)返回 `{ src, width, height }` 对象、对 .svg
// 通常返回字符串。故统一经 `assetUrl()` 归一化,避免「Next 拿到对象当 URL」的坑。
//
// cat、dog 均为 AI 生成的真实 sprite(codex image_gen → 绿幕去背 → 等宽 WebP,
// 见 .claude/skills/codex-image-assets)。dog 缺帧时由 Pet.tsx 回退 designs 的
// SVG 兜底造型(原柴犬 SVG)。

import type { PetKind, PetState } from "@cortex-work/core";

// cat 四核心态均为 AI 生成的真实序列帧(codex image_gen,参考图锚定保持同一只猫
// → 绿幕去背 → ImageMagick 统一缩放/基线对齐拼成等宽 2x sheet → WebP)。
import catIdle from "./assets/cat/idle.webp";
import catHappy from "./assets/cat/happy.webp";
import catSleeping from "./assets/cat/sleeping.webp";
import dogIdle from "./assets/dog/idle.webp";
import dogHappy from "./assets/dog/happy.webp";
import dogSleeping from "./assets/dog/sleeping.webp";
// mint 帧数比 cat/dog 少(idle 3、happy 3、sleeping 2),是首版可行性验证产出,
// 后续可用同一条 codex image_gen 流水线补齐到同等帧数而不影响这里的接线。
import mintIdle from "./assets/mint/idle.webp";
import mintHappy from "./assets/mint/happy.webp";
import mintSleeping from "./assets/mint/sleeping.webp";

/** sprite 动画键。7 个 PetState 收敛到这 3 个核心动画(见 spriteKeyFor)。 */
export type SpriteAnimKey = "idle" | "happy" | "sleeping";

export interface SpriteAnim {
  /** sheet 资产 URL(已归一化)。 */
  src: string;
  /** 横向等宽帧数(N ≥ 1)。 */
  frames: number;
  /** 单帧设计像素宽 / 高(用于宽高比与文档;百分比渲染不依赖其绝对值)。 */
  frameW: number;
  frameH: number;
  /** 播放帧率;dur = frames / fps 秒。 */
  fps: number;
  /** true 循环;false 播一次停在末帧;"pingpong" 往复(animation-direction: alternate)。 */
  loop: boolean | "pingpong";
}

// Vite 返回 string;Next 位图返回 { src,... }。两者都归一化为字符串 URL。
type ImportedAsset = string | { src: string };
function assetUrl(a: ImportedAsset): string {
  return typeof a === "string" ? a : a.src;
}

const FW = 110;
const FH = 100;

/**
 * sprite 资产清单。Partial:某 kind 缺省即「该角色暂无 sprite」,由 Pet.tsx 回退 SVG。
 * 每个 anim 内同样 Partial,缺某动画键时由 resolveSpriteAnim 回退到 idle。
 */
export const PET_SPRITES: Partial<Record<PetKind, Partial<Record<SpriteAnimKey, SpriteAnim>>>> = {
  // fps 偏低是刻意的:这些是「姿态关键帧」而非补间动画,帧少、节奏要慢而柔,
  // 否则像快放。dur = frames/fps:idle 2s 呼吸、happy 0.83s 跳、
  // sleeping 2s/帧(pingpong 往复约 4s)。
  cat: {
    idle: { src: assetUrl(catIdle), frames: 4, frameW: FW, frameH: FH, fps: 2, loop: true },
    happy: { src: assetUrl(catHappy), frames: 5, frameW: FW, frameH: FH, fps: 6, loop: false },
    sleeping: { src: assetUrl(catSleeping), frames: 3, frameW: FW, frameH: FH, fps: 1.5, loop: "pingpong" },
  },
  dog: {
    idle: { src: assetUrl(dogIdle), frames: 4, frameW: FW, frameH: FH, fps: 2, loop: true },
    happy: { src: assetUrl(dogHappy), frames: 5, frameW: FW, frameH: FH, fps: 6, loop: false },
    sleeping: { src: assetUrl(dogSleeping), frames: 3, frameW: FW, frameH: FH, fps: 1.5, loop: "pingpong" },
  },
  // mint 帧数比 cat/dog 少,fps 相应调低,使每个动画的播放时长(dur = frames/fps)
  // 与 cat/dog 保持一致的节奏感(idle 2s、happy 0.83s、sleeping 单程 2s)。
  mint: {
    idle: { src: assetUrl(mintIdle), frames: 3, frameW: FW, frameH: FH, fps: 1.5, loop: true },
    happy: { src: assetUrl(mintHappy), frames: 3, frameW: FW, frameH: FH, fps: 3.6, loop: false },
    sleeping: { src: assetUrl(mintSleeping), frames: 2, frameW: FW, frameH: FH, fps: 1, loop: "pingpong" },
  },
};

/** 该角色是否有 sprite 资产(决定走 sprite 还是 SVG 兜底)。纯函数,便于测试。 */
export function hasSprites(kind: PetKind): boolean {
  const m = PET_SPRITES[kind];
  return !!m && Object.keys(m).length > 0;
}

/**
 * 把状态映射到 3 个核心动画键。信息性状态(typing/thinking/working/replying)
 * 复用 idle 本体,状态语义靠 SVG 配件叠加层表达(见 Pet.tsx 的 .pet-accessories)。
 */
export function spriteKeyFor(state: PetState): SpriteAnimKey {
  if (state === "happy") return "happy";
  if (state === "sleeping") return "sleeping";
  return "idle";
}

/**
 * 解析出应播放的 SpriteAnim;角色无 sprite 返回 null(交由 SVG 兜底)。
 * 选中的动画键若缺资产,回退到该角色的 idle;idle 也缺则 null。
 */
export function resolveSpriteAnim(kind: PetKind, state: PetState): SpriteAnim | null {
  const map = PET_SPRITES[kind];
  if (!map) return null;
  return map[spriteKeyFor(state)] ?? map.idle ?? null;
}
