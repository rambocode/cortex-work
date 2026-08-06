// 宠物的逐帧渲染层:一张 canvas + 一次 drawImage 切帧。
//
// 为什么从 CSS steps() 换成 canvas:此前「播一个动画」的信息被拆在四处——manifest 给
// 帧数/帧率、组件把它翻译成三个 animation-* 属性、CSS 消费 --sprite-* 变量、再靠给节点
// 换 key 强制重挂载来重启一次性动画。换成 canvas 后帧调度只剩这一个文件里的一个定时器,
// 且天然支持二维网格(petdex 的 行=动作、列=帧),不需要再算 background-position-y。
//
// 用 setInterval 而不是 requestAnimationFrame:逐帧动画只需 ~6fps,rAF 会以 60fps 空转,
// 在常驻的 overlay 窗口里白烧电;而且 rAF 在窗口不可见时被节流成不可预期的大 dt,反而要
// 自己做时间累加判帧。

import { useCallback, useEffect, useRef, useState } from "react";
import type { PetState } from "@cortex-work/core";
import type { PetSpriteSource } from "@cortex-work/core/desktop/petdex-types";
import { resolveSheet, type ResolvedSheet } from "./source";
import { loadSheetImage } from "./sheet";

export interface PetCanvasProps {
  /** 当前宠物来源;null 回落内置角色(首启/离线的保证)。 */
  sprite: PetSpriteSource | null;
  state: PetState;
  /** CSS 像素宽度。高度按格子宽高比推算,由本组件通过 onSize 回报给外层。 */
  width: number;
  /** true 时只画第 0 帧、不起定时器(设置页/图鉴的静态预览复用本组件)。 */
  frozen?: boolean;
  /** 回报实际渲染高度,供外层做拖拽夹取与窗口内居中。 */
  onSize?: (size: { width: number; height: number }) => void;
}

/** DPR 上限:5K 屏上 devicePixelRatio 可到 3,再高就是白烧显存,肉眼也看不出。 */
const MAX_DPR = 3;

export function PetCanvas({ sprite, state, width, frozen, onSize }: PetCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const frameRef = useRef(0);

  const sheet: ResolvedSheet | null = resolveSheet(sprite, state);
  const height = sheet ? Math.round((width * sheet.cellH) / sheet.cellW) : Math.round(width);

  // 资产加载。url 变了才重载;卸载后用 alive 挡掉迟到的 setState。
  const url = sheet?.url;
  useEffect(() => {
    if (!url) {
      setImg(null);
      return;
    }
    let alive = true;
    void loadSheetImage(url).then((loaded) => {
      if (alive) setImg(loaded);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  // 换到不同的取帧指令时帧游标归零:一次性动画(happy/failed)必须从第 0 帧起播,
  // 否则会接在上一个动作的中间帧上,看起来像跳帧。
  const sheetKey = sheet?.key;
  useEffect(() => {
    frameRef.current = 0;
  }, [sheetKey]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sheet || !img) return;
    // jsdom 未实现 canvas 2D,getContext 返回 null——静默跳过,别让单测炸在渲染上。
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(MAX_DPR, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const bw = Math.round(width * dpr);
    const bh = Math.round(height * dpr);
    // 重设位图尺寸会清空画布,故只在真的变了时才设。
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 透明背景必须逐帧清,否则半透明的帧会叠成残影。
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(
      img,
      frameRef.current * sheet.cellW,
      sheet.row * sheet.cellH,
      sheet.cellW,
      sheet.cellH,
      0,
      0,
      width,
      height,
    );
  }, [img, sheet, width, height]);

  // 资产就绪 / 换行 / 改尺寸时立刻补一帧,不等下一个定时器周期(否则会有一次可见的空白)。
  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    onSize?.({ width, height });
  }, [onSize, width, height]);

  useEffect(() => {
    if (frozen || !sheet || !img || sheet.frames <= 1) return;
    const timer = setInterval(() => {
      const last = sheet.frames - 1;
      // 一次性动画播到末帧就停住不再推进;回落交给 core/pet 的一次性位到期
      // (故约定 flash 时长 ≥ 单轮时长:happy 2200ms > 6 帧 × 180ms)。
      frameRef.current = sheet.oneShot
        ? Math.min(frameRef.current + 1, last)
        : (frameRef.current + 1) % sheet.frames;
      draw();
    }, Math.max(80, sheet.frameMs));
    return () => clearInterval(timer);
  }, [frozen, sheet, img, draw]);

  return (
    <canvas
      ref={canvasRef}
      className="pet-canvas"
      style={{ width, height }}
      data-sheet={sheet?.key}
      aria-hidden="true"
    />
  );
}
