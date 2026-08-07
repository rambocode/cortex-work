import { describe, expect, it } from "vitest";

import { extractPcm16FromWav } from "./pcm";

function wav(pcm: Buffer, sampleRate = 16_000, channels = 1, bits = 16): Buffer {
  const out = Buffer.alloc(44 + pcm.length);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + pcm.length, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  out.writeUInt16LE(channels * bits / 8, 32);
  out.writeUInt16LE(bits, 34);
  out.write("data", 36);
  out.writeUInt32LE(pcm.length, 40);
  pcm.copy(out, 44);
  return out;
}

describe("extractPcm16FromWav", () => {
  it("提取 16kHz 单声道 PCM16LE data chunk", () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
    expect(extractPcm16FromWav(wav(pcm))).toEqual(pcm);
  });

  it("拒绝采样率、声道或位深不符合协议的 WAV", () => {
    expect(() => extractPcm16FromWav(wav(Buffer.alloc(4), 48_000))).toThrow(/16000 Hz/);
    expect(() => extractPcm16FromWav(wav(Buffer.alloc(4), 16_000, 2))).toThrow(/单声道/);
    expect(() => extractPcm16FromWav(wav(Buffer.alloc(4), 16_000, 1, 8))).toThrow(/PCM16/);
  });

  it("拒绝截断或非 RIFF/WAVE 输入", () => {
    expect(() => extractPcm16FromWav(Buffer.from("nope"))).toThrow(/WAV/);
  });
});
