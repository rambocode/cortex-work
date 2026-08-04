// 语音聊天浮层的可测试状态机。异步副作用（录音、转写、CLI、TTS）留在宿主组件，
// 这里仅约束可见阶段，防止全局快捷键重复按下时启动重叠的 MediaRecorder 会话。

export type VoiceChatPhase = "idle" | "recording" | "transcribing" | "sending" | "speaking";

export interface VoiceChatState {
  phase: VoiceChatPhase;
  error?: string;
}

export type VoiceChatEvent =
  | { type: "startListening" }
  | { type: "stopAndSubmit" }
  | { type: "transcribed" }
  | { type: "responseComplete" }
  | { type: "speechFinished" }
  | { type: "failed"; message: string };

export const initialVoiceChatState: VoiceChatState = { phase: "idle" };

/**
 * 仅接受状态机允许的下一步；无效事件返回原对象，令宿主可安全忽略迟到 IPC/录音回调。
 * 失败总是回 idle，确保用户不需要重开窗口即可再次录音。
 */
export function transitionVoiceChat(state: VoiceChatState, event: VoiceChatEvent): VoiceChatState {
  if (event.type === "failed") return { phase: "idle", error: event.message };

  switch (state.phase) {
    case "idle":
      return event.type === "startListening" ? { phase: "recording" } : state;
    case "recording":
      return event.type === "stopAndSubmit" ? { phase: "transcribing" } : state;
    case "transcribing":
      return event.type === "transcribed" ? { phase: "sending" } : state;
    case "sending":
      return event.type === "responseComplete" ? { phase: "speaking" } : state;
    case "speaking":
      return event.type === "speechFinished" ? initialVoiceChatState : state;
  }
}
