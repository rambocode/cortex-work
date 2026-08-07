import { describe, expect, it } from "vitest";

import {
  MAX_AUDIO_BYTES,
  SenseVoiceFrameDecoder,
  SenseVoiceFrameType,
  encodeAudioFrame,
  encodeControlFrame,
} from "./protocol";

describe("SenseVoice stdio 帧协议", () => {
  it("控制帧以 4 字节大端长度和 1 字节类型编码", () => {
    const frame = encodeControlFrame(SenseVoiceFrameType.Begin, {
      requestId: "req-1",
      language: "zh",
    });
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    expect(frame[4]).toBe(SenseVoiceFrameType.Begin);
    expect(JSON.parse(frame.subarray(5).toString("utf8"))).toEqual({
      requestId: "req-1",
      language: "zh",
    });
  });

  it("decoder 同时处理拆包与粘包", () => {
    const first = encodeControlFrame(SenseVoiceFrameType.Begin, { requestId: "a" });
    const second = encodeAudioFrame(Buffer.from([1, 2, 3, 4]));
    const combined = Buffer.concat([first, second]);
    const decoder = new SenseVoiceFrameDecoder();

    expect(decoder.push(combined.subarray(0, 3))).toEqual([]);
    expect(decoder.push(combined.subarray(3, first.length + 2))).toEqual([
      { type: SenseVoiceFrameType.Begin, payload: first.subarray(5) },
    ]);
    expect(decoder.push(combined.subarray(first.length + 2))).toEqual([
      { type: SenseVoiceFrameType.Audio, payload: Buffer.from([1, 2, 3, 4]) },
    ]);
  });

  it("拒绝超过 30 秒 PCM16 上限的 AUDIO 帧", () => {
    expect(() => encodeAudioFrame(Buffer.alloc(MAX_AUDIO_BYTES + 1))).toThrow(/30 秒/);
  });

  it("拒绝未知帧类型", () => {
    const invalid = Buffer.alloc(5);
    invalid.writeUInt32BE(1, 0);
    invalid[4] = 255;
    expect(() => new SenseVoiceFrameDecoder().push(invalid)).toThrow(/未知/);
  });
});
