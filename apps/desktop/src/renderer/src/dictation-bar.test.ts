import { describe, expect, it } from "vitest";
import { waveformLevel } from "./dictation-bar";

describe("waveformLevel", () => {
  it("把静音的 PCM 中心值识别为零电平", () => {
    expect(waveformLevel(new Uint8Array([128, 128, 128, 128]))).toBe(0);
  });

  it("把完整振幅限制在归一化电平上限", () => {
    expect(waveformLevel(new Uint8Array([0, 0]))).toBe(1);
  });

  it("对空采样返回零，避免 AnalyserNode 尚未填充缓冲时显示伪电平", () => {
    expect(waveformLevel(new Uint8Array())).toBe(0);
  });
});
