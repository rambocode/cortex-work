// 语音球(pet-overlay 窗口 voice 模式的唯一子树,纯展示镜像)。
//
// 交互约束继承自宠物窗口(focusable:false 的 panel):收不到鼠标移动事件,悬停态由
// 主进程光标轮询(onPetOverlayCursor)推来的坐标判定;CSS :hover 会卡在上一次命中,
// 一律不用。球体 canvas 标 no-drag 承接点击(唤醒/打断),外围容器整块 app-region:drag
// 让 OS 原生拖动窗口(与 Pet 同款方案)。所有动作经 voiceAssistantControl 发回主进程,
// 由主窗口控制器裁决 —— 本组件不跑任何状态机。

import { useEffect, useRef } from "react";
import { Icon } from "@cortex-work/ui/icons";
import type {
  VoiceAssistantControlAction,
  VoiceAssistantFeed,
  VoiceAssistantSnapshot,
} from "@cortex-work/core/desktop/types";
import { createOrbRenderer, type OrbPhase, type OrbRenderer } from "./orbRenderer";

// 与 apps/desktop/src/main/pet-overlay-window.ts 的同名常量保持一致(主进程据此
// setBounds voice 模式窗口),改一处必须改两处。窗口顶部固定预留活动卡片槽位
// (FEED_SLOT_H,无卡片时透明占位),球体位置不随卡片显隐跳动。
export const VOICE_OVERLAY_W = 320;
export const VOICE_OVERLAY_H = 290;

const FEED_SLOT_H = 92;

// 可视区(fx 光晕/脉冲层)与球体直径分离:WebGL 云雾 shader 的圆撑满自己的 canvas,
// 球径由 canvas CSS 尺寸决定,缩放动画走 style.transform 不重建。
const ORB_AREA = 160;
const ORB_DIAMETER = 112;

interface VoiceOrbProps {
  snapshot: VoiceAssistantSnapshot | null;
  /** 高频电平流(独立于快照,30Hz 节流)。 */
  level: number;
  /** 其它会话 agent 活动卡片(标题 + 流式响应尾部);null = 隐藏。 */
  feed: VoiceAssistantFeed | null;
  /** 主进程轮询推来的窗口内光标坐标;null = 不在窗口内。 */
  cursor: { x: number; y: number } | null;
  onControl: (action: VoiceAssistantControlAction) => void;
}

/** 快照阶段 → 渲染器视觉状态(transcribing 归入 thinking:对用户都是「在处理」)。 */
function orbPhase(snapshot: VoiceAssistantSnapshot | null): OrbPhase {
  const phase = snapshot?.phase ?? "idle";
  return phase === "transcribing" ? "thinking" : phase;
}

export function VoiceOrb({ snapshot, level, feed, cursor, onControl }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fxCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<OrbRenderer | null>(null);
  const levelRef = useRef(level);
  const snapshotRef = useRef(snapshot);
  // scanTick 递增 → 换算成本地 performance.now() 时间基准,渲染器按时长播扩散脉冲。
  const scanAtRef = useRef<number | null>(null);
  const lastScanTickRef = useRef(0);

  levelRef.current = level;
  snapshotRef.current = snapshot;
  if ((snapshot?.scanTick ?? 0) !== lastScanTickRef.current) {
    lastScanTickRef.current = snapshot?.scanTick ?? 0;
    if (lastScanTickRef.current > 0) scanAtRef.current = performance.now();
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const fxCanvas = fxCanvasRef.current;
    if (!canvas || !fxCanvas) return;
    rendererRef.current = createOrbRenderer(canvas, fxCanvas);
    let raf = 0;
    const loop = (t: number): void => {
      rendererRef.current?.draw(t, {
        phase: orbPhase(snapshotRef.current),
        targetLevel: levelRef.current,
        scanAt: scanAtRef.current,
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  // 活动卡片内容随流式更新自动滚到底("滚动显示"——始终展示最新输出)。
  const feedTextRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = feedTextRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed?.text]);

  const hovered = cursor !== null;
  const drag = { WebkitAppRegion: "drag" } as React.CSSProperties;
  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
  // 按钮点击要 stopPropagation:容器是拖拽区,冒泡上去会被当成拖拽手势的开始。
  const press = (action: VoiceAssistantControlAction) => ({
    style: noDrag,
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onPointerUp: (e: React.PointerEvent) => e.stopPropagation(),
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      onControl(action);
    },
  });

  return (
    <div className="voice-orb" style={{ width: VOICE_OVERLAY_W, height: VOICE_OVERLAY_H, ...drag }}>
      {/* 其它会话 agent 活动卡片:固定槽位(占位不塌陷,球体不跳),内容滚动显示,
          文本更新自动滚到底(见下方 effect);无卡片时整体淡出。 */}
      <div className="voice-orb-feed-slot" style={{ height: FEED_SLOT_H }}>
        <div className={`voice-orb-feed${feed ? " is-visible" : ""}`} style={noDrag} aria-live="polite">
          <div className="voice-orb-feed-title">{feed?.title ?? ""}</div>
          <div className="voice-orb-feed-text" ref={feedTextRef}>
            {feed?.text ?? ""}
          </div>
        </div>
      </div>
      {/* 双层 canvas:fx(光晕/扫描脉冲)垫底铺满可视区,WebGL 云雾球体居中叠上。
          球体本身是拖拽把手(app-region:drag → OS 原生拖动窗口,点击动作全部走悬停
          按钮);fx 层 pointer-events:none 不参与命中。两个动作按钮沿球体下缘环形吸附
          (悬停显现),无文本提示——状态语义经按钮 title 与球体动画传达。 */}
      <div className="voice-orb-stage" style={{ width: ORB_AREA, height: ORB_AREA }}>
        <canvas ref={fxCanvasRef} className="voice-orb-fx" style={{ width: ORB_AREA, height: ORB_AREA }} />
        <canvas
          ref={canvasRef}
          className="voice-orb-canvas"
          style={{
            width: ORB_DIAMETER,
            height: ORB_DIAMETER,
            marginLeft: -ORB_DIAMETER / 2,
            marginTop: -ORB_DIAMETER / 2,
            ...drag,
          }}
          aria-label="语音球：拖动移动位置"
        />
        <div className={`voice-orb-ctrl${hovered ? " is-open" : ""}`}>
          <button type="button" className="voice-orb-btn voice-orb-btn--mic" title="聆听 / 发送 / 打断" aria-label="聆听或打断" {...press("micToggle")}>
            <Icon.Mic size={14} />
          </button>
          <button type="button" className="voice-orb-btn voice-orb-btn--exit" title="退出语音助手" aria-label="退出语音助手" {...press("exit")}>
            <Icon.X size={13} />
          </button>
          <button type="button" className="voice-orb-btn voice-orb-btn--speaker" title="重播 / 停止朗读" aria-label="重播或停止朗读" {...press("speakerToggle")}>
            <Icon.Speaker size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
