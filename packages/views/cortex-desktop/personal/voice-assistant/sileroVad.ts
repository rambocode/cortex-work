// 语音助手断句监视器的统一入口:Silero 神经 VAD 优先,能量 VAD 兜底。
//
// Silero(经 @ricky0123/vad-web,AudioWorklet + onnxruntime-web)输出帧级「是人声」概率,
// 天然区分人声与键盘/风扇/AGC 抬起的底噪——能量 VAD 的阈值调参、强峰维持窗、噪声底
// 自适应它全都不需要。能量 VAD(./vad.ts)保留两个用途:①模型/wasm 资产加载失败时的
// 兜底(语音助手绝不能因资产缺失而失聪);②测试与无 WebAssembly 环境。
//
// 资产供给(与 electron.vite.config.ts 的 viteStaticCopy + main/vad-assets.ts 协议配套):
// dev 页面是 http://localhost → 同源 /vad/ 由 dev server 服务;打包态页面是 file:// →
// fetch file:// 子资源被 CORS 拦死,改走主进程 cortex-vad://assets/ 只读协议。
//
// 生命周期:MicVAD 单例跨聆听轮次复用(模型加载只付一次,~2MB onnx 不能每轮重载),
// 每轮 start 时经 resumeStream 换接当轮的新录音流;stop 只 pause 不 destroy。
// **共享录音流红线**:pauseStream/resumeStream 必须是 no-op/换流实现——vad-web 默认的
// pauseStream 会 stop 全部 tracks,而这条流同时供 MediaRecorder 录音,停了转写就没了。

import type { MicVAD } from "@ricky0123/vad-web";
import { DEFAULT_VAD_CONFIG, startVadMonitor } from "./vad";

export type VoiceVadEvent = "speech-start" | "speech-end";
export type VoiceVadMode = "listening" | "barge-in";
export type VoiceVadStartSignal = "candidate" | "confirmed";

export interface VoiceVadMonitor {
  /** 实际生效的引擎(上报诊断/日志用)。 */
  engine: "silero" | "energy";
  stop: () => void;
}

interface VadHandlers {
  mode: VoiceVadMode;
  onEvent: (event: VoiceVadEvent) => void;
  onLevel?: (rms: number) => void;
}

// 首次加载(模型下载/实例化)超时上限:本地资产正常几百 ms,超时即判定环境不可用转兜底。
const SILERO_INIT_TIMEOUT_MS = 10_000;

/**
 * Silero V5 人声概率滞回。0.60 比旧 0.50 更能拒绝风扇等模糊稳定声；0.45 保持官方建议的
 * 0.15 滞回差，避免音节边缘反复抖动。`minSpeechMs=300` 不变，保留“啊”等正常短发声。
 */
export const SILERO_SPEECH_THRESHOLDS = {
  positiveSpeechThreshold: 0.6,
  negativeSpeechThreshold: 0.45,
} as const;

/** TTS 播放期先由 Chromium AEC 消除扬声器参考音，再由 Silero 连续人声确认拒绝残余
 * 回声。双讲经过 AEC 后的人声概率会明显降低，不能再抬高概率阈值，否则近讲也无法打断。 */
export const BARGE_IN_SPEECH_THRESHOLDS = {
  positiveSpeechThreshold: 0.6,
  negativeSpeechThreshold: 0.45,
} as const;
// 概率阈值沿用普通聆听，播放期额外等待连续人声确认，保留用户短促“啊/停”的插话。
export const BARGE_IN_MIN_SPEECH_MS = 240;

/** 普通聆听在首个候选人声帧开始保留前滚；播放期间则等满 minSpeechMs 的 confirmed
 * 信号才接管，保证“啊”等短发声仍可打断，同时拒绝单帧回声和爆音。 */
export function shouldStartVoiceTurn(mode: VoiceVadMode, signal: VoiceVadStartSignal): boolean {
  return mode === "barge-in" ? signal === "confirmed" : signal === "candidate";
}

let mic: MicVAD | null = null;
// 当前聆听轮次的流与回调:MicVAD 单例经 getStream/resumeStream 读它,回调经此转发,
// stop 后置 null 让迟到的 worklet 帧变成 no-op。
let currentStream: MediaStream | null = null;
let currentHandlers: VadHandlers | null = null;
// 一次失败永久降级(本会话内):资产缺失/环境不支持不会自愈,每轮重试只会白付超时。
let sileroDisabledReason: string | null = null;

/** 帧级 RMS(驱动语音球电平,与能量 VAD 的 onLevel 同量纲)。 */
function frameRms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/** 资产基址:dev(http)同源 /vad/;打包态走主进程 cortex-vad:// 协议。
    打包态判定用「非 http(s)」而非「=== file:」:主窗口打包态已迁 cortex-app://
    (见 main/renderer-protocol.ts),写成 file: 判定会误走 dev 分支。 */
