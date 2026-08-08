import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  transcribeOnline: vi.fn(),
  start: vi.fn(),
  append: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn(),
  transcribePcm: vi.fn(),
  // 流式引擎（sherpa）：用 has() 模拟「requestId 归属哪个引擎」的会话表。
  zipHas: vi.fn(),
  zipStart: vi.fn(),
  zipAppend: vi.fn(),
  zipFinish: vi.fn(),
  zipCancel: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../capabilities/sensevoice/models", () => ({
  getLocalAsrModelStatus: (...args: unknown[]) => mocks.getStatus(...args),
  downloadLocalAsrModel: vi.fn(),
  cancelLocalAsrDownload: vi.fn(),
  deleteLocalAsrModel: vi.fn(),
  checkLocalAsrSources: vi.fn(),
  setLocalAsrProgressEmitter: vi.fn(),
}));
vi.mock("../capabilities/sensevoice/client", () => ({
  senseVoiceClient: {
    startStream: (...args: unknown[]) => mocks.start(...args),
    appendAudio: (...args: unknown[]) => mocks.append(...args),
    finishStream: (...args: unknown[]) => mocks.finish(...args),
    cancelStream: (...args: unknown[]) => mocks.cancel(...args),
    transcribePcm: (...args: unknown[]) => mocks.transcribePcm(...args),
  },
}));
vi.mock("../capabilities/sherpa-asr/models", () => ({
  getStreamingAsrModelStatus: vi.fn(),
  downloadStreamingAsrModel: vi.fn(),
  cancelStreamingAsrDownload: vi.fn(),
  deleteStreamingAsrModel: vi.fn(),
  checkStreamingAsrSources: vi.fn(),
  setStreamingAsrProgressEmitter: vi.fn(),
}));
vi.mock("../capabilities/sherpa-asr/engine", () => ({
  sherpaStreamingAsr: {
    has: (...args: unknown[]) => mocks.zipHas(...args),
    startStream: (...args: unknown[]) => mocks.zipStart(...args),
    appendAudio: (...args: unknown[]) => mocks.zipAppend(...args),
    finishStream: (...args: unknown[]) => mocks.zipFinish(...args),
    cancelStream: (...args: unknown[]) => mocks.zipCancel(...args),
    shutdown: vi.fn(),
  },
}));
vi.mock("../capabilities/asr/online-transcribe", () => ({
  transcribeOnline: (...args: unknown[]) => mocks.transcribeOnline(...args),
  ASR_MAX_BYTES: 25 * 1024 * 1024,
}));
vi.mock("../capabilities/asr/polish", () => ({ polishTranscriptIfEnabled: vi.fn() }));

import { ipcMain } from "electron";
import { registerSttHandlers } from "./stt";

let handlers: Record<string, (event: unknown, ...args: never[]) => unknown>;

function settings(protocol: string) {
  return {
    enabled: true,
    providerId: "",
    protocol,
    baseUrl: "https://asr.example.com",
    apiKey: "key",
    model: protocol === "local-sensevoice" ? "sensevoice-small-q8" : "whisper-1",
    localModelDownloadSource: "huggingface",
    language: "zh",
    timeoutMs: 60_000,
  };
}

function wav(pcm: Buffer): ArrayBuffer {
  const out = Buffer.alloc(44 + pcm.length);
  out.write("RIFF", 0); out.writeUInt32LE(36 + pcm.length, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16_000, 24); out.writeUInt32LE(32_000, 28); out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(pcm.length, 40); pcm.copy(out, 44);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

beforeEach(() => {
  handlers = {};
  vi.clearAllMocks();
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: unknown) => {
    handlers[channel] = handler as (event: unknown, ...args: never[]) => unknown;
  });
  registerSttHandlers();
});

