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
// 当前为占位阶段:cat 指向 assets/cat/*.svg 占位 sheet(自包含、可真实渲染);真实
// 美术由 scripts/pet-sprites/ 的 AI 管线产出 .webp 后,仅需替换下面的 import 与 src。
// 其余 3 角色(shiba/bunny/robot)尚无 sprite → 走 Pet.tsx 的 SVG 兜底路径。

import type { PetKind, PetState } from "@cortex-work/core";

import catIdle from "./assets/cat/idle.svg";
import catWalk from "./assets/cat/walk.svg";
import catHappy from "./assets/cat/happy.svg";
import catSleeping from "./assets/cat/sleeping.svg";

/** sprite 动画键。7 个 PetState 收敛到这 4 个核心动画(见 spriteKeyFor)。 */
export type SpriteAnimKey = "idle" | "walk" | "happy" | "sleeping";

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
  cat: {
    idle: { src: assetUrl(catIdle), frames: 4, frameW: FW, frameH: FH, fps: 5, loop: true },
    walk: { src: assetUrl(catWalk), frames: 4, frameW: FW, frameH: FH, fps: 9, loop: true },
    happy: { src: assetUrl(catHappy), frames: 5, frameW: FW, frameH: FH, fps: 13, loop: false },
    sleeping: { src: assetUrl(catSleeping), frames: 3, frameW: FW, frameH: FH, fps: 3, loop: "pingpong" },
  },
};

/** 该角色是否有 sprite 资产(决定走 sprite 还是 SVG 兜底)。纯函数,便于测试。 */
export function hasSprites(kind: PetKind): boolean {
  const m = PET_SPRITES[kind];
  return !!m && Object.keys(m).length > 0;
}

/**
 * 把 (状态, 是否散步) 映射到 4 个核心动画键。
 * 散步优先(walk 是行为而非 PetState);其余信息性状态(typing/thinking/working/
 * replying)本期复用 idle 本体,状态语义靠后续的 SVG 配件叠加层表达(U4)。
 */
export function spriteKeyFor(state: PetState, walking: boolean): SpriteAnimKey {
  if (walking) return "walk";
  if (state === "happy") return "happy";
  if (state === "sleeping") return "sleeping";
  return "idle";
}

/**
 * 解析出应播放的 SpriteAnim;角色无 sprite 返回 null(交由 SVG 兜底)。
 * 选中的动画键若缺资产,回退到该角色的 idle;idle 也缺则 null。
 */
export function resolveSpriteAnim(kind: PetKind, state: PetState, walking: boolean): SpriteAnim | null {
  const map = PET_SPRITES[kind];
  if (!map) return null;
  const key = spriteKeyFor(state, walking);
  return map[key] ?? map.idle ?? null;
}
