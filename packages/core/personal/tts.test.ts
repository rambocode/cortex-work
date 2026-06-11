import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import type { TtsSettings } from "../desktop/types";
import { clipSpeechText, getTtsPlaybackState, replayLastSpeech, speakText, stopSpeaking, subscribeTtsPlayback } from "./tts";

const openaiSettings = (voice: string): TtsSettings => ({
  autoSpeak: true,
  engine: { kind: "openai", baseUrl: "http://localhost:8880", model: "tts-1", voice },
});

function bridge(): DesktopBridge {
  return {
    ttsSynthesize: vi.fn(async () => new ArrayBuffer(1)),
  } as unknown as DesktopBridge;
}

beforeEach(() => {
  stopSpeaking();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "Audio",
    class {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      pause = vi.fn();
      play = vi.fn(async () => {});
    },
  );
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:tts"),
    revokeObjectURL: vi.fn(),
  });
});

describe("clipSpeechText", () => {
  it("剥离 markdown 噪声:代码块/行内代码/链接/标题/强调", () => {
    const out = clipSpeechText("# 结论\n已修复 `login()` 问题,详见 [文档](https://x.y)。\n\n```ts\nconst a = 1;\n```\n**重要**:已验证");
    expect(out).toContain("已修复 login() 问题");
    expect(out).toContain("（代码略）");
    expect(out).toContain("文档");
    expect(out).not.toContain("https://x.y");
    expect(out).not.toContain("#");
    expect(out).not.toContain("**");
  });

  it("超长截断并提示省略", () => {
    const out = clipSpeechText("啊".repeat(700));
    expect(out.length).toBeLessThan(620);
    expect(out.endsWith("……以下省略")).toBe(true);
  });

  it("空白输入返回空串", () => {
    expect(clipSpeechText("  \n ")).toBe("");
  });
});

describe("TTS 播放控制", () => {
  it("speakText 记录最近朗读,供重听使用", async () => {
    const b = bridge();
    await speakText(b, openaiSettings("alloy"), "第一条回复");
    expect(getTtsPlaybackState().hasLastSpeech).toBe(true);

    await replayLastSpeech(b, openaiSettings("nova"));

    expect(b.ttsSynthesize).toHaveBeenCalledTimes(2);
    expect(b.ttsSynthesize).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "第一条回复", voice: "nova", language: "zh" }),
    );
  });

  it("stopSpeaking 会通知订阅方播放已停止", () => {
    const states: boolean[] = [];
    const off = subscribeTtsPlayback((state) => states.push(state.isSpeaking));

    stopSpeaking();
    off();

    expect(states.at(-1)).toBe(false);
  });

  it("空文本不会覆盖上一条可重听内容", async () => {
    const b = bridge();
    await speakText(b, openaiSettings("alloy"), "可重听");
    await speakText(b, openaiSettings("echo"), "   ");
    await replayLastSpeech(b);

    expect(b.ttsSynthesize).toHaveBeenCalledTimes(2);
    expect(b.ttsSynthesize).toHaveBeenLastCalledWith(expect.objectContaining({ text: "可重听", voice: "alloy" }));
  });
});