describe("stt IPC", () => {
  it("在线协议继续走 OpenAI 兼容转写", async () => {
    mocks.transcribeOnline.mockResolvedValue({ text: "online" });
    const result = await handlers["stt:transcribe"]?.({}, {
      audio: new ArrayBuffer(8), mimeType: "audio/wav", fileName: "a.wav",
      asrSettings: settings("openai-transcriptions"),
    } as never);
    expect(result).toEqual({ text: "online" });
  });

  it("local-sensevoice 整段 WAV 复用常驻流式客户端", async () => {
    mocks.getStatus.mockResolvedValue({ state: "ready", path: "/model.gguf" });
    mocks.transcribePcm.mockResolvedValue("本地结果");
    const pcm = Buffer.from([1, 0, 2, 0]);
    const result = await handlers["stt:transcribe"]?.({}, {
      audio: wav(pcm), mimeType: "audio/wav", fileName: "a.wav",
      asrSettings: settings("local-sensevoice"),
    } as never);
    expect(mocks.transcribePcm).toHaveBeenCalledWith({
      modelPath: "/model.gguf", language: "zh", pcm16le: pcm,
    });
    expect(result).toEqual({ text: "本地结果" });
  });

  it("实时 start 在模型未就绪时拒绝", async () => {
    mocks.getStatus.mockResolvedValue({ state: "missing" });
    await expect(handlers["stt:stream:start"]?.({}, {
      requestId: "r", modelId: "sensevoice-small-q8", language: "auto",
    } as never)).rejects.toThrow(/尚未就绪/);
  });

  it("start 按 protocol 分流到流式引擎，且不去查 SenseVoice 模型状态", async () => {
    await handlers["stt:stream:start"]?.({}, {
      requestId: "r1",
      modelId: "zipformer-bilingual-zh-en-int8",
      language: "auto",
      protocol: "local-zipformer-stream",
    } as never);
    expect(mocks.zipStart).toHaveBeenCalledWith({
      requestId: "r1", modelId: "zipformer-bilingual-zh-en-int8",
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it("start 省略 protocol 时仍按 SenseVoice 处理（旧渲染端兼容）", async () => {
    mocks.getStatus.mockResolvedValue({ state: "ready", path: "/model.gguf" });
    await handlers["stt:stream:start"]?.({}, {
      requestId: "r2", modelId: "sensevoice-small-q8", language: "auto",
    } as never);
    expect(mocks.start).toHaveBeenCalled();
    expect(mocks.zipStart).not.toHaveBeenCalled();
  });

  it("audio/finish/cancel 依据会话归属分流，而不需要再传 protocol", async () => {
    mocks.zipHas.mockReturnValue(true);
    mocks.zipFinish.mockResolvedValue("流式结果");
    await handlers["stt:stream:audio"]?.({}, { requestId: "r1", audio: new ArrayBuffer(4) } as never);
    expect(mocks.zipAppend).toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();

    const finished = await handlers["stt:stream:finish"]?.({}, "r1" as never);
    expect(finished).toEqual({ text: "流式结果" });
    expect(mocks.finish).not.toHaveBeenCalled();

    await handlers["stt:stream:cancel"]?.({}, "r1" as never);
    expect(mocks.zipCancel).toHaveBeenCalledWith("r1");
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("非流式会话的 audio/finish 仍走 SenseVoice", async () => {
    mocks.zipHas.mockReturnValue(false);
    mocks.finish.mockResolvedValue("整段结果");
    await handlers["stt:stream:audio"]?.({}, { requestId: "r2", audio: new ArrayBuffer(4) } as never);
    expect(mocks.append).toHaveBeenCalled();
    expect(mocks.zipAppend).not.toHaveBeenCalled();

    const finished = await handlers["stt:stream:finish"]?.({}, "r2" as never);
    expect(finished).toEqual({ text: "整段结果" });
  });

  it("local-zipformer-stream 的整段转写走临时流式会话", async () => {
    mocks.zipHas.mockReturnValue(true);
    mocks.zipFinish.mockResolvedValue("整段流式结果");
    const pcm = Buffer.from([1, 0, 2, 0]);
    const result = await handlers["stt:transcribe"]?.({}, {
      audio: wav(pcm), mimeType: "audio/wav", fileName: "a.wav",
      asrSettings: { ...settings("local-zipformer-stream"), model: "zipformer-bilingual-zh-en-int8" },
    } as never);
    expect(result).toEqual({ text: "整段流式结果" });
    // 整段路径不应误落到在线转写或 SenseVoice。
    expect(mocks.transcribeOnline).not.toHaveBeenCalled();
    expect(mocks.transcribePcm).not.toHaveBeenCalled();
  });

  it("已删除的 local-whisper 不会被当作在线协议发送", async () => {
    await expect(handlers["stt:transcribe"]?.({}, {
      audio: new ArrayBuffer(8), mimeType: "audio/wav", fileName: "a.wav",
      asrSettings: settings("local-whisper"),
    } as never)).rejects.toThrow(/不支持的 ASR 协议/);
    expect(mocks.transcribeOnline).not.toHaveBeenCalled();
  });
});
