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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PetState } from "@cortex-work/core";
import type { PetSpriteSource } from "@cortex-work/core/desktop/petdex-types";
import { resolveSheet, type ResolvedSheet } from "./source";
import { loadSheetImage, measureRowFrames } from "./sheet";

export interface PetCanvasProps {
  /** 当前宠物来源;null 回落内置角色(首启/离线的保证)。 */
  sprite: PetSpriteSource | null;
  state: PetState;
  /** CSS 像素宽度。高度按格子宽高比推算,由本组件通过 onSize 回报给外层。 */
  width: number;
  /** true 时只画第 0 帧、不起定时器(设置页/图鉴的静态预览复用本组件)。 */
  frozen?: boolean;
  /** 拖动中的水平方向:非空时改播对应的奔跑行(petdex sprite 才有,见 rows.ts)。 */
  moveDir?: "left" | "right" | null;
  /** 变化一次 = 从第 0 帧重播当前动作。用于双击这类「再来一次」的即时反馈——
   * 姿态没变时 sheet key 也不变,不给这个信号动画就会接在中间帧上,看不出反应。 */
  replayToken?: number;
  /** 回报实际渲染高度,供外层做拖拽夹取与窗口内居中。 */
  onSize?: (size: { width: number; height: number }) => void;
}

/** DPR 上限:5K 屏上 devicePixelRatio 可到 3,再高就是白烧显存,肉眼也看不出。 */
const MAX_DPR = 3;

export function PetCanvas({ sprite, state, width, frozen, moveDir, replayToken, onSize }: PetCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 已解码的图连同它的来源 url 一起存 —— 只有图才知道自己是哪张 sheet 的,下面的配对判断
  // 依赖它(单存 HTMLImageElement 无法回答「手里这张是不是当前该画的那张」)。
  const [loaded, setLoaded] = useState<{ url: string; img: HTMLImageElement } | null>(null);
  const frameRef = useRef(0);

  // 稳定 sheet 引用:resolveSheet 每次调用都返回新对象,直接进 useCallback / useEffect 依赖
  // 会让帧定时器在每次重渲染时被清掉重建 —— 悬停视差的 setTilt 是高频重渲染源,那样动画会
  // 永远卡在第 0 帧。
  // 依赖用 sprite 的**内容指纹**而不是对象引用:overlay 每收到一次 pet:sync-state 就把
  // 快照写回 store,IPC 反序列化出来的 sprite 每次都是新对象 —— 按引用比会让 sheet 每次
  // 都是新对象 → draw 重建 → 下面的帧定时器被 clearInterval/setInterval 反复重来。
  // agent 回复阶段状态切换密集、广播也密集,定时器可能永远等不到下一次触发,动画就此卡住
  // (卡在透明尾帧上时表现为「宠物偶尔不见了」)。
  const spriteKey = sprite ? `${sprite.origin}:${sprite.id}:${sprite.url}:${sprite.cols}x${sprite.rows}` : "";
  const sheet: ResolvedSheet | null = useMemo(
    () => resolveSheet(sprite, state, moveDir),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spriteKey, state, moveDir],
  );
  const height = sheet ? Math.round((width * sheet.cellH) / sheet.cellW) : Math.round(width);

  // 资产加载。url 变了才重载;卸载后用 alive 挡掉迟到的 setState。
  // 解码失败(img 为 null)时刻意不清空 loaded:保留上一张图让画面冻结,好过整只宠物变空白。
  const url = sheet?.url;
  useEffect(() => {
    if (!url) {
      setLoaded(null);
      return;
    }
    let alive = true;
    void loadSheetImage(url).then((img) => {
      if (alive && img) setLoaded({ url, img });
    });
    return () => {
      alive = false;
    };
  }, [url]);

  // ⚠️ 图与 sheet 必须成对使用,不匹配一律当「还没就绪」。
  // 内置角色**每个动作是一张独立的 sheet 且帧数不同**(idle 4 / happy 5 / sleeping 3),
  // 切姿态时 sheet 立刻变、新图还在异步解码。若拿旧图配新 sheet 的帧数取帧,帧游标会走到
  // 旧图宽度之外,drawImage 画出一片空白 =「宠物凭空消失一下」;happy 还是 oneShot,游标被
  // 钳在末帧不回绕,空白会一直挂到新图 onload。故解码完成前不画也不推帧,画面冻结在上一帧,
  // 视觉上是无缝换动作。
  const img = sheet && loaded?.url === sheet.url ? loaded.img : null;

  // 本行真正有内容的帧数。sheet.frames 只是上限(min(6, 列数)),但**每行的有效帧数并不
  // 相同**——实测 waving 行只有 4 帧、jumping 行 5 帧,尾部格子完全透明。照上限播会让宠物
  // 每轮空白几帧(见 sheet.ts 的探测注释)。测不出来时(jsdom / 图被污染)退回上限。
  const [rowFrames, setRowFrames] = useState<readonly number[] | null>(null);
  useEffect(() => {
    if (!img || !sheet) return;
    setRowFrames(measureRowFrames(sheet.url, img, sheet.cellW, sheet.cellH));
  }, [img, sheet]);
  const frames = Math.max(1, Math.min(sheet?.frames ?? 1, rowFrames?.[sheet?.row ?? 0] ?? Number.MAX_SAFE_INTEGER));

  // 换到不同的取帧指令时帧游标归零:一次性动画(happy/failed)必须从第 0 帧起播,
  // 否则会接在上一个动作的中间帧上,看起来像跳帧。
  // replayToken 一并进依赖:姿态不变时 key 不变,靠它才能把同一个动作从头再播一遍。
  // frames 也要进:探测结果回来后帧数可能变小,游标若已越过新的末帧就停在透明格子上了。
  const sheetKey = sheet?.key;
  useEffect(() => {
    frameRef.current = 0;
  }, [sheetKey, replayToken, frames]);

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
    if (frozen || !sheet || !img || frames <= 1) return;
    const timer = setInterval(() => {
      const last = frames - 1;
      // 一次性动画播到末帧就停住不再推进;回落交给 core/pet 的一次性位到期
      // (故约定 flash 时长 ≥ 单轮时长:happy 2200ms > 6 帧 × 180ms)。
      // 末帧取自探测出的有效帧数,不是列数——否则会停在透明格子上,宠物整段消失。
      frameRef.current = sheet.oneShot ? Math.min(frameRef.current + 1, last) : (frameRef.current + 1) % frames;
      draw();
    }, Math.max(80, sheet.frameMs));
    return () => clearInterval(timer);
  }, [frozen, sheet, img, draw, frames]);

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
