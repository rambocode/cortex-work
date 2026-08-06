// 听写栏的 preload 窄桥。从 index.ts 拆出:该独立 renderer 不挂 CoreProvider,也不持有
// personal 的整面写入能力——桥面收窄是浮层与主窗口互不覆写的边界。
// (旧「语音聊天浮层」桥已随语音助手改造删除:语音管线挪进主窗口控制器,见
// ipc/voice-assistant.ts 与 views 的 VoiceAssistantController。)

import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AsrSettings,
  AsrTranscribeRequest,
  AsrTranscribeResponse,
  PersistedState,
} from "../main/ipc/types";

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
