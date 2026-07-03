// 候选气泡窗渲染入口（U6，KTD5）：独立 BrowserWindow 的裸 React root（不包 CoreProvider/QueryClient），
// 只经 window.desktopAPI.replyBubble 直连。窗口 focusable:false（永不聚焦）→ 键盘不走 DOM：
// ←/→/↩/esc/Tab 由 helper 吞键 → controller → 以更新后的 ReplyBubbleState 重推驱动 UI。
// 本渲染端是「纯状态投影」：无本地交互态，仅把主进程推来的 state 画出来 + 上报实测高度 + 上行鼠标动作。
//
// 文案硬编码 zh-Hans（与源项目 ReplyClone 一致，且气泡为瞬态微 UI，暂不接 i18n 命名空间——
// 待 U9 建立 reply i18n 资源后可再分层，届时同步此处）。

import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import type { AsrSettings } from "@cortex-work/core/desktop/media-gen-types";
// 录音采集 + 16kHz WAV + 统一转写核心与 ComposerShell 共用（U8，见 voiceRecorder 文件头注释）。
import { VoiceCapture, transcribeRecording } from "@cortex-work/views/cortex-desktop/voice-recorder";
import "./reply-bubble.css";

// 与 main/ipc/reply-types.ts 的契约同形（跨 tsconfig 不直接 import 主进程类型，结构兼容即可）。
type Phase = "generating" | "presenting" | "recording" | "error";
type ErrorKind = "modelNotConfigured" | "generationFailed" | "emptyCandidates";
interface BubbleState {
  phase: Phase;
  candidates: string[];
  currentIndex: number;
  preGenerating?: boolean;
  errorKind?: ErrorKind;
  errorDetail?: string;
}
type BubbleAction =
  | { type: "flip" }
  | { type: "retry" }
  | { type: "close" }
  | { type: "select"; index: number }
  | { type: "openSettings" };

const INITIAL_STATE: BubbleState = { phase: "generating", candidates: [], currentIndex: 0 };

/// 键盘提示 chip + 说明（纯展示；实际键由 helper 吞键驱动，此处只作可视提示）。
function KeyHint({ chip, label }: { chip: string; label: string }): React.ReactElement {
  return (
    <span className="rb-hint">
      <span className="rb-hint-chip">{chip}</span>
      <span className="rb-hint-label">{label}</span>
    </span>
  );
}

