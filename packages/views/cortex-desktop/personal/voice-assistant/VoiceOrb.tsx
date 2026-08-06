// 语音球(pet-overlay 窗口 voice 模式的唯一子树,纯展示镜像)。
//
// 交互约束继承自宠物窗口(focusable:false 的 panel):收不到鼠标移动事件,悬停态由
// 主进程光标轮询(onPetOverlayCursor)推来的坐标判定;CSS :hover 会卡在上一次命中,
// 一律不用。球体 canvas 标 no-drag 承接点击(唤醒/打断),外围容器整块 app-region:drag
// 让 OS 原生拖动窗口(与 Pet 同款方案)。所有动作经 voiceAssistantControl 发回主进程,
// 由主窗口控制器裁决 —— 本组件不跑任何状态机。

import { useEffect, useRef } from "react";
import type {
  VoiceAssistantControlAction,
  VoiceAssistantSnapshot,
} from "@cortex-work/core/desktop/types";
import { createOrbRenderer, type OrbPhase, type OrbRenderer } from "./orbRenderer";

// 与 apps/desktop/src/main/pet-overlay-window.ts 的同名常量保持一致(主进程据此
// setBounds voice 模式窗口),改一处必须改两处。
export const VOICE_OVERLAY_W = 280;
export const VOICE_OVERLAY_H = 380;

const ORB_SIZE = 240;

interface VoiceOrbProps {
  snapshot: VoiceAssistantSnapshot | null;
  /** 高频电平流(独立于快照,30Hz 节流)。 */
  level: number;
  /** 主进程轮询推来的窗口内光标坐标;null = 不在窗口内。 */
  cursor: { x: number; y: number } | null;
  onControl: (action: VoiceAssistantControlAction) => void;
}

/** 快照阶段 → 渲染器视觉状态(transcribing 归入 thinking:对用户都是「在处理」)。 */
function orbPhase(snapshot: VoiceAssistantSnapshot | null): OrbPhase {
  const phase = snapshot?.phase ?? "idle";
  return phase === "transcribing" ? "thinking" : phase;
}

/** 悬停提示文案(设计稿四态 + 审批/错误两个覆盖态)。 */
function hintText(snapshot: VoiceAssistantSnapshot | null): string {
  if (snapshot?.error) return snapshot.error;
  if (snapshot?.awaitingApproval) return "需要在主窗口确认操作";
  switch (snapshot?.phase ?? "idle") {
    case "listening":
      return "正在聆听，停顿自动发送…";
    case "transcribing":
      return "正在转写…";
    case "thinking":
      return "思考中 · 点击打断";
    case "speaking":
      return "正在回复 · 点击打断";
    default:
      return "待机中 · 点击球体唤醒";
  }
}

export function VoiceOrb({ snapshot, level, cursor, onControl }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
    if (!canvas) return;
    rendererRef.current = createOrbRenderer(canvas);
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
    return () => cancelAnimationFrame(raf);
  }, []);

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
      <canvas
        ref={canvasRef}
        className="voice-orb-canvas"
        style={{ width: ORB_SIZE, height: ORB_SIZE, ...noDrag }}
        role="button"
        aria-label="语音球：点击唤醒或打断"
        onClick={() => onControl("ballClick")}
      />
      <div className={`voice-orb-ctrl${hovered ? " is-open" : ""}`}>
        <div className={`voice-orb-hint${snapshot?.error ? " is-error" : ""}`} role="status" aria-live="polite">
          {hintText(snapshot)}
        </div>
        <div className="voice-orb-btns">
          <button type="button" className="voice-orb-btn" title="聆听 / 发送 / 打断" aria-label="聆听或打断" {...press("micToggle")}>
            🎙
          </button>
          <button type="button" className="voice-orb-btn is-exit" title="退出语音助手" aria-label="退出语音助手" {...press("exit")}>
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
