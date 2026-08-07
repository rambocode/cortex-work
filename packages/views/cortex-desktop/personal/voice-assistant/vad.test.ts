// 能量 VAD 纯判定核的时序用例:校准 → 说话 → 静音判停 / 短音丢弃 / 无人说话超时。

import { FrameProcessor, Message } from "@ricky0123/vad-web";
import { describe, expect, it } from "vitest";
import {
  BARGE_IN_MIN_SPEECH_MS,
  BARGE_IN_SPEECH_THRESHOLDS,
  SILERO_SPEECH_THRESHOLDS,
  shouldStartVoiceTurn,
} from "./sileroVad";
import {
  createVadTracker,
  DEFAULT_VAD_CONFIG,
  isIgnorableVoiceTranscript,
  type VadConfig,
} from "./vad";

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
  // 测试用短窗:时序断言按 700ms 编排;生产默认 1500ms(轻声收尾段不被提前截断)。
  strongHangoverMs: 700,
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

  it("说完后 AGC 抬高的环境声贴在弱能量带,强峰缺席超时后仍能判停(不卡死聆听)", () => {
    const t = createVadTracker(config);
    feed(t, 0, 300, 0.002); // 校准
    expect(feed(t, 300, 800, 0.05)).toEqual(["speech-start"]);
    // 环境声 0.02 落在退出阈值(0.015)与进入阈值(0.025)之间:没有强峰维持窗时,
    // 它会在 speaking 态无限刷新静音计时,speech-end 永不触发(实测卡死回归)。
    // 现在:强峰缺席 700ms 后强制退出 speaking → 再计 700ms 静音 → 判停。
    expect(feed(t, 800, 2600, 0.02)).toEqual(["speech-end"]);
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

describe("isIgnorableVoiceTranscript", () => {
  it("只过滤可确定无语义的纯标点和纯符号", () => {
    expect(isIgnorableVoiceTranscript(".")).toBe(true);
    expect(isIgnorableVoiceTranscript("。 ！")).toBe(true);
    expect(isIgnorableVoiceTranscript("……???")).toBe(true);
  });

  it("保留语气词、短指令和包含实际语义的句子", () => {
    // “啊/嗯/um”既可能来自噪声，也可能是用户真实发声；文本层没有声学证据，不得误杀。
    expect(isIgnorableVoiceTranscript(". 啊 ")).toBe(false);
    expect(isIgnorableVoiceTranscript("嗯……")).toBe(false);
    expect(isIgnorableVoiceTranscript("um...")).toBe(false);
    expect(isIgnorableVoiceTranscript("停")).toBe(false);
    expect(isIgnorableVoiceTranscript("退出")).toBe(false);
    expect(isIgnorableVoiceTranscript("嗯，好，继续吧")).toBe(false);
    expect(isIgnorableVoiceTranscript("啊，帮我打开设置")).toBe(false);
  });
});

describe("Silero 降噪门槛", () => {
  it("提高人声概率门槛但不扩大 300ms 最短发声时长", () => {
    expect(SILERO_SPEECH_THRESHOLDS).toEqual({
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.45,
    });
    expect(DEFAULT_VAD_CONFIG.minSpeechMs).toBe(300);
  });

  it("播放期间沿用可达的人声概率门槛，并等待连续确认后才打断", () => {
    expect(BARGE_IN_SPEECH_THRESHOLDS).toEqual({
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.45,
    });
    // AEC 负责压低播放回声；确认窗拒绝残余回声，同时不沿用 300ms，避免漏掉短促“啊”。
    expect(BARGE_IN_MIN_SPEECH_MS).toBe(240);
    expect(shouldStartVoiceTurn("listening", "candidate")).toBe(true);
    expect(shouldStartVoiceTurn("barge-in", "candidate")).toBe(false);
    expect(shouldStartVoiceTurn("barge-in", "confirmed")).toBe(true);
  });

  it("播放期 AEC 后的中等概率真人声仍能完成确认并产生句末事件", async () => {
    // 取自真实双讲诊断的保守化概率形状：近场语音在 AEC 后大量落在 0.60~0.76，
    // 旧 0.80 阈值只能偶发 candidate，达不到 minSpeechFrames，最终变成 misfire。
    const probabilities = [0.62, 0.68, 0.72, 0.65, 0.58, 0.7, 0.66, 0.64, 0.62, ...Array(36).fill(0)];
    const events: Message[] = [];
    const processor = new FrameProcessor(
      async () => {
        const isSpeech = probabilities.shift() ?? 0;
        return { isSpeech, notSpeech: 1 - isSpeech };
      },
      () => {},
      {
        ...BARGE_IN_SPEECH_THRESHOLDS,
        redemptionMs: DEFAULT_VAD_CONFIG.silenceMs,
        preSpeechPadMs: 0,
        minSpeechMs: BARGE_IN_MIN_SPEECH_MS,
        submitUserSpeechOnPause: false,
      },
      32,
    );
    processor.resume();

    for (let index = 0; index < 45; index += 1) {
      await processor.process(new Float32Array(512), (event) => events.push(event.msg));
    }

    expect(events).toContain(Message.SpeechRealStart);
    expect(events).toContain(Message.SpeechEnd);
    expect(events).not.toContain(Message.VADMisfire);
  });
});
