import { describe, expect, it } from "vitest";
import { encodePcm16LeAsWav } from "./encodeWav";

describe("encodePcm16LeAsWav", () => {
  it("把多段 16kHz PCM16LE 无损封装成标准单声道 WAV", () => {
    const first = new Uint8Array([0x01, 0x02]).buffer;
    const second = new Uint8Array([0x03, 0x04, 0x05, 0x06]).buffer;

    const wav = encodePcm16LeAsWav([first, second]);
    const bytes = new Uint8Array(wav);
    const view = new DataView(wav);

    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(6);
    expect([...bytes.subarray(44)]).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
  });

  it("拒绝奇数字节 PCM，避免生成半个采样点的损坏 WAV", () => {
    expect(() => encodePcm16LeAsWav([new Uint8Array([0x01]).buffer])).toThrow("偶数字节");
  });
});
