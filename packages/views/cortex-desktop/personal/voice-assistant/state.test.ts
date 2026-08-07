// 语音助手状态机的流转契约:主环、打断、失败回落、未激活闭锁。
import { describe, expect, it } from "vitest";
import {
  initialVoiceAssistantState,
  transitionVoiceAssistant,
  type VoiceAssistantEvent,
  type VoiceAssistantState,
} from "./state";

function run(state: VoiceAssistantState, events: VoiceAssistantEvent[]): VoiceAssistantState {
  return events.reduce(transitionVoiceAssistant, state);
}

describe("transitionVoiceAssistant", () => {
  it("主环:激活 → 聆听 → 转写 → 等回复 → 朗读 → idle", () => {
    let s = run(initialVoiceAssistantState, [
      { type: "activate" },
      { type: "listening" },
      { type: "speechEnd" },
      { type: "sent" },
      { type: "speak" },
    ]);
    expect(s).toEqual({ active: true, phase: "speaking" });
    s = transitionVoiceAssistant(s, { type: "speechFinished" });
    expect(s).toEqual({ active: true, phase: "idle" });
  });

  it("本地意图可从转写阶段直接朗读确认，不伪造 agent 运行", () => {
    const transcribing = run(initialVoiceAssistantState, [
      { type: "activate" },
      { type: "listening" },
      { type: "speechEnd" },
    ]);
    const speaking = transitionVoiceAssistant(transcribing, { type: "localReply" });
    expect(speaking).toEqual({ active: true, phase: "speaking" });
    expect(transitionVoiceAssistant(speaking, { type: "speechFinished" })).toEqual({
      active: true,
      phase: "idle",
    });
  });

  it("speaking 可被打断直接回 listening(设计稿的点击打断)", () => {
    const s = run(initialVoiceAssistantState, [
      { type: "activate" },
      { type: "listening" },
      { type: "speechEnd" },
      { type: "sent" },
      { type: "speak" },
      { type: "listening" },
    ]);
    expect(s.phase).toBe("listening");
  });

  it("转写阶段不许插录音(转写在途,避免重叠 MediaRecorder)", () => {
    const transcribing = run(initialVoiceAssistantState, [
      { type: "activate" },
      { type: "listening" },
      { type: "speechEnd" },
    ]);
    expect(transitionVoiceAssistant(transcribing, { type: "listening" }).phase).toBe("transcribing");
  });

  it("thinking 可被打断直接回 listening(长时间思考不用干等,宿主先停掉 agent 轮)", () => {
    const thinking = run(initialVoiceAssistantState, [
      { type: "activate" },
      { type: "listening" },
      { type: "speechEnd" },
      { type: "sent" },
    ]);
    expect(transitionVoiceAssistant(thinking, { type: "listening" }).phase).toBe("listening");
  });

  it("失败从任意阶段回 idle 带 error,active 保持;下一次 listening 清掉 error", () => {
    const thinking = run(initialVoiceAssistantState, [
      { type: "activate" },
      { type: "listening" },
      { type: "speechEnd" },
      { type: "sent" },
    ]);
    const failed = transitionVoiceAssistant(thinking, { type: "failed", message: "会话正忙" });
    expect(failed).toEqual({ active: true, phase: "idle", error: "会话正忙" });
    expect(transitionVoiceAssistant(failed, { type: "listening" })).toEqual({ active: true, phase: "listening" });
  });

  it("未激活时除 activate 外全部闭锁(迟到回调安全)", () => {
    expect(transitionVoiceAssistant(initialVoiceAssistantState, { type: "listening" })).toBe(
      initialVoiceAssistantState,
    );
    expect(transitionVoiceAssistant(initialVoiceAssistantState, { type: "speechFinished" })).toBe(
      initialVoiceAssistantState,
    );
  });

  it("deactivate 无条件复位(含 error 清除)", () => {
    const failed = run(initialVoiceAssistantState, [
      { type: "activate" },
      { type: "failed", message: "x" },
    ]);
    expect(transitionVoiceAssistant(failed, { type: "deactivate" })).toEqual(initialVoiceAssistantState);
  });
});
