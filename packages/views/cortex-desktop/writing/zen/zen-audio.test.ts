// 禅模式背景音引擎单测:核心回归是 play() 的序号时序 —— stop() 内部自增 seq,
// 曾因「先取序号再 stop」导致每次播放都被自己作废(实机表现:怎么开都没声音)。
// Audio / URL.createObjectURL 用替身(jsdom 无媒体实现)。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZenAudioEngine } from "./zen-audio";

// <audio> 替身:记录实例与 play/pause 调用,play 恒成功。
class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  loop = false;
  volume = 1;
  playCalls = 0;
  paused = false;
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.playCalls += 1;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

const B64 = btoa("fake-mp3-bytes");

beforeEach(() => {
  FakeAudio.instances = [];
  vi.stubGlobal("Audio", FakeAudio);
  // jsdom 没有 createObjectURL/revokeObjectURL,直接补在现有 URL 上。
  URL.createObjectURL = vi.fn(() => `blob:zen-${FakeAudio.instances.length}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe("ZenAudioEngine", () => {
  it("play:取数成功即创建 <audio> 循环低音量播放(序号不被 stop 自作废 —— 无声 bug 回归)", async () => {
    const engine = new ZenAudioEngine();
    await engine.play("rain", async () => B64);
    expect(FakeAudio.instances).toHaveLength(1);
    const audio = FakeAudio.instances[0]!;
    expect(audio.loop).toBe(true);
    expect(audio.volume).toBeCloseTo(0.35);
    expect(audio.playCalls).toBe(1);
  });

  it("同一 id 重复 play 为 no-op;切换 id 停旧播新并回收 blob", async () => {
    const engine = new ZenAudioEngine();
    await engine.play("rain", async () => B64);
    await engine.play("rain", async () => B64);
    expect(FakeAudio.instances).toHaveLength(1);

    await engine.play("sea_and_wind", async () => B64);
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[0]!.paused).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("快速连点:慢的旧请求返回后被序号丢弃,不叠播", async () => {
    const engine = new ZenAudioEngine();
    let releaseFirst!: (v: string) => void;
    const slow = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    const first = engine.play("rain", () => slow);
    await engine.play("summer_night", async () => B64); // 第二次先完成
    releaseFirst(B64); // 旧请求此刻才返回
    await first;
    // 只有第二次创建了 <audio>;旧请求被丢弃。
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it("取数失败/空值静默不播;stop 幂等", async () => {
    const engine = new ZenAudioEngine();
    await engine.play("rain", async () => null);
    await engine.play("rain", () => {
      throw new Error("boom");
    });
    expect(FakeAudio.instances).toHaveLength(0);
    engine.stop();
    engine.stop();
  });
});
