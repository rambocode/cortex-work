// TTS 播放层：把 Agent/LLM 输出朗读出来。
// system 引擎走 renderer 自带的 speechSynthesis（本地零配置）;
// openai 引擎经 DesktopBridge 在主进程调 /v1/audio/speech,音频字节回来播放。
// 始终单实例：新朗读自动打断旧朗读。

import type { DesktopBridge } from "../desktop/bridge";
import type { TtsSettings } from "../desktop/types";

/** 单轮朗读的累计字数上限；句级流式（ttsSentenceStream）与整轮路径共用同一口径。 */
export const MAX_SPEECH_CHARS = 600;
const STREAM_TEXT_CHARS = 160;
// 非流式回退的分句流水线块长:借鉴 xiaozhi-esp32-server 的「LLM→TTS 按标点切句」策略
// (core/utils/util.py is_segment,遇 ，。？！；： 即切一段送 TTS,首段最小化),块取子句级
// 而非整段合并——本地推理实时率可能低于 1,块越短首包越快。30 字上限:短子句间仍可合并,
// 避免两三个字的碎块;无标点长句才会被硬切。
const PIPELINE_TEXT_CHARS = 30;
// 流式合成的服务端推送间隔(秒)。实测本地 OMLX(M 系芯片):1.0 时首包 ~1.2s,0.3 时 ~0.28s;
// 间隔越小首包越快、chunk 越碎(网络远端服务同样受益)。用户可在引擎配置里覆盖。
const DEFAULT_STREAMING_INTERVAL = 0.3;

export interface TtsPlaybackState {
  isSpeaking: boolean;
  hasLastSpeech: boolean;
}

type TtsPlaybackListener = (state: TtsPlaybackState) => void;

/** 行内清洗（不截断）：去 markdown 标记/代码块/链接等"读不出来"的噪声。
 * 句级流式路径（ttsSentenceStream）逐句复用同一套规则，保证与整轮朗读口径一致。 */
export function sanitizeSpeechInline(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "（代码略）")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接/图片取文字
    .replace(/^#+\s*/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\n{2,}/g, "。")
    .replace(/\s+/g, " ")
    .trim();
}

// 朗读前清洗：去 markdown 标记/代码块/链接等"读不出来"的噪声,并截断。
export function clipSpeechText(text: string, max = MAX_SPEECH_CHARS): string {
  const clean = sanitizeSpeechInline(text);
  return clean.length > max ? clean.slice(0, max) + "……以下省略" : clean;
}

export function splitSpeechChunks(text: string, max = STREAM_TEXT_CHARS): string[] {
  const clean = text.trim();
  if (!clean) return [];
  // 切分标点对齐 xiaozhi 的 is_segment(，。？！；：):冒号也是子句边界,利于首段尽早送出。
  const units = clean.match(/[^。！？!?；;，,：:]+[。！？!?；;，,：:]?/g) ?? [clean];
  const chunks: string[] = [];
  let current = "";
  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = "";
  };

  for (const unit of units) {
    const part = unit.trim();
    if (!part) continue;
    if (part.length > max) {
      pushCurrent();
      for (let i = 0; i < part.length; i += max) chunks.push(part.slice(i, i + max));
      continue;
    }
    if (current && current.length + part.length > max) pushCurrent();
    current += part;
  }
  pushCurrent();
  return chunks;
}

// 当前播放句柄（打断用）。
let currentAudio: HTMLAudioElement | null = null;
// 最近一次 openai 引擎朗读所用的桥:stopSpeaking 无参,靠它把「取消在途合成流」传导到主进程。
let activeBridge: DesktopBridge | null = null;
let currentAudioContext: AudioContext | null = null;
let currentUrl: string | null = null;
let playbackSeq = 0;
let isSpeaking = false;
let lastSpeech: { text: string; settings: TtsSettings } | null = null;
const listeners = new Set<TtsPlaybackListener>();

function snapshot(): TtsPlaybackState {
  return { isSpeaking, hasLastSpeech: !!lastSpeech };
}

function emit(): void {
  const state = snapshot();
  listeners.forEach((listener) => listener(state));
}

function setSpeaking(next: boolean): void {
  if (isSpeaking === next) return;
  isSpeaking = next;
  emit();
}

