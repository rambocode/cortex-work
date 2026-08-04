// 系统级听写栏 renderer：只接收主进程的阶段命令，录音和转写完成后把结果交回窄 bridge。
// 窗口本身由主进程设为 focusable: false；这里也不渲染任何可交互控件，确保不会夺走目标应用的输入焦点。

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import ReactDOM from "react-dom/client";
import type { DesktopBridge } from "@cortex-work/core";
import type { AsrSettings, PersistedState } from "@cortex-work/core/desktop/types";
import { VoiceCapture, transcribeRecording } from "@cortex-work/views/cortex-desktop/voice-recorder";
import "./dictation-bar.css";

type DictationPhase = "idle" | "recording" | "transcribing";
type DictationState = { phase: DictationPhase; token: number };
type DictationResult =
  | { ok: true; text: string; token: number }
  | { ok: false; token: number; reason?: string };

/** 听写栏只拥有录音、转写和回传能力，不能读写主窗口的完整 personal 状态。 */
interface DictationBridge {
  onState(callback: (state: DictationState) => void): () => void;
  loadState(): Promise<PersistedState>;
  transcribe: NonNullable<DesktopBridge["transcribeSpeech"]>;
  submitResult(result: DictationResult): Promise<void> | void;
}

interface AudioMeter {
  stop(): void;
}

function getDictationBridge(): DictationBridge | undefined {
  // preload 的全局 DesktopBridge 面向主窗口，听写栏只在其上附加一个更窄的 dictation 命名空间。
  // 用局部断言隔离过渡期类型，避免让这个 renderer 获得 desktopAPI 的其它写入能力。
  return (window as unknown as { desktopAPI?: { dictation?: DictationBridge } }).desktopAPI?.dictation;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 将 AnalyserNode 的 unsigned 8-bit 时域采样归一化为 0 到 1 的电平。
 * 静音中心值为 128；RMS 可避免单一样本尖峰让电平条持续跳满。
 */
export function waveformLevel(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/**
 * 从 VoiceCapture 正在使用的同一条 MediaStream 建立电平表。
 * 不连接 destination，因而不会把麦克风声音回放到扬声器；stop 会同步取消动画并关闭 AudioContext。
 */
function startAudioMeter(stream: MediaStream, onLevel: (level: number) => void): AudioMeter | null {
  const AudioContextConstructor = window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return null;

  const context = new AudioContextConstructor();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.78;
  source.connect(analyser);

  const samples = new Uint8Array(analyser.fftSize);
  let frameId: number | null = null;
  let stopped = false;
  const sample = (): void => {
    if (stopped) return;
    analyser.getByteTimeDomainData(samples);
    onLevel(waveformLevel(samples));
    frameId = window.requestAnimationFrame(sample);
  };
  sample();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (frameId != null) window.cancelAnimationFrame(frameId);
      source.disconnect();
      analyser.disconnect();
      // close 是异步的；听写过程不依赖其完成，且拒绝不会影响已停止的录音轨道。
      void context.close().catch(() => undefined);
    },
  };
}

function phaseLabel(phase: DictationPhase, error: string): string {
  if (phase === "recording") return "正在听写";
  if (phase === "transcribing") return "正在识别语音…";
  return error || "听写已就绪";
}

