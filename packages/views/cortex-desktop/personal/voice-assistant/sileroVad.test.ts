import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  callbacks: null as null | { onSpeechRealStart: () => void },
  setOptions: vi.fn(),
  start: vi.fn(async () => {}),
  pause: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
}));

vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: {
    new: vi.fn(async (options: { onSpeechRealStart: () => void }) => {
      h.callbacks = options;
      return {
        setOptions: h.setOptions,
        start: h.start,
        pause: h.pause,
        destroy: h.destroy,
      };
    }),
  },
}));

import {
  BARGE_IN_MIN_SPEECH_MS,
  BARGE_IN_SPEECH_THRESHOLDS,
  createVoiceVadMonitor,
  SILERO_SPEECH_THRESHOLDS,
} from "./sileroVad";

beforeEach(() => {
  h.callbacks = null;
  h.setOptions.mockClear();
  h.start.mockClear();
  h.pause.mockClear();
  h.destroy.mockClear();
  vi.stubGlobal("window", {
    location: { protocol: "http:", href: "http://localhost/" },
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("createVoiceVadMonitor", () => {
  it("确认短插话后只恢复概率阈值，不在本句中提高最短帧数", async () => {
    const events: string[] = [];
    const monitor = await createVoiceVadMonitor(
      {} as MediaStream,
      (event) => events.push(event),
      undefined,
      undefined,
      "barge-in",
    );

    expect(h.setOptions).toHaveBeenNthCalledWith(1, {
      ...BARGE_IN_SPEECH_THRESHOLDS,
      minSpeechMs: BARGE_IN_MIN_SPEECH_MS,
    });

    h.callbacks?.onSpeechRealStart();

    expect(events).toEqual(["speech-start"]);
    // vad-web 会用当前 minSpeechMs 决定 SpeechEnd 还是 VADMisfire；确认后若从 240ms
    // 提高到 300ms，刚好够触发插话的短句会在收尾时被反向判成误触，永远不提交 ASR。
    expect(h.setOptions).toHaveBeenNthCalledWith(2, SILERO_SPEECH_THRESHOLDS);
    monitor.stop();
  });
});