export function getTtsPlaybackState(): TtsPlaybackState {
  return snapshot();
}

export function subscribeTtsPlayback(listener: TtsPlaybackListener): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}

export function stopSpeaking(): void {
  playbackSeq += 1;
  // 关声音只是表象:必须同时中止主进程在途的合成 fetch,否则本地 TTS 服务会继续
  // 满负荷生成整段文本、堵塞后续请求(失败静默,取消本身不值得打扰用户)。
  void activeBridge?.ttsCancelStreams?.().catch(() => {});
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  synth?.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentAudioContext) {
    void currentAudioContext.close().catch(() => {});
    currentAudioContext = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  setSpeaking(false);
}

function speakWithSystem(seq: number, text: string, voice?: string, rate?: number): void {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  if (!synth) return; // 非浏览器环境（测试等）静默跳过
  const utter = new SpeechSynthesisUtterance(text);
  if (rate && rate > 0) utter.rate = rate;
  if (voice) {
    const match = synth.getVoices().find((v) => v.name === voice);
    if (match) utter.voice = match;
  }
  utter.onend = () => {
    if (playbackSeq === seq) setSpeaking(false);
  };
  utter.onerror = () => {
    if (playbackSeq === seq) setSpeaking(false);
  };
  setSpeaking(true);
  synth.speak(utter);
}

