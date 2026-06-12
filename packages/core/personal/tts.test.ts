import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import type { TtsSettings } from "../desktop/types";
import {
  clipSpeechText,
  getTtsPlaybackState,
  replayLastSpeech,
  speakText,
  splitSpeechChunks,
  stopSpeaking,
  subscribeTtsPlayback,
} from "./tts";

const openaiSettings = (voice: string): TtsSettings => ({
  autoSpeak: true,
  engine: { kind: "openai", baseUrl: "http://localhost:8880", model: "tts-1", voice },
});

function bridge(): DesktopBridge {
  return {
    ttsSynthesize: vi.fn(async () => new ArrayBuffer(1)),
  } as unknown as DesktopBridge;
}

function wavChunk(samples: number[]): ArrayBuffer {
  const headerSize = 44;
  const out = new ArrayBuffer(headerSize + samples.length * 2);
  const bytes = new Uint8Array(out);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i);
  };
  const view = new DataView(out);
  text(0, "RIFF");
  view.setUint32(4, 0xffffffff, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 0xffffffff, true);
  samples.forEach((sample, index) => view.setInt16(headerSize + index * 2, sample, true));
  return out;
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

describe("splitSpeechChunks", () => {
  it("按句子把长文本切成多段,避免 TTS 重听一次发送整段回答", () => {
    expect(splitSpeechChunks("第一句很短。第二句也很短。第三句继续。", 12)).toEqual([
      "第一句很短。",
      "第二句也很短。",
      "第三句继续。",
    ]);
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

  it("自定义模型朗读默认启用 stream 请求参数", async () => {
    const b = bridge();
    await speakText(b, openaiSettings("vivian"), "你好，今天天气很好。");

    expect(b.ttsSynthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "tts-1",
        voice: "vivian",
        text: "你好，今天天气很好。",
        language: "zh",
        stream: true,
        streamingInterval: 1.0,
      }),
    );
  });

  it("桌面桥支持 wav 流式 TTS 时边收边调度 PCM,不等待完整 arrayBuffer", async () => {
    const frameCounts: number[] = [];
    const starts: number[] = [];
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      resume = vi.fn(async () => {});
      close = vi.fn(async () => {});
      createBuffer = vi.fn((_channels: number, frames: number, sampleRate: number) => {
        frameCounts.push(frames);
        return {
          duration: frames / sampleRate,
          getChannelData: () => new Float32Array(frames),
        };
      });
      createBufferSource = vi.fn(() => ({
        buffer: null,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        start: vi.fn((at: number) => starts.push(at)),
      }));
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const chunk = wavChunk([0, 1024, -1024, 2048]);
    const b = {
      ttsSynthesize: vi.fn(async () => new ArrayBuffer(0)),
      ttsSynthesizeStream: vi.fn(async (_req, cb) => {
        cb({ type: "chunk", chunk, mimeType: "audio/wav" });
        cb({ type: "done" });
      }),
    } satisfies Pick<DesktopBridge, "ttsSynthesize" | "ttsSynthesizeStream">;

    const longText = `${"一".repeat(170)}。第二段随后发送。`;
    await speakText(b as unknown as DesktopBridge, openaiSettings("vivian"), longText);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(b.ttsSynthesizeStream).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ voice: "vivian", text: "一".repeat(160), stream: true, streamingInterval: 1.0 }),
      expect.any(Function),
    );
    expect(b.ttsSynthesizeStream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ voice: "vivian", text: `${"一".repeat(10)}。`, stream: true, streamingInterval: 1.0 }),
      expect.any(Function),
    );
    expect(b.ttsSynthesizeStream).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ voice: "vivian", text: "第二段随后发送。", stream: true, streamingInterval: 1.0 }),
      expect.any(Function),
    );
    expect(b.ttsSynthesize).not.toHaveBeenCalled();
    expect(frameCounts).toEqual([4, 4, 4]);
    expect(starts).toHaveLength(3);
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
