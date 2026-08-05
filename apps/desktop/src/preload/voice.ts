// 语音浮层(语音聊天/听写栏)的 preload 窄桥。从 index.ts 拆出:两个独立 renderer 均不挂
// CoreProvider,也不持有 personal 的整面写入能力——桥面收窄是浮层与主窗口互不覆写的边界。

import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AsrSettings,
  AsrTranscribeRequest,
  AsrTranscribeResponse,
  CliExitEvent,
  CliStartRequest,
  CliStreamEvent,
  PersistedState,
  TtsStreamEvent,
  TtsSynthesizeRequest,
  EdgeTtsSynthesizeRequest,
} from "../main/ipc/types";

// 语音聊天浮层专用桥:store 仅允许 loadState 读取当前麦克风/ASR/TTS/默认 agent 设置;
// 聊天只经受限的固定 session 通道读写,绝不暴露 store:save 或任意 chat session ID,
// 避免陈旧全量快照覆盖主窗口设置。
const VOICE_CHAT_SESSION_ID = "voice-chat";

export const voiceChat = {
  onCommand: (cb: (command: "startListening" | "stopAndSubmit" | "focus") => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, command: "startListening" | "stopAndSubmit" | "focus") => cb(command);
    ipcRenderer.on("voice-chat:command", listener);
    return () => ipcRenderer.removeListener("voice-chat:command", listener);
  },
  close: (): Promise<void> => ipcRenderer.invoke("voice:closeChat"),
  loadState: (): Promise<PersistedState> => ipcRenderer.invoke("store:load"),
  loadChat: (): Promise<unknown> => ipcRenderer.invoke("voice-chat:load", VOICE_CHAT_SESSION_ID),
  saveChat: (messages: unknown[]): Promise<void> => ipcRenderer.invoke("voice-chat:save", VOICE_CHAT_SESSION_ID, messages),
  captureScreen: (): Promise<{ path: string; mimeType: "image/png" }> => ipcRenderer.invoke("voice-chat:captureScreen"),
  transcribe: (req: AsrTranscribeRequest, asrSettings: AsrSettings): Promise<AsrTranscribeResponse> =>
    ipcRenderer.invoke("stt:transcribe", { ...req, asrSettings }),
  // 转写 LLM 纠错:开关/模型/prompt 全在主进程按 voiceSettings 决定,失败原文返回。
  polishTranscript: (text: string): Promise<string> => ipcRenderer.invoke("stt:polish", text),
  startCli: (req: CliStartRequest): Promise<void> => ipcRenderer.invoke("cli:start", req),
  killCli: (runId: string): Promise<void> => ipcRenderer.invoke("cli:kill", runId),
  onCliEvent: (cb: (runId: string, event: CliStreamEvent, sessionId?: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { runId: string; sessionId?: string; event: CliStreamEvent }) =>
      cb(payload.runId, payload.event, payload.sessionId);
    ipcRenderer.on("cli:event", listener);
    return () => ipcRenderer.removeListener("cli:event", listener);
  },
  onCliExit: (cb: (exit: CliExitEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, exit: CliExitEvent) => cb(exit);
    ipcRenderer.on("cli:exit", listener);
    return () => ipcRenderer.removeListener("cli:exit", listener);
  },
  // speakText 的 OpenAI 分支需要的两条窄能力;系统语音完全在 renderer 内完成。
  ttsSynthesize: (req: TtsSynthesizeRequest): Promise<ArrayBuffer> => ipcRenderer.invoke("tts:synthesize", req),
  ttsSynthesizeEdge: (req: EdgeTtsSynthesizeRequest): Promise<ArrayBuffer> => ipcRenderer.invoke("tts:synthesizeEdge", req),
  // 流式合成:与 personal.ttsSynthesizeStream 同构(streamId 关联 tts:stream 推送)。
  // 浮层没有它时 speakText 会退回「整段合成完才出声」,本地慢速推理下不可用,故必须暴露。
  // 停止播放时中止在途合成流(否则本地 TTS 服务会继续生成整段并堵塞后续请求)。
  ttsCancelStreams: (): Promise<void> => ipcRenderer.invoke("tts:cancelStreams"),
  ttsSynthesizeStream: async (req: TtsSynthesizeRequest, cb: (event: TtsStreamEvent) => void): Promise<void> => {
    const streamId = crypto.randomUUID();
    const listener = (_e: IpcRendererEvent, payload: { streamId: string; event: TtsStreamEvent }) => {
      if (payload.streamId === streamId) cb(payload.event);
    };
    ipcRenderer.on("tts:stream", listener);
    try {
      await ipcRenderer.invoke("tts:synthesizeStream", { ...req, streamId });
    } finally {
      ipcRenderer.removeListener("tts:stream", listener);
    }
  },
};

// 听写栏专用窄桥:不抢焦 renderer 只能读取转写所需配置、接收主进程状态并提交最终文本;
// 文本注入始终留在 main + Cortex_Helper,不能把 paste 或任意文件访问暴露给浮层。
export const dictation = {
  onState: (cb: (state: { phase: "idle" | "recording" | "transcribing"; token: number }) => void): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      state: { phase: "idle" | "recording" | "transcribing"; token: number },
    ) => cb(state);
    ipcRenderer.on("dictation:state", listener);
    return () => ipcRenderer.removeListener("dictation:state", listener);
  },
  loadState: (): Promise<PersistedState> => ipcRenderer.invoke("store:load"),
  transcribe: (req: AsrTranscribeRequest, asrSettings: AsrSettings): Promise<AsrTranscribeResponse> =>
    ipcRenderer.invoke("stt:transcribe", { ...req, asrSettings }),
  submitResult: (result: { ok: boolean; token: number; text?: string; reason?: string }): Promise<void> =>
    ipcRenderer.invoke("dictation:result", result),
};
