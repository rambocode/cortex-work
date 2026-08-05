// TTS 播放层：把 Agent/LLM 输出朗读出来。
// system 引擎走 renderer 自带的 speechSynthesis（本地零配置）;
// openai 引擎经 DesktopBridge 在主进程调 /v1/audio/speech,音频字节回来播放。
// 始终单实例：新朗读自动打断旧朗读。

import type { DesktopBridge } from "../desktop/bridge";
import type { TtsSettings } from "../desktop/types";

const MAX_SPEECH_CHARS = 600;
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

// 朗读前清洗：去 markdown 标记/代码块/链接等"读不出来"的噪声,并截断。
export function clipSpeechText(text: string, max = MAX_SPEECH_CHARS): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, "（代码略）")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接/图片取文字
    .replace(/^#+\s*/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\n{2,}/g, "。")
    .replace(/\s+/g, " ")
    .trim();
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

async function speakWithOpenai(
  seq: number,
  bridge: DesktopBridge,
  engine: Extract<TtsSettings["engine"], { kind: "openai" }>,
  text: string,
): Promise<void> {
  if (await speakWithOpenaiStream(seq, bridge, engine, text)) return;
  // 非流式回退同样分句流水线:整段一次性送 TTS 要等全篇合成完才有第一声,
  // 本地慢速推理下不可用。播第 i 块的同时预取第 i+1 块(深度 1,不打爆本地推理服务)。
  const chunks = splitSpeechChunks(text, PIPELINE_TEXT_CHARS);
  const firstChunk = chunks[0];
  if (!firstChunk) return;
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
  // 首块的合成失败(鉴权/音色配置错误)与 play() 拒绝按旧契约抛给调用方,保证配置错误可见。
  const first = await synth(firstChunk);
  if (playbackSeq !== seq) return;
  setSpeaking(true);
  const { done: firstDone } = await startBlobPlayback(first);
  // 后续块在后台衔接:speakText 与旧行为一致在首块起播后即 resolve,
  // 播放完成信号经 subscribeTtsPlayback(isSpeaking)对外暴露。
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
        // 后续块失败:首块已验证配置可用,大概率是瞬时故障——播完已有内容安静收尾,不中断整轮。
        buf = null;
      }
      if (playbackSeq !== seq) return;
      if (!buf) break;
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

async function playCleanText(bridge: DesktopBridge | null, settings: TtsSettings, text: string): Promise<void> {
  if (!text) return;
  stopSpeaking();
  const seq = playbackSeq;
  const engine = settings.engine;
  if (engine.kind === "system") {
    speakWithSystem(seq, text, engine.voice, engine.rate);
    return;
  }
  if (!bridge || !engine.baseUrl || !engine.model) return;
  await speakWithOpenai(seq, bridge, engine, text);
}

// 朗读一段文本（按设置选择引擎）。空文本/引擎不可用时静默返回;
// openai 引擎失败抛错由调用方决定提示与否。
export async function speakText(bridge: DesktopBridge | null, settings: TtsSettings, raw: string): Promise<void> {
  const text = clipSpeechText(raw);
  if (!text) return;
  lastSpeech = { text, settings };
  emit();
  await playCleanText(bridge, settings, text);
}

export async function replayLastSpeech(bridge: DesktopBridge | null, settings?: TtsSettings): Promise<void> {
  if (!lastSpeech) return;
  await playCleanText(bridge, settings ?? lastSpeech.settings, lastSpeech.text);
}
