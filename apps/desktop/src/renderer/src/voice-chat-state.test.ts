import { describe, expect, it } from "vitest";
import { initialVoiceChatState, transitionVoiceChat } from "./voice-chat-state";

describe("voice chat state machine", () => {
  it("按录音、转写、发送、朗读的顺序推进，并在朗读结束后回到 idle", () => {
    const recording = transitionVoiceChat(initialVoiceChatState, { type: "startListening" });
    const transcribing = transitionVoiceChat(recording, { type: "stopAndSubmit" });
    const sending = transitionVoiceChat(transcribing, { type: "transcribed" });
    const speaking = transitionVoiceChat(sending, { type: "responseComplete" });
    const idle = transitionVoiceChat(speaking, { type: "speechFinished" });

    expect(recording.phase).toBe("recording");
    expect(transcribing.phase).toBe("transcribing");
    expect(sending.phase).toBe("sending");
    expect(speaking.phase).toBe("speaking");
    expect(idle.phase).toBe("idle");
  });

  it("无效时序不改变状态，避免快捷键重复按下创建并发录音", () => {
    expect(transitionVoiceChat(initialVoiceChatState, { type: "stopAndSubmit" })).toEqual(initialVoiceChatState);
    expect(transitionVoiceChat({ phase: "recording" }, { type: "startListening" })).toEqual({ phase: "recording" });
  });

  it("失败会回到 idle 并保留可展示的非敏感错误文案", () => {
    expect(transitionVoiceChat({ phase: "transcribing" }, { type: "failed", message: "麦克风不可用" })).toEqual({
      phase: "idle",
      error: "麦克风不可用",
    });
  });
});