function DictationBar(): ReactElement {
  const api = getDictationBridge();
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState(api ? "" : "听写服务不可用");
  const phaseRef = useRef<DictationPhase>("idle");
  const captureRef = useRef<VoiceCapture | null>(null);
  const meterRef = useRef<AudioMeter | null>(null);
  const runTokenRef = useRef(0);
  // 这是主进程 DictationSession 的 token，不等同 renderer 自己用于作废 getUserMedia 回调的 runToken。
  const dictationTokenRef = useRef(0);
  const stopRequestedTokenRef = useRef<number | null>(null);
  const finalizingTokenRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const stopMeter = useCallback((): void => {
    meterRef.current?.stop();
    meterRef.current = null;
    setLevel(0);
  }, []);

  /** 作废当前轮的迟到回调，并立即释放同一条麦克风流及其电平监测器。 */
  const abandonActiveCapture = useCallback((): void => {
    runTokenRef.current += 1;
    stopRequestedTokenRef.current = null;
    finalizingTokenRef.current = null;
    captureRef.current?.dispose();
    captureRef.current = null;
    stopMeter();
  }, [stopMeter]);

  const submitFailure = useCallback(async (token: number, dictationToken: number, reason: string): Promise<void> => {
    // idle 代表主进程已取消本轮；此时不能把旧失败结果再送回去覆盖新状态。
    if (!api || !mountedRef.current || token !== runTokenRef.current || phaseRef.current === "idle") return;
    setError(reason);
    try {
      await api.submitResult({ ok: false, reason, token: dictationToken });
    } catch {
      // 主进程窗口销毁时 IPC 可能拒绝；此处没有安全的重试目标，静默结束这轮 renderer 工作。
    }
  }, [api]);

  const stopAndTranscribe = useCallback(async (token: number, dictationToken: number): Promise<void> => {
    if (!api || token !== runTokenRef.current) return;
    const capture = captureRef.current;
    // 快捷键可能在 getUserMedia 尚未 resolve 时再次触发；start 完成后会读取此标记并继续停录。
    if (!capture) {
      stopRequestedTokenRef.current = token;
      return;
    }
    if (finalizingTokenRef.current === token) return;
    finalizingTokenRef.current = token;
    captureRef.current = null;
    stopMeter();

    try {
      const blob = await capture.stop();
      if (!blob) throw new Error("没有录到音频");
      const config = await api.loadState();
      const asr = config.asrSettings as AsrSettings | undefined;
      if (!asr?.enabled) throw new Error("请先在语音设置中启用语音识别");
      // transcribeRecording 统一把 MediaRecorder Blob 重采样成 16kHz 单声道 WAV，再调用窄 bridge。
      const text = (await transcribeRecording({ transcribeSpeech: api.transcribe }, asr, blob, {
        prompt: config.voiceSettings?.dictationDictionary.join("，"),
      })).trim();
      if (!text) throw new Error("没有识别到语音内容");
      // 取消会让 token 递增；晚到的转写绝不能写回已切换的前台应用。
      if (!mountedRef.current || token !== runTokenRef.current || phaseRef.current !== "transcribing") return;
      await api.submitResult({ ok: true, text, token: dictationToken });
    } catch (err) {
      await submitFailure(token, dictationToken, errorMessage(err));
    } finally {
      capture.dispose();
    }
  }, [api, stopMeter, submitFailure]);

  const startRecording = useCallback(async (dictationToken: number): Promise<void> => {
    if (!api) return;
    const token = runTokenRef.current + 1;
    runTokenRef.current = token;
    stopRequestedTokenRef.current = null;
    finalizingTokenRef.current = null;
    setError("");
    try {
      const config = await api.loadState();
      const capture = new VoiceCapture();
      await capture.start(config.voiceSettings?.micDeviceId || undefined);
      // 若开始期间收到了 idle，组件已取消本轮，不能再保留一条晚到的麦克风流。
      if (!mountedRef.current || token !== runTokenRef.current) {
        capture.dispose();
        return;
      }
      captureRef.current = capture;
      const stream = capture.mediaStream;
      if (stream) meterRef.current = startAudioMeter(stream, setLevel);
      if (stopRequestedTokenRef.current === token || phaseRef.current !== "recording") {
        void stopAndTranscribe(token, dictationToken);
      }
    } catch (err) {
      await submitFailure(token, dictationToken, errorMessage(err));
    }
  }, [api, stopAndTranscribe, submitFailure]);

  useEffect(() => {
    if (!api) return;
    const offState = api.onState((nextState) => {
      // Electron IPC 正常按序投递，但窗口重载/旧 did-finish-load 回调仍可能送来上一轮状态。
      // token 单调递增时丢弃它，避免旧 recording 命令再次打开麦克风。
      if (nextState.token < dictationTokenRef.current) return;
      dictationTokenRef.current = nextState.token;
      const nextPhase = nextState.phase;
      const previousPhase = phaseRef.current;
      phaseRef.current = nextPhase;
      setPhase(nextPhase);
      if (nextPhase === "recording" && previousPhase !== "recording") {
        void startRecording(nextState.token);
      } else if (nextPhase === "transcribing" && previousPhase === "recording") {
        void stopAndTranscribe(runTokenRef.current, nextState.token);
      } else if (nextPhase === "idle" && previousPhase !== "idle") {
        // 主进程取消或完成后由它驱动 idle；renderer 只做本地资源回收，绝不主动夺焦或写回剪贴板。
        abandonActiveCapture();
      }
    });
    return () => offState();
  }, [abandonActiveCapture, api, startRecording, stopAndTranscribe]);

  useEffect(() => () => {
    mountedRef.current = false;
    abandonActiveCapture();
  }, [abandonActiveCapture]);

  const meterHeight = `${Math.round(10 + level * 24)}px`;
  return (
    <main className={`db-shell is-${phase}`} aria-live="polite" aria-label="系统听写状态">
      <section className="db-card">
        <span className="db-indicator" aria-hidden="true" />
        <div className="db-copy">
          <strong>系统听写</strong>
          <span>{phaseLabel(phase, error)}</span>
        </div>
        <div className="db-meter" aria-label={`麦克风电平 ${Math.round(level * 100)}%`}>
          <span className="db-meter-fill" style={{ height: meterHeight }} />
        </div>
      </section>
    </main>
  );
}

// 单元测试只导入电平纯函数且运行在 Node 环境；实际 renderer 必定具有 #root。
if (typeof document !== "undefined") {
  ReactDOM.createRoot(document.getElementById("root")!).render(<DictationBar />);
}