/// 纯展示组件（导出便于单测）：把 state 画成气泡，鼠标动作经 onAction 上行。
export function ReplyBubble({
  state,
  onAction,
}: {
  state: BubbleState;
  onAction: (action: BubbleAction) => void;
}): React.ReactElement {
  // 生成中：彩虹描边胶囊 + 「正在生成回复...」（描边流动动画在 css 里做 hue-rotate）。
  // 同样提供 hover 关闭热区:鼠标用户无需 esc 即可放弃本次生成(controller 会 abort 在途请求)。
  if (state.phase === "generating") {
    return (
      <div className="rb-card rb-pill" role="status" aria-live="polite">
        <div className="rb-close-zone">
          <button className="rb-close" aria-label="关闭" onClick={() => onAction({ type: "close" })}>
            ×
          </button>
        </div>
        <span className="rb-pill-glow" aria-hidden="true" />
        <span className="rb-pill-text">正在生成回复...</span>
      </div>
    );
  }

  // 录音「聆听中」占位（U8 接线真正的 MediaRecorder 宿主；U6 仅呈现状态）。
  if (state.phase === "recording") {
    return (
      <div className="rb-card rb-pill" role="status" aria-live="polite">
        <span className="rb-listening-dot" aria-hidden="true" />
        <span className="rb-pill-text">聆听中…</span>
      </div>
    );
  }

  // 错误态：两类分流。
  if (state.phase === "error") {
    const isModelMissing = state.errorKind === "modelNotConfigured";
    return (
      <div className="rb-card rb-error" role="alert">
        <button className="rb-close" aria-label="关闭" onClick={() => onAction({ type: "close" })}>
          ×
        </button>
        {isModelMissing ? (
          <>
            <div className="rb-error-title">尚未配置生成模型</div>
            <div className="rb-error-desc">请先在设置中添加模型供应商,并为快捷回复选择生成模型。</div>
            <div className="rb-actions">
              <button className="rb-btn rb-btn-primary" onClick={() => onAction({ type: "openSettings" })}>
                去设置
              </button>
              <button className="rb-btn" onClick={() => onAction({ type: "close" })}>
                关闭
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="rb-error-title">
              {state.errorKind === "emptyCandidates" ? "未能生成候选" : "生成失败"}
            </div>
            {state.errorDetail ? <div className="rb-error-desc">{state.errorDetail}</div> : null}
            <div className="rb-actions">
              <button className="rb-btn rb-btn-primary" onClick={() => onAction({ type: "retry" })}>
                重试
              </button>
              <button className="rb-btn" onClick={() => onAction({ type: "close" })}>
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // presenting：候选卡片 + 操作行 + 翻页圆点。卡片本体是拖动区;右上角 hover 热区显影关闭。
  const draft = state.candidates[state.currentIndex] ?? "";
  return (
    <div className="rb-card">
      <div className="rb-close-zone">
        <button className="rb-close" aria-label="关闭" onClick={() => onAction({ type: "close" })}>
          ×
        </button>
      </div>
      <div className="rb-draft">{draft}</div>
      <div className="rb-actions rb-actions-row">
        {/* 翻牌是唯一显式鼠标按钮（追加一条避重候选）；填入/关走键盘为主，此处 chip 仅提示。 */}
        <button className="rb-flip" onClick={() => onAction({ type: "flip" })} aria-label="翻牌">
          <KeyHint chip="← →" label="翻牌" />
        </button>
        <KeyHint chip="↩" label="填入" />
        <button className="rb-close-inline" onClick={() => onAction({ type: "close" })} aria-label="关闭">
          <KeyHint chip="esc" label="关" />
        </button>
        <span className="rb-spacer" />
        <div className="rb-dots" aria-hidden="true">
          {state.candidates.map((_, i) => (
            <button
              key={i}
              className={i === state.currentIndex ? "rb-dot rb-dot-on" : "rb-dot"}
              onClick={() => onAction({ type: "select", index: i })}
              tabIndex={-1}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/// 宿主：订阅主进程状态推送、上报实测高度、上行鼠标动作、承载语音录音（U8）。
function ReplyBubbleHost(): React.ReactElement {
  const api = typeof window !== "undefined" ? window.desktopAPI : undefined;
  const [state, setState] = useState<BubbleState>(INITIAL_STATE);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 进行中的录音会话与其 ASR 配置（onVoice start 携带；stop 时用于转写）。
  const captureRef = useRef<VoiceCapture | null>(null);
  const asrRef = useRef<AsrSettings | null>(null);

  useEffect(() => {
    const bubble = api?.replyBubble;
    if (!bubble) return;
    const off = bubble.onState((s) => setState(s));
    return off;
  }, [api]);

  // ── 语音意图录音（U8，R1 后半 / R9）─────────────────────────────────────────────
  // 录音只能在渲染端做：主进程下发 voice start/stop；stop 时重采样 WAV → 统一转写入口 → 回传文本。
  // 结果（成功文本 / 失败原因）经 submitVoiceResult 回 controller，由其决定起草或提示后回 idle。
  useEffect(() => {
    const bubble = api?.replyBubble;
    if (!bubble?.onVoice) return;

    const submit = (result: { ok: boolean; text?: string; reason?: string }): void =>
      bubble.submitVoiceResult?.(result);
    const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

    // start：申请麦克风并开始录音；失败即回传（controller 提示后回 idle）。
    const startVoice = async (asr: AsrSettings | null): Promise<void> => {
      asrRef.current = asr;
      try {
        const capture = new VoiceCapture();
        await capture.start();
        captureRef.current = capture;
      } catch (err) {
        captureRef.current = null;
        submit({ ok: false, reason: reasonOf(err) });
      }
    };

    // stop：停止录音 → 取音频 → 转写 → 回传文本。空录音 / 未配置 ASR / 转写失败均回传失败原因。
    const stopVoice = async (): Promise<void> => {
      const capture = captureRef.current;
      captureRef.current = null;
      if (!capture) {
        submit({ ok: false, reason: "录音未启动" });
        return;
      }
      let blob: Blob | null = null;
      try {
        blob = await capture.stop();
      } catch (err) {
        submit({ ok: false, reason: reasonOf(err) });
        return;
      }
      if (!blob) {
        submit({ ok: false, reason: "没有录到音频" });
        return;
      }
      const asr = asrRef.current;
      if (!asr) {
        submit({ ok: false, reason: "未配置语音识别" });
        return;
      }
      try {
        // transcribe 复用统一转写入口（stt:transcribe），气泡端只经 replyBubble 桥不触碰 personal。
        const text = await transcribeRecording({ transcribeSpeech: bubble.transcribe }, asr, blob);
        submit({ ok: true, text });
      } catch (err) {
        submit({ ok: false, reason: reasonOf(err) });
      }
    };

    const off = bubble.onVoice((cmd) => {
      if (cmd.command === "start") void startVoice(cmd.asr);
      else void stopVoice();
    });
    return () => {
      off();
      // 窗口复用、effect 清理：释放麦克风，避免录音悬挂。
      captureRef.current?.dispose();
      captureRef.current = null;
    };
  }, [api]);

  // 实测内容高度上报：主进程据此重定位并显示（避免透明窗闪现错误尺寸）。+2 抵消子像素取整。
  useLayoutEffect(() => {
    const bubble = api?.replyBubble;
    if (!bubble) return;
    const h = (rootRef.current?.scrollHeight ?? 0) + 2;
    bubble.resize(h);
  }, [state, api]);

  return (
    <div className="rb-root" ref={rootRef}>
      <ReplyBubble state={state} onAction={(a) => api?.replyBubble?.action(a)} />
    </div>
  );
}

// 仅在真实窗口 document 下自举（组件单测 import 时无 #root，跳过 mount，避免 render null 抛错）。
const rootEl = typeof document !== "undefined" ? document.getElementById("root") : null;
if (rootEl) ReactDOM.createRoot(rootEl).render(<ReplyBubbleHost />);
