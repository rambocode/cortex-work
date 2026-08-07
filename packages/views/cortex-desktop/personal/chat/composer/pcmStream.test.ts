import { describe, expect, it, vi } from "vitest";

import { PCM_BATCH_SAMPLES, StreamingPcm16Resampler } from "./pcmStream";

describe("StreamingPcm16Resampler", () => {
  it("48kHz 跨帧重采样为 16kHz，并按 320ms 批量输出", () => {
    const onChunk = vi.fn();
    const encoder = new StreamingPcm16Resampler(48_000, onChunk);
    encoder.push(new Float32Array(48_000 / 2).fill(0.5));
    encoder.push(new Float32Array(48_000 / 2).fill(0.5));
    encoder.flush();

    expect(onChunk).toHaveBeenCalledTimes(4);
    const sizes = onChunk.mock.calls.map(([chunk]) => (chunk as ArrayBuffer).byteLength);
    expect(sizes.slice(0, 3)).toEqual([
      PCM_BATCH_SAMPLES * 2,
      PCM_BATCH_SAMPLES * 2,
      PCM_BATCH_SAMPLES * 2,
    ]);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThanOrEqual(31_990);
  });

  it("钳制 Float32 到 PCM16 范围", () => {
    const chunks: ArrayBuffer[] = [];
    const encoder = new StreamingPcm16Resampler(16_000, (chunk) => chunks.push(chunk));
    encoder.push(Float32Array.from([-2, -1, 0, 1, 2]));
    encoder.flush();
    const view = new DataView(chunks[0]!);
    expect(view.getInt16(0, true)).toBe(-32768);
    expect(view.getInt16(2, true)).toBe(-32768);
    expect(view.getInt16(4, true)).toBe(0);
    expect(view.getInt16(6, true)).toBe(32767);
    expect(view.getInt16(8, true)).toBe(32767);
  });

  it("flush 不输出空 chunk，重复 flush 幂等", () => {
    const onChunk = vi.fn();
    const encoder = new StreamingPcm16Resampler(16_000, onChunk);
    encoder.flush();
    encoder.push(Float32Array.from([0.1, 0.2]));
    encoder.flush();
    encoder.flush();
    expect(onChunk).toHaveBeenCalledTimes(1);
  });
});