function assetBase(): string {
  const p = window.location.protocol;
  return p === "http:" || p === "https:"
    ? new URL("vad/", window.location.href).toString()
    : "cortex-vad://assets/";
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function ensureMic(): Promise<MicVAD> {
  if (mic) return mic;
  // 动态 import:web 端(Next)构建不把 vad-web/onnxruntime-web 拉进首包;
  // web 上语音助手本就不激活,这段代码永不执行。
  const vadWeb = await import("@ricky0123/vad-web");
  const base = assetBase();
  const created = await vadWeb.MicVAD.new({
    getStream: async () => {
      if (!currentStream) throw new Error("无当前录音流");
      return currentStream;
    },
    // 红线:共享录音流,pause/destroy 绝不能停 tracks(默认实现会 stop)。
    pauseStream: async () => {},
    resumeStream: async () => {
      if (!currentStream) throw new Error("无当前录音流");
      return currentStream;
    },
    model: "v5",
    baseAssetPath: base,
    onnxWASMBasePath: base,
    startOnLoad: false,
    processorType: "auto",
    // 断句语义与能量 VAD 对齐:1100ms 静音判停 / 300ms 最短语音。概率阈值取 Silero
    // 惯例(负阈值 = 正阈值 - 0.15)。不消费它切出的音频段(录音走 MediaRecorder 原始流),
    // preSpeechPad 置 0 省内存。
    ...SILERO_SPEECH_THRESHOLDS,
    redemptionMs: DEFAULT_VAD_CONFIG.silenceMs,
    minSpeechMs: DEFAULT_VAD_CONFIG.minSpeechMs,
    preSpeechPadMs: 0,
    submitUserSpeechOnPause: false,
    onSpeechStart: () => {
      const handlers = currentHandlers;
      if (handlers && shouldStartVoiceTurn(handlers.mode, "candidate")) {
        handlers.onEvent("speech-start");
      }
    },
    onSpeechEnd: () => currentHandlers?.onEvent("speech-end"),
    // 短于 minSpeechMs 的爆音/咳嗽:丢弃,等同能量 VAD 的短音丢弃,继续聆听。
    onVADMisfire: () => {},
    onSpeechRealStart: () => {
      const handlers = currentHandlers;
      if (!handlers || !shouldStartVoiceTurn(handlers.mode, "confirmed")) return;
      // 一旦确认是用户插话，余下句子继续沿用普通概率阈值。
      // 本句必须继续保留 240ms minSpeechMs：vad-web 会在结束时按“当前”最短帧数
      // 二次校验；这里若立即恢复 300ms，刚好触发插话的短句会被改判为 VADMisfire，
      // 控制器收不到 speech-end，也就无法进入 ASR。下一轮 start 时会恢复正常 300ms。
      handlers.mode = "listening";
      mic?.setOptions(SILERO_SPEECH_THRESHOLDS);
      handlers.onEvent("speech-start");
    },
    onFrameProcessed: (_probs, frame) => currentHandlers?.onLevel?.(frameRms(frame)),
  });
  mic = created;
  return created;
}

/**
 * 为一轮聆听启动断句监视器。返回的 stop 只解除本轮(pause + 摘回调),不销毁模型。
 * Silero 初始化失败(资产缺失/超时/环境不支持)自动降级能量 VAD,并在本会话内不再重试。
 */
export async function createVoiceVadMonitor(
  stream: MediaStream,
  onEvent: (event: VoiceVadEvent) => void,
  onLevel?: (rms: number) => void,
  log?: (message: string) => void,
  mode: VoiceVadMode = "listening",
): Promise<VoiceVadMonitor> {
  if (!sileroDisabledReason) {
    currentStream = stream;
    currentHandlers = { mode, onEvent, onLevel };
    try {
      const instance = await withTimeout(
        ensureMic().then(async (m) => {
          m.setOptions(
            mode === "barge-in"
              ? { ...BARGE_IN_SPEECH_THRESHOLDS, minSpeechMs: BARGE_IN_MIN_SPEECH_MS }
              : { ...SILERO_SPEECH_THRESHOLDS, minSpeechMs: DEFAULT_VAD_CONFIG.minSpeechMs },
          );
          await m.start();
          return m;
        }),
        SILERO_INIT_TIMEOUT_MS,
        "Silero VAD 初始化",
      );
      return {
        engine: "silero",
        stop: () => {
          currentHandlers = null;
          currentStream = null;
          void instance.pause().catch(() => {});
        },
      };
    } catch (err) {
      sileroDisabledReason = err instanceof Error ? err.message : String(err);
      log?.(`[voice-assistant] Silero VAD 不可用,降级能量 VAD: ${sileroDisabledReason}`);
      currentHandlers = null;
      currentStream = null;
      // 半初始化的实例不复用:下次(若解禁)从头再建。
      void mic?.destroy().catch(() => {});
      mic = null;
    }
  }
  // 能量 VAD 兜底:持续监听(无 idle-timeout),语义见 VoiceAssistantController。
  const fallback = startVadMonitor(
    stream,
    (event) => {
      if (event !== "idle-timeout") onEvent(event);
    },
    mode === "barge-in"
      ? {
          ...DEFAULT_VAD_CONFIG,
          maxIdleMs: Number.POSITIVE_INFINITY,
          // 能量 VAD 不具备声源区分能力，只作为 Silero 不可用时的保守兜底。AEC 后仍需
          // 更高能量和更长起音确认，防止扬声器残余与稳定风扇声触发插话。
          enterFactor: 5,
          enterFloor: 0.025,
          exitFactor: 3,
          exitFloor: 0.014,
          confirmMs: BARGE_IN_MIN_SPEECH_MS,
          minSpeechMs: BARGE_IN_MIN_SPEECH_MS,
          strongHangoverMs: 800,
        }
      : { ...DEFAULT_VAD_CONFIG, maxIdleMs: Number.POSITIVE_INFINITY },
    onLevel,
  );
  return { engine: "energy", stop: fallback.stop };
}
