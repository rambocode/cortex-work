// TTS 播放层：把 Agent/LLM 输出朗读出来。
// system 引擎走 renderer 自带的 speechSynthesis（本地零配置）;
// openai 引擎经 DesktopBridge 在主进程调 /v1/audio/speech,音频字节回来播放。
// 始终单实例：新朗读自动打断旧朗读。

import type { DesktopBridge } from "../desktop/bridge";
import type { TtsSettings } from "../desktop/types";

const MAX_SPEECH_CHARS = 600;

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

// 当前播放句柄（打断用）。
let currentAudio: HTMLAudioElement | null = null;
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
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  synth?.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
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

async function speakWithOpenai(
  seq: number,
  bridge: DesktopBridge,
  engine: Extract<TtsSettings["engine"], { kind: "openai" }>,
  text: string,
): Promise<void> {
  const buf = await bridge.ttsSynthesize({
    baseUrl: engine.baseUrl,
    apiKey: engine.apiKey,
    model: engine.model,
    voice: engine.voice,
    speed: engine.speed,
    language: engine.language ?? "zh",
    text,
  });
  if (playbackSeq !== seq) return;
  const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
  currentUrl = url;
  const audio = new Audio(url);
  currentAudio = audio;
  audio.onended = () => {
    if (currentUrl === url) {
      URL.revokeObjectURL(url);
      currentUrl = null;
      currentAudio = null;
    }
    if (playbackSeq === seq) setSpeaking(false);
  };
  audio.onerror = () => {
    if (currentUrl === url) {
      URL.revokeObjectURL(url);
      currentUrl = null;
      currentAudio = null;
    }
    if (playbackSeq === seq) setSpeaking(false);
  };
  setSpeaking(true);
  await audio.play();
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
