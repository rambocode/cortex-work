import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  transcribeOnline: vi.fn(),
  start: vi.fn(),
  append: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn(),
  transcribePcm: vi.fn(),
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

  it("已删除的 local-whisper 不会被当作在线协议发送", async () => {
    await expect(handlers["stt:transcribe"]?.({}, {
      audio: new ArrayBuffer(8), mimeType: "audio/wav", fileName: "a.wav",
      asrSettings: settings("local-whisper"),
    } as never)).rejects.toThrow(/不支持的 ASR 协议/);
    expect(mocks.transcribeOnline).not.toHaveBeenCalled();
  });
});
