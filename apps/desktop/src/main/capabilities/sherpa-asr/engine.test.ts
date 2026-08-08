// PCM16LE → Float32 转换的正确性。
//
// 这段代码值得单测是因为它的错误形态不是崩溃而是「识别出乱码」：符号位处理错、
// 字节序反了、或按未对齐的 Int16Array 视图读，都会得到能跑但全错的音频。

import { describe, expect, it } from "vitest";
import { pcm16leToFloat32 } from "./engine";

/** 按小端写入一组 int16 样本，模拟 renderer 推来的 PCM16LE。 */
function pcm(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}

describe("pcm16leToFloat32", () => {
  it("按小端解出样本并归一化到 [-1, 1)", () => {
    const out = pcm16leToFloat32(pcm([0, 16384, -16384, 32767, -32768]));
    expect(Array.from(out)).toEqual([0, 0.5, -0.5, 32767 / 32768, -1]);
  });

  it("负值保持符号（错读成无符号会得到接近 +1 的值）", () => {
    const out = pcm16leToFloat32(pcm([-1]));
    expect(out[0]).toBeLessThan(0);
    expect(out[0]).toBeCloseTo(-1 / 32768, 10);
  });

  it("丢弃末尾落单字节而不是读越界", () => {
    const odd = Buffer.concat([pcm([1234]), Buffer.from([0x7f])]);
    const out = pcm16leToFloat32(odd);
    expect(out).toHaveLength(1);
    expect(out[0]).toBeCloseTo(1234 / 32768, 10);
  });

  it("空输入得到空数组", () => {
    expect(pcm16leToFloat32(Buffer.alloc(0))).toHaveLength(0);
  });

  it("不依赖 Buffer 的字节对齐（非零 byteOffset 的切片同样正确）", () => {
    // IPC 过来的 Buffer 常是大缓冲的切片，byteOffset 可能是奇数；
    // 若实现改用 new Int16Array(buf.buffer) 这条用例就会挂。
    const backing = Buffer.alloc(5);
    backing.writeInt16LE(-4096, 1);
    const unaligned = backing.subarray(1, 3);
    expect(unaligned.byteOffset % 2).toBe(1);
    expect(pcm16leToFloat32(unaligned)[0]).toBeCloseTo(-4096 / 32768, 10);
  });
});
