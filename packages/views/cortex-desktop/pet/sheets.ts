// 内置宠物(小柯)的 sprite 清单。它是离线与首启的兜底角色——宠物是常驻装饰,
// 用户第一次打开应用时往往网络还没配好,那时右下角不该是一片空白。其余造型走 petdex 图鉴。
//
// 与 petdex 的布局差异(渲染器用同一套 (col,row) 取帧逻辑覆盖两者,不开第二条路径):
//   内置   每个动作一张单行横排的 sheet,故恒取 row 0,列数 = 帧数。
//   petdex 一张 sheet 承载全部动作,行 = 动作、列 = 帧。
//
// 跨打包器约定(关键):资产用纯 ESM import 取 URL,让 Vite(desktop)与 Next(web,
// transpilePackages 含 views)各自解析。两端返回值形状不同——Vite 对任意资产返回字符串
// URL;Next 对**位图**(.webp/.png)返回 { src, width, height } 对象。故统一经 assetUrl()
// 归一化,避免「Next 拿到对象当 URL」的坑。

import type { PetKind, PetState } from "@cortex-work/core";
import type { PetSpriteSource } from "@cortex-work/core/desktop/petdex-types";
import catIdle from "./assets/cat/idle.webp";
import catHappy from "./assets/cat/happy.webp";
import catSleeping from "./assets/cat/sleeping.webp";

type ImportedAsset = string | { src: string };
function assetUrl(a: ImportedAsset): string {
  return typeof a === "string" ? a : a.src;
}

/** 内置角色 id。petdex 接入后收敛为一只:它只承担兜底,造型选择交给图鉴的 4374 只。 */
export const BUILTIN_KIND: PetKind = "cat";
export const BUILTIN_NAME = "小柯";

/** 内置资产的单格尺寸(实测 220×200,是设计尺寸 110×100 的 2x)。 */
export const BUILTIN_CELL_W = 220;
export const BUILTIN_CELL_H = 200;

/** 内置资产只有这三个动作;其余姿态复用 idle 本体,语义靠 CSS 配件层表达。 */
export type BuiltinAnimKey = "idle" | "happy" | "sleeping";

export interface BuiltinAnim {
  src: string;
  /** 横向帧数(= 列数)。 */
  frames: number;
  /** 播放帧率。dur = frames / fps。 */
  fps: number;
}

// fps 偏低是刻意的:这些是「姿态关键帧」而非补间动画,帧少、节奏要慢而柔,否则像快放。
export const BUILTIN_SHEETS: Record<BuiltinAnimKey, BuiltinAnim> = {
  idle: { src: assetUrl(catIdle), frames: 4, fps: 2 }, // 2s 一次呼吸
  happy: { src: assetUrl(catHappy), frames: 5, fps: 6 }, // 0.83s 一跳
  sleeping: { src: assetUrl(catSleeping), frames: 3, fps: 1.5 },
};

/** 姿态 → 内置动作。信息性状态(typing/thinking/working/replying/waiting/failed)复用 idle。 */
export function builtinAnimFor(state: PetState): BuiltinAnimKey {
  if (state === "happy") return "happy";
  if (state === "sleeping") return "sleeping";
  return "idle";
}

/**
 * 内置角色的 sprite 描述符。
 * url 为 null 是刻意的:内置资产由 views 侧的 ESM import 解析,跨打包器返回形状不同
 * (Vite 给字符串、Next 给对象),不能穿过 IPC——渲染端按 origin 自己去查 BUILTIN_SHEETS。
 * cols/rows 对内置资产没有意义(每个动作一张单行 sheet,列数各不相同),填 1×1 占位。
 */
export function builtinSpriteSource(): PetSpriteSource {
  return { origin: "builtin", id: BUILTIN_KIND, url: null, cols: 1, rows: 1, displayName: BUILTIN_NAME };
}
