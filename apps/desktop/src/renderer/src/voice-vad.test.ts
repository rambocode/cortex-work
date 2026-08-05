// 能量 VAD 纯判定核的时序用例:校准 → 说话 → 静音判停 / 短音丢弃 / 无人说话超时。

import { describe, expect, it } from "vitest";
import { createVadTracker, type VadConfig } from "./voice-vad";

const config: VadConfig = {
  calibrationMs: 300,
  silenceMs: 700,
  minSpeechMs: 300,
  maxIdleMs: 30_000,
  enterFactor: 3.5,
  enterFloor: 0.025,
  exitFactor: 2.2,
  exitFloor: 0.015,
  confirmMs: 160,
  floorAdaptRate: 0.05,
  floorCeiling: 0.04,
};

// 以 32ms 为步长喂样本,返回期间触发的全部事件。
function feed(tracker: ReturnType<typeof createVadTracker>, from: number, to: number, rms: number): string[] {
  const events: string[] = [];
  for (let now = from; now < to; now += 32) {
    const event = tracker.push(rms, now);
    if (event) events.push(event);
  }
  return events;
}

describe("createVadTracker", () => {
  it("说话后静音 700ms 判定一句话结束(句间短停顿不误判)", () => {
    const t = createVadTracker(config);
    expect(feed(t, 0, 300, 0.002)).toEqual([]); // 校准期
    expect(feed(t, 300, 800, 0.05)).toEqual(["speech-start"]); // 说话 500ms
    expect(feed(t, 800, 1200, 0.002)).toEqual([]); // 停顿 400ms < 700ms,不结束
    expect(feed(t, 1200, 1600, 0.05)).toEqual(["speech-start"]); // 继续说
    const tail = feed(t, 1600, 2600, 0.002); // 静音 1s
    expect(tail).toEqual(["speech-end"]);
  });

  it("短于 confirmMs 的爆音连 speech-start 都不触发", () => {
    const t = createVadTracker(config);
    feed(t, 0, 300, 0.002);
    expect(feed(t, 300, 400, 0.08)).toEqual([]); // 100ms 爆音 < 160ms 起音确认
    const after = feed(t, 400, 1500, 0.002);
    expect(after).toEqual([]); // 无 speech-start,自然也无 speech-end
  });

  it("一直无人说话到 maxIdleMs 上报 idle-timeout", () => {
    const t = createVadTracker({ ...config, maxIdleMs: 2000 });
    feed(t, 0, 300, 0.002);
    const events = feed(t, 300, 2500, 0.002);
    expect(events[0]).toBe("idle-timeout");
  });

  it("持续背景人声抬高噪声底,只有明显更响的近讲才触发", () => {
    const t = createVadTracker(config);
    feed(t, 0, 300, 0.02); // 校准期噪声底 0.02 → enter 阈值 0.07
    // 背景聊天声 0.03:低于阈值不触发,且把噪声底逐步抬向 0.03(阈值升至 ~0.105)。
    expect(feed(t, 300, 2000, 0.03)).toEqual([]);
    // 此时 0.08 的中等声量也不再触发(灵敏度已随环境钝化)。
    expect(feed(t, 2000, 2400, 0.08)).toEqual([]);
    // 近讲(0.15)持续超过起音确认时长才触发。
    expect(feed(t, 2400, 3000, 0.15)).toEqual(["speech-start"]);
  });
});