interface StreamAudioPlayer {
  append(chunk: ArrayBuffer): void;
  finish(): void;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(a.length + b.length));
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesFromArrayBuffer(buffer: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(buffer.byteLength));
  out.set(new Uint8Array(buffer));
  return out;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function findAscii(bytes: Uint8Array, target: string, start = 0): number {
  for (let i = start; i <= bytes.length - target.length; i += 1) {
    let ok = true;
    for (let j = 0; j < target.length; j += 1) {
      if (bytes[i + j] !== target.charCodeAt(j)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function isWavChunk(chunk: ArrayBuffer, mimeType?: string): boolean {
  if (mimeType?.toLowerCase().includes("wav")) return true;
  const bytes = new Uint8Array(chunk, 0, Math.min(chunk.byteLength, 12));
  return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
}

function stripWavHeader(chunk: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const bytes = bytesFromArrayBuffer(chunk);
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return bytes;
  const dataAt = findAscii(bytes, "data", 36);
  if (dataAt < 0 || bytes.length < dataAt + 8) return bytes;
  return bytes.slice(dataAt + 8);
}

function makeWavStreamPlayer(seq: number): StreamAudioPlayer {
  const audioContextCtor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!audioContextCtor) throw new Error("当前环境不支持 AudioContext 流式播放");

  const ctx = new audioContextCtor();
  currentAudioContext = ctx;
  void ctx.resume().catch(() => {});

  let pending = new Uint8Array(0);
  let parsed: { channels: number; sampleRate: number; bytesPerSample: number; bytesPerFrame: number } | null = null;
  let nextTime = 0;
  let lastSource: AudioBufferSourceNode | null = null;

  const schedulePcm = (bytes: Uint8Array) => {
    if (!parsed || bytes.length < parsed.bytesPerFrame) return;
    const usable = bytes.length - (bytes.length % parsed.bytesPerFrame);
    const frames = usable / parsed.bytesPerFrame;
    const audioBuffer = ctx.createBuffer(parsed.channels, frames, parsed.sampleRate);
    const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < parsed.channels; channel += 1) {
        const offset = (frame * parsed.channels + channel) * parsed.bytesPerSample;
        const sample = view.getInt16(offset, true) / 32768;
        audioBuffer.getChannelData(channel)[frame] = sample;
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.03, nextTime);
    source.start(startAt);
    nextTime = startAt + audioBuffer.duration;
    lastSource = source;
  };

  const consume = () => {
    if (!parsed) {
      if (pending.length < 44) return;
      if (ascii(pending, 0, 4) !== "RIFF" || ascii(pending, 8, 4) !== "WAVE") {
        throw new Error("TTS 返回的 wav 流头不合法");
      }
      const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
      const channels = view.getUint16(22, true);
      const sampleRate = view.getUint32(24, true);
      const bitsPerSample = view.getUint16(34, true);
      const dataAt = findAscii(pending, "data", 36);
      if (dataAt < 0 || pending.length < dataAt + 8) return;
      if (bitsPerSample !== 16) throw new Error(`暂不支持 ${bitsPerSample}-bit wav TTS 流`);
      parsed = {
        channels,
        sampleRate,
        bytesPerSample: bitsPerSample / 8,
        bytesPerFrame: channels * (bitsPerSample / 8),
      };
      pending = pending.slice(dataAt + 8);
    }

    const usable = pending.length - (pending.length % parsed.bytesPerFrame);
    if (usable <= 0) return;
    const pcm = pending.slice(0, usable);
    pending = pending.slice(usable);
    schedulePcm(pcm);
  };

  return {
    append(chunk) {
      pending = concatBytes(pending, parsed ? stripWavHeader(chunk) : bytesFromArrayBuffer(chunk));
      consume();
    },
    finish() {
      consume();
      if (lastSource) {
        lastSource.onended = () => {
          if (playbackSeq === seq) setSpeaking(false);
        };
      } else if (playbackSeq === seq) {
        setSpeaking(false);
      }
    },
  };
}

async function speakWithOpenaiStream(
  seq: number,
  bridge: DesktopBridge,
  engine: Extract<TtsSettings["engine"], { kind: "openai" }>,
  text: string,
): Promise<boolean> {
  if (engine.stream === false || !bridge.ttsSynthesizeStream) return false;

  activeBridge = bridge;
  setSpeaking(true);

  let streamError: string | null = null;
  let player: StreamAudioPlayer | null = null;
  for (const chunkText of splitSpeechChunks(text)) {
    if (playbackSeq !== seq || streamError) break;
    await bridge.ttsSynthesizeStream(
      {
        baseUrl: engine.baseUrl,
        apiKey: engine.apiKey,
        model: engine.model,
        voice: engine.voice,
        speed: engine.speed,
        language: engine.language ?? "zh",
        stream: true,
        streamingInterval: engine.streamingInterval ?? DEFAULT_STREAMING_INTERVAL,
        text: chunkText,
      },
      (event) => {
        if (playbackSeq !== seq) return;
        if (event.type === "chunk") {
          if (!player) {
            if (!isWavChunk(event.chunk, event.mimeType)) {
              streamError = `暂不支持 ${event.mimeType ?? "unknown"} TTS 流式播放`;
              setSpeaking(false);
              return;
            }
            player = makeWavStreamPlayer(seq);
          }
          player.append(event.chunk);
        } else if (event.type === "error") {
          streamError = event.error;
          setSpeaking(false);
        }
      },
    );
  }
  if (streamError) throw new Error(streamError);
  const activePlayer = player as StreamAudioPlayer | null;
  activePlayer?.finish();
  return true;
}

/** 播放一段完整音频字节。play() 的拒绝(自动播放策略等)向上抛;返回的 done 在自然播完、
 * 解码出错或被外部 pause(stopSpeaking 打断)时 resolve——流水线靠它衔接下一块。
 * done 不 reject,中断语义统一由调用方对 playbackSeq 判定。
 * 注意用对象包裹 done:async 函数直接 return Promise 会被外层收养,调用方 await 就变成等播完。 */
async function startBlobPlayback(buf: ArrayBuffer): Promise<{ done: Promise<void> }> {
  const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
  currentUrl = url;
  const audio = new Audio(url);
  currentAudio = audio;
  const done = new Promise<void>((resolve) => {
    const settle = () => {
      if (currentUrl === url) {
        URL.revokeObjectURL(url);
        currentUrl = null;
        currentAudio = null;
      }
      resolve();
    };
    audio.onended = settle;
    audio.onerror = settle;
    // stopSpeaking 打断走 pause():立即放行流水线(seq 已失效,链路随即自然退出)。
    audio.onpause = settle;
  });
  await audio.play();
  return { done };
}

/**
 * mp3 完整包的分句流水线。Edge 与 OpenAI 都返回可由 HTMLAudioElement 播放的 mp3，
 * 统一在这里保证首块起播后预取一块、后续失败不打断已开始的朗读。
 */
async function runChunkPipeline(
  seq: number,
  text: string,
  synth: (chunkText: string) => Promise<ArrayBuffer>,
): Promise<void> {
  const chunks = splitSpeechChunks(text, PIPELINE_TEXT_CHARS);
  const firstChunk = chunks[0];
  if (!firstChunk) return;
  const first = await synth(firstChunk);
  if (playbackSeq !== seq) return;
  setSpeaking(true);
  const { done: firstDone } = await startBlobPlayback(first);
  void (async () => {
    let done = firstDone;
    let nextIndex = 1;
    let pending = nextIndex < chunks.length ? synth(chunks[nextIndex]!) : null;
    while (pending) {
      await done;
      if (playbackSeq !== seq) return;
      let buf: ArrayBuffer | null;
      try {
        buf = await pending;
      } catch {
        buf = null;
      }
      if (playbackSeq !== seq || !buf) break;
      nextIndex += 1;
      pending = nextIndex < chunks.length ? synth(chunks[nextIndex]!) : null;
      try {
        ({ done } = await startBlobPlayback(buf));
      } catch {
        break;
      }
    }
    await done;
    if (playbackSeq === seq) setSpeaking(false);
  })();
}

async function speakWithOpenai(
  seq: number,
  bridge: DesktopBridge,
  engine: Extract<TtsSettings["engine"], { kind: "openai" }>,
  text: string,
): Promise<void> {
  if (await speakWithOpenaiStream(seq, bridge, engine, text)) return;
  activeBridge = bridge;
  const synth = (chunkText: string) =>
    bridge.ttsSynthesize({
      baseUrl: engine.baseUrl,
      apiKey: engine.apiKey,
      model: engine.model,
      voice: engine.voice,
      speed: engine.speed,
      language: engine.language ?? "zh",
      stream: engine.stream ?? true,
      streamingInterval: engine.streamingInterval ?? DEFAULT_STREAMING_INTERVAL,
      text: chunkText,
    });
  // 首块失败仍向上抛，设置页可以展示真实配置错误。
  await runChunkPipeline(seq, text, synth);
}

async function speakWithEdge(
  seq: number,
  bridge: DesktopBridge,
  engine: Extract<TtsSettings["engine"], { kind: "edge" }>,
  text: string,
): Promise<void> {
  if (!bridge.ttsSynthesizeEdge) throw new Error("当前桌面版本不支持 Edge TTS");
  activeBridge = bridge;
  await runChunkPipeline(seq, text, (chunkText) => bridge.ttsSynthesizeEdge!({ text: chunkText, voice: engine.voice, rate: engine.rate }));
}

async function playCleanText(
  bridge: DesktopBridge | null,
  settings: TtsSettings,
  text: string,
  opts?: { allowFallback?: boolean },
): Promise<void> {
  if (!text) return;
  stopSpeaking();
  const seq = playbackSeq;
  const engine = settings.engine;
  if (engine.kind === "system") {
    speakWithSystem(seq, text, engine.voice, engine.rate);
    return;
  }
  // Edge 合成必须经主进程 WSS：Web 壳（bridge 为 null）与旧桌面版本没有这条通道，
  // 但浏览器自带 speechSynthesis 可用——按能力降级到系统语音，不能静默无声。
  if (engine.kind === "edge") {
    if (!bridge?.ttsSynthesizeEdge) {
      speakWithSystem(seq, text);
      return;
    }
    try {
      await speakWithEdge(seq, bridge, engine, text);
    } catch (error) {
      if (!opts?.allowFallback) throw error;
      // 后台自动朗读不可静音：在线 Edge 不可用时明确回落唯一离线引擎。
      console.warn("[tts] Edge TTS 失败，已回落系统语音", error);
      speakWithSystem(seq, text);
    }
    return;
  }
  if (!bridge || !engine.baseUrl || !engine.model) return;
  await speakWithOpenai(seq, bridge, engine, text);
}

// 朗读一段文本（按设置选择引擎）。空文本/引擎不可用时静默返回;
// openai 引擎失败抛错由调用方决定提示与否。
export async function speakText(
  bridge: DesktopBridge | null,
  settings: TtsSettings,
  raw: string,
  opts?: { allowFallback?: boolean },
): Promise<void> {
  const text = clipSpeechText(raw);
  if (!text) return;
  lastSpeech = { text, settings };
  emit();
  await playCleanText(bridge, settings, text, opts);
}

export async function replayLastSpeech(bridge: DesktopBridge | null, settings?: TtsSettings): Promise<void> {
  if (!lastSpeech) return;
  await playCleanText(bridge, settings ?? lastSpeech.settings, lastSpeech.text);
}

// ── 句级流式播放队列（SpeechStream）──
// 语音助手「LLM 边生成边朗读」的播放层：句子闭合即可 append，不必等整轮文本。
// 必须住在本文件内共享 playbackSeq / setSpeaking / currentAudio / activeBridge 这组
// 模块级单例互斥体——由此免费获得三件事：新朗读自动打断旧朗读、stopSpeaking() 一刀切
// （barge-in 的取消语义零改动）、isSpeaking 广播直接接进状态机的「真起播闭锁」。

/** 可追加的句级播放流。append/finalize 在被打断（seq 失配）后自动变 no-op。 */
export interface SpeechStream {
  /** 入队一句（已由 SentenceAssembler 清洗）。 */
  append(sentence: string): void;
  /** 声明不再有新句子；队列播尽后才落 isSpeaking=false。 */
  finalize(): void;
  /** 全部播完或被打断后 resolve（不 reject；打断语义由调用方按状态机判定）。 */
  settled: Promise<void>;
  /** 首句就失败且从未起播：调用方应降级走整轮朗读旧路径。 */
  failedBeforeStart(): boolean;
}

/**
 * 创建句级流式播放队列。引擎不可用（edge 无桥 / openai 缺配置）时返回 null，
 * 调用方回退整轮朗读路径。
 *
 * ⚠️ isSpeaking 生命周期是本函数最大红线：首句真正起播才置 true；此后句间隙、合成
 * 等待、队列暂空都【不得】落 false，直到「已 finalize 且队列播尽」或被 stopSpeaking
 * 打断。句间误落 false 会被语音助手状态机当成自然播完 → 提前收轮 + 重开麦克风，
 * 而 agent 可能还在生成——该性质由单测锁死。
 */
export function createSpeechStream(bridge: DesktopBridge | null, settings: TtsSettings): SpeechStream | null {
  const engine = settings.engine;
  // system 引擎：speechSynthesis 自带队列，独立实现见下。
  if (engine.kind === "system") return createSystemSpeechStream(settings, engine);
  if (engine.kind === "edge" && !bridge?.ttsSynthesizeEdge) return null;
  // openai 引擎 v1 不接句级流式，返回 null 回退整轮朗读旧路径：该引擎的既有链路是
  // 真流式 WAV 播放器（逐块剥 WAV 头），而句级队列走整块 POST——OMLX 类本地服务在
  // stream:false / 逐句整块两种姿势下都可能返回多段 WAV 封装，HTMLAudio 直接播放
  // 会把内嵌头当采样读出来，用户听到的是一段杂音（实测回归）。待句级队列接入
  // makeWavStreamPlayer 后再放开。
  if (engine.kind === "openai") return null;

  stopSpeaking();
  const seq = playbackSeq;
  activeBridge = bridge;

  // 走到这里只剩 edge 引擎：逐句(内部再按 30 字切块)合成整块 mp3,HTMLAudio 播放。
  const synth = (chunkText: string): Promise<ArrayBuffer> =>
    bridge!.ttsSynthesizeEdge!({ text: chunkText, voice: engine.voice, rate: engine.rate });

  const chunkQueue: string[] = [];
  const spoken: string[] = [];
  let finalized = false;
  let started = false;
  let firstFailed = false;
  let pumping = false;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const waiters: Array<() => void> = [];
  const notify = () => {
    waiters.splice(0).forEach((wake) => wake());
  };
  const waitForMore = () => new Promise<void>((resolve) => waiters.push(resolve));

  /** 取下一块待合成文本；队列暂空且未 finalize 时挂起等待（期间不落 isSpeaking）。 */
  async function nextChunk(): Promise<string | null> {
    while (playbackSeq === seq) {
      const chunk = chunkQueue.shift();
      if (chunk !== undefined) return chunk;
      if (finalized) return null;
      await waitForMore();
    }
    return null;
  }

  async function pump(): Promise<void> {
    let pendingSynth: Promise<ArrayBuffer | null> | null = null;
    while (playbackSeq === seq) {
      if (!pendingSynth) {
        const text = await nextChunk();
        if (text === null) break;
        pendingSynth = synth(text).catch(() => null);
      }
      const buf = await pendingSynth;
      pendingSynth = null;
      if (playbackSeq !== seq) break;
      // 预取：播放当前块时并行合成下一块（与 runChunkPipeline 同款首包/衔接优化）。
      const upcoming = chunkQueue.shift();
      if (upcoming !== undefined) pendingSynth = synth(upcoming).catch(() => null);
      if (!buf) {
        // 首句失败且从未起播 → 大概率是配置/网络问题，携带降级信号退出；
        // 已开播后的失败只跳过该块（对齐 runChunkPipeline 的语义）。
        if (!started) {
          firstFailed = true;
          break;
        }
        continue;
      }
      let done: Promise<void>;
      try {
        ({ done } = await startBlobPlayback(buf));
      } catch {
        if (!started) {
          firstFailed = true;
          break;
        }
        continue;
      }
      // 真起播（audio.play() 已 resolve）才置 true——比整轮路径更严格，杜绝假起播。
      if (!started && playbackSeq === seq) {
        started = true;
        setSpeaking(true);
      }
      await done;
    }
    // 只有仍持有 seq（自然播尽/首句失败）才由我们落 false；被打断时 stopSpeaking 已处理。
    if (playbackSeq === seq && started) setSpeaking(false);
    resolveSettled();
  }

  return {
    append(sentence: string): void {
      if (playbackSeq !== seq) return;
      const trimmed = sentence.trim();
      if (!trimmed) return;
      spoken.push(trimmed);
      // 句内再按 30 字二次切块：长句也能保持小块首包与流水衔接。
      chunkQueue.push(...splitSpeechChunks(trimmed, PIPELINE_TEXT_CHARS));
      notify();
      if (!pumping) {
        pumping = true;
        void pump();
      }
    },
    finalize(): void {
      if (playbackSeq !== seq) return;
      finalized = true;
      // 全部句子拼接写入 lastSpeech，保住「重播上一段」功能（与整轮路径口径一致）。
      if (spoken.length > 0) {
        lastSpeech = { text: spoken.join(""), settings };
        emit();
      }
      notify();
      if (!pumping) {
        // 一句都没 append 就 finalize：无声轮，直接了结。
        resolveSettled();
      }
    },
    settled,
    failedBeforeStart: () => firstFailed,
  };
}

/** system 引擎的句级流：speechSynthesis 天然队列，逐句 speak。 */
function createSystemSpeechStream(
  settings: TtsSettings,
  engine: Extract<TtsSettings["engine"], { kind: "system" }>,
): SpeechStream | null {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  if (!synth) return null;

  stopSpeaking();
  const seq = playbackSeq;
  const spoken: string[] = [];
  let finalized = false;
  let started = false;
  let outstanding = 0;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  const maybeFinish = () => {
    if (!finalized || outstanding > 0) return;
    if (playbackSeq === seq && started) setSpeaking(false);
    resolveSettled();
  };

  return {
    append(sentence: string): void {
      if (playbackSeq !== seq) return;
      const trimmed = sentence.trim();
      if (!trimmed) return;
      spoken.push(trimmed);
      outstanding += 1;
      const utter = new SpeechSynthesisUtterance(trimmed);
      if (engine.rate && engine.rate > 0) utter.rate = engine.rate;
      if (engine.voice) {
        const match = synth.getVoices().find((v) => v.name === engine.voice);
        if (match) utter.voice = match;
      }
      utter.onstart = () => {
        if (!started && playbackSeq === seq) {
          started = true;
          setSpeaking(true);
        }
      };
      const settle = () => {
        outstanding -= 1;
        maybeFinish();
      };
      utter.onend = settle;
      utter.onerror = settle;
      synth.speak(utter);
    },
    finalize(): void {
      if (playbackSeq !== seq) return;
      finalized = true;
      if (spoken.length > 0) {
        lastSpeech = { text: spoken.join(""), settings };
        emit();
      }
      maybeFinish();
    },
    settled,
    // system 是本地引擎，utterance 失败率可忽略；不提供首句降级信号。
    failedBeforeStart: () => false,
  };
}
