// voiceTurn 回合钩子的行为契约：单监听器覆盖、接管布尔透传、监听器抛错不影响主流程。
import { describe, expect, it, afterEach } from "vitest";
import { emitVoiceTurnEnd, setVoiceTurnListener, type VoiceTurnEnd } from "./voiceTurn";

afterEach(() => setVoiceTurnListener(null));

describe("voiceTurn", () => {
  it("无监听器时 emit 返回 false（finalizeRun 照常走 autoSpeak）", () => {
    expect(emitVoiceTurnEnd({ sessionId: "s1", ok: true, text: "hi" })).toBe(false);
  });

  it("监听器返回 true 表示接管朗读，事件载荷原样送达", () => {
    const seen: VoiceTurnEnd[] = [];
    setVoiceTurnListener((ev) => {
      seen.push(ev);
      return true;
    });
    expect(emitVoiceTurnEnd({ sessionId: "s1", ok: true, text: "回复" })).toBe(true);
    expect(seen).toEqual([{ sessionId: "s1", ok: true, text: "回复" }]);
  });

  it("监听器返回 false 时不接管（autoSpeak 不被跳过）", () => {
    setVoiceTurnListener(() => false);
    expect(emitVoiceTurnEnd({ sessionId: "s1", ok: false, text: "" })).toBe(false);
  });

  it("后注册者覆盖前者；传 null 清除", () => {
    setVoiceTurnListener(() => true);
    setVoiceTurnListener(() => false);
    expect(emitVoiceTurnEnd({ sessionId: "s1", ok: true, text: "x" })).toBe(false);
    setVoiceTurnListener(null);
    expect(emitVoiceTurnEnd({ sessionId: "s1", ok: true, text: "x" })).toBe(false);
  });

  it("监听器抛错视为未接管，不向调用方冒泡", () => {
    setVoiceTurnListener(() => {
      throw new Error("boom");
    });
    expect(() => emitVoiceTurnEnd({ sessionId: "s1", ok: true, text: "x" })).not.toThrow();
    expect(emitVoiceTurnEnd({ sessionId: "s1", ok: true, text: "x" })).toBe(false);
  });
});
