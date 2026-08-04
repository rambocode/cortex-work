import { describe, expect, it, vi } from "vitest";
import { DictationController, DictationSession } from "./dictation-controller";

describe("DictationSession", () => {
  it("切换听写按开始、再按停止时依次进入 recording 和 transcribing", () => {
    const session = new DictationSession();

    const recordingToken = session.beginRecording(42);
    expect(session.phase).toBe("recording");

    const transcribingToken = session.beginTranscribing();
    expect(transcribingToken).toBe(recordingToken);
    expect(session.phase).toBe("transcribing");
    expect(session.canCommit(transcribingToken, 42)).toBe(true);
  });

  it("转写期间切换前台应用时拒绝写回，避免把口述内容粘进错误目标", () => {
    const session = new DictationSession();
    session.beginRecording(42);
    const token = session.beginTranscribing();

    expect(session.canCommit(token, 43)).toBe(false);
    expect(session.phase).toBe("idle");
  });

  it("取消会作废迟到的转写结果", () => {
    const session = new DictationSession();
    const token = session.beginRecording(42);
    session.beginTranscribing();
    session.cancel();

    expect(session.canCommit(token, 42)).toBe(false);
    expect(session.phase).toBe("idle");
  });
});

describe("DictationController", () => {
  it("只在转写前后前台进程一致时才通过 helper.paste 写回文本", async () => {
    const helper = {
      axCapture: vi.fn().mockResolvedValueOnce({ pid: 42 }).mockResolvedValueOnce({ pid: 42 }),
      paste: vi.fn().mockResolvedValue({ ok: true }),
    };
    const pushState = vi.fn();
    const controller = new DictationController({
      helper,
      settings: () => ({ dictationBarAlwaysVisible: false }),
      pushState,
    });

    await controller.toggle();
    await controller.toggle();
    await controller.handleResult({ ok: true, text: "Cortex Desktop", token: 1 });

    expect(pushState).toHaveBeenNthCalledWith(1, "recording", false, 1);
    expect(pushState).toHaveBeenNthCalledWith(2, "transcribing", false, 1);
    expect(helper.paste).toHaveBeenCalledWith("Cortex Desktop");
    expect(pushState).toHaveBeenLastCalledWith("idle", false, 2);
  });

  it("拒绝不属于当前 transcribing 轮次的 IPC 结果，不能越代粘贴", async () => {
    const helper = {
      axCapture: vi.fn().mockResolvedValue({ pid: 42 }),
      paste: vi.fn().mockResolvedValue({ ok: true }),
    };
    const pushState = vi.fn();
    const controller = new DictationController({
      helper,
      settings: () => ({ dictationBarAlwaysVisible: false }),
      pushState,
    });

    await controller.toggle();
    await controller.toggle();
    await controller.handleResult({ ok: true, text: "过期结果", token: 999 });

    expect(helper.paste).not.toHaveBeenCalled();
    expect(pushState).toHaveBeenLastCalledWith("transcribing", false, 1);
  });

  it("按住结束早于异步录音初始化完成时，初始化完成后立即进入转写而不留下录音", async () => {
    let resolveSnapshot!: (snapshot: Record<string, unknown>) => void;
    const snapshot = new Promise<Record<string, unknown>>((resolve) => {
      resolveSnapshot = resolve;
    });
    const helper = {
      axCapture: vi.fn().mockReturnValue(snapshot),
      paste: vi.fn().mockResolvedValue({ ok: true }),
    };
    const pushState = vi.fn();
    const controller = new DictationController({
      helper,
      settings: () => ({ dictationBarAlwaysVisible: false }),
      pushState,
    });

    const start = controller.holdStart();
    const end = controller.holdEnd();
    resolveSnapshot({ pid: 42 });
    await Promise.all([start, end]);

    expect(helper.axCapture).toHaveBeenCalledTimes(1);
    expect(pushState.mock.calls).toEqual([
      ["recording", false, 1],
      ["transcribing", false, 1],
    ]);
  });

  it("切换听写快按两次时只初始化一次录音，并在初始化后立即进入转写", async () => {
    let resolveSnapshot!: (snapshot: Record<string, unknown>) => void;
    const snapshot = new Promise<Record<string, unknown>>((resolve) => {
      resolveSnapshot = resolve;
    });
    const helper = {
      axCapture: vi.fn().mockReturnValue(snapshot),
      paste: vi.fn().mockResolvedValue({ ok: true }),
    };
    const pushState = vi.fn();
    const controller = new DictationController({
      helper,
      settings: () => ({ dictationBarAlwaysVisible: false }),
      pushState,
    });

    const start = controller.toggle();
    const stop = controller.toggle();
    resolveSnapshot({ pid: 42 });
    await Promise.all([start, stop]);

    expect(helper.axCapture).toHaveBeenCalledTimes(1);
    expect(pushState.mock.calls).toEqual([
      ["recording", false, 1],
      ["transcribing", false, 1],
    ]);
  });
});
