// voice-intent.test.ts — 语音转写结果裁决纯逻辑（U8）。

import { describe, it, expect } from "vitest";
import { decideVoiceIntent } from "./voice-intent";

describe("decideVoiceIntent 语音结果裁决", () => {
  it("ok + 非空文本 → draft（去首尾空白）", () => {
    expect(decideVoiceIntent({ ok: true, text: "  明天上午可以  " })).toEqual({
      action: "draft",
      text: "明天上午可以",
    });
  });

  it("ok 但文本为空 / 纯空白 → empty（未识别到语音）", () => {
    expect(decideVoiceIntent({ ok: true, text: "" })).toEqual({ action: "empty" });
    expect(decideVoiceIntent({ ok: true, text: "   " })).toEqual({ action: "empty" });
    expect(decideVoiceIntent({ ok: true })).toEqual({ action: "empty" });
  });

  it("!ok → failed，携带 reason", () => {
    expect(decideVoiceIntent({ ok: false, reason: "网络错误" })).toEqual({
      action: "failed",
      reason: "网络错误",
    });
  });

  it("!ok 且 reason 缺失 / 空白 → failed 兜底文案", () => {
    expect(decideVoiceIntent({ ok: false })).toEqual({ action: "failed", reason: "转写失败" });
    expect(decideVoiceIntent({ ok: false, reason: "   " })).toEqual({
      action: "failed",
      reason: "转写失败",
    });
  });
});
