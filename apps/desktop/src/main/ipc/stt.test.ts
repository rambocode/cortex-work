// stt.test.ts — stt:transcribe handler 分发逻辑单测
// 验证按 protocol 路由、MAX_BYTES 超限被拒、local-whisper 模型未就绪报错。

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock electron ──────────────────────────────────────────────────────────────
vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

// ── mock capabilities/whisper/models ──────────────────────────────────────────
const mockGetModelStatus = vi.fn();
vi.mock("../capabilities/whisper/models", () => ({
  getModelStatus: (...args: unknown[]) => mockGetModelStatus(...args),
  downloadModel: vi.fn(),
  cancelDownload: vi.fn(),
  deleteModel: vi.fn(),
  checkSources: vi.fn(),
  setWhisperProgressEmitter: vi.fn(),
}));

// ── mock capabilities/whisper/transcribe ──────────────────────────────────────
const mockTranscribeLocal = vi.fn();
vi.mock("../capabilities/whisper/transcribe", () => ({
  transcribeLocal: (...args: unknown[]) => mockTranscribeLocal(...args),
}));

// ── mock capabilities/whisper/online-transcribe ───────────────────────────────
const mockTranscribeOnline = vi.fn();
vi.mock("../capabilities/whisper/online-transcribe", () => ({
  transcribeOnline: (...args: unknown[]) => mockTranscribeOnline(...args),
  ASR_MAX_BYTES: 25 * 1024 * 1024, // 25 MB
}));

// ── 提取注册的 handler ─────────────────────────────────────────────────────────
import { ipcMain } from "electron";
import { registerSttHandlers } from "./stt";

// 调用 registerSttHandlers 并收集 handle 调用
let handlers: Record<string, (event: unknown, ...args: unknown[]) => unknown> = {};
beforeEach(() => {
  handlers = {};
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: unknown) => {
    handlers[channel] = handler as (event: unknown, ...args: unknown[]) => unknown;
  });
  vi.clearAllMocks();
  // 重新注册以收集最新 handlers
  registerSttHandlers();
});

// ── 辅助构造基础请求 ──────────────────────────────────────────────────────────
function makeReq(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    audio: new ArrayBuffer(1024), // 1 KB（远低于 MAX_BYTES）
    mimeType: "audio/wav",
    fileName: "test.wav",
    asrSettings: {
      enabled: true,
      providerId: "default",
      protocol: "openai-transcriptions",
      baseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "whisper-1",
      localWhisperDownloadSource: "huggingface",
      language: "en",
      timeoutMs: 60000,
    },
    ...overrides,
  };
}

describe("stt:transcribe handler", () => {
  describe("MAX_BYTES 超限检查", () => {
    it("音频超过 25 MB 时拒绝（不走任何后端）", async () => {
      const bigAudio = new ArrayBuffer(26 * 1024 * 1024); // 26 MB
      const req = makeReq({ audio: bigAudio });

      await expect(
        handlers["stt:transcribe"]?.({}, req),
      ).rejects.toThrow(/大小限制/);

      expect(mockTranscribeLocal).not.toHaveBeenCalled();
      expect(mockTranscribeOnline).not.toHaveBeenCalled();
    });
  });

  describe("openai-transcriptions 路由", () => {
    it("protocol=openai-transcriptions → 调用 transcribeOnline", async () => {
      mockTranscribeOnline.mockResolvedValue({ text: "hello world" });
      const req = makeReq({
        asrSettings: { ...makeReq().asrSettings, protocol: "openai-transcriptions" },
      });

      const result = await handlers["stt:transcribe"]?.({}, req);

      expect(mockTranscribeOnline).toHaveBeenCalledTimes(1);
      expect(mockTranscribeLocal).not.toHaveBeenCalled();
      expect(result).toEqual({ text: "hello world" });
    });
  });

  describe("mimo-asr 路由", () => {
    it("protocol=mimo-asr → 调用 transcribeOnline（同接口形状）", async () => {
      mockTranscribeOnline.mockResolvedValue({ text: "mimo result" });
      const req = makeReq({
        asrSettings: { ...makeReq().asrSettings, protocol: "mimo-asr" },
      });

      const result = await handlers["stt:transcribe"]?.({}, req);

      expect(mockTranscribeOnline).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ text: "mimo result" });
    });
  });

  describe("local-whisper 路由", () => {
    it("模型 ready 时调用 transcribeLocal", async () => {
      mockGetModelStatus.mockResolvedValue({
        id: "whisper-small-q5_1",
        state: "ready",
        path: "/models/ggml-small.bin",
      });
      mockTranscribeLocal.mockResolvedValue({ text: "本地转写结果" });

      const req = makeReq({
        asrSettings: {
          ...makeReq().asrSettings,
          protocol: "local-whisper",
          model: "whisper-small-q5_1",
        },
      });

      const result = await handlers["stt:transcribe"]?.({}, req);

      expect(mockTranscribeLocal).toHaveBeenCalledTimes(1);
      expect(mockTranscribeOnline).not.toHaveBeenCalled();
      expect(result).toEqual({ text: "本地转写结果" });
    });

    it("transcribeLocal 参数包含 modelPath（来自 status.path）", async () => {
      const modelPath = "/userData/models/speech/whisper/whisper-small-q5_1/ggml-small.bin";
      mockGetModelStatus.mockResolvedValue({
        id: "whisper-small-q5_1",
        state: "ready",
        path: modelPath,
      });
      mockTranscribeLocal.mockResolvedValue({ text: "结果" });

      const req = makeReq({
        asrSettings: {
          ...makeReq().asrSettings,
          protocol: "local-whisper",
          model: "whisper-small-q5_1",
          language: "zh",
        },
      });

      await handlers["stt:transcribe"]?.({}, req);

      expect(mockTranscribeLocal).toHaveBeenCalledWith(
        expect.objectContaining({
          modelPath,
          language: "zh",
        }),
      );
    });

    it("模型未 ready（state=missing）时抛出清晰错误", async () => {
      mockGetModelStatus.mockResolvedValue({
        id: "whisper-small-q5_1",
        state: "missing",
        path: undefined,
      });

      const req = makeReq({
        asrSettings: {
          ...makeReq().asrSettings,
          protocol: "local-whisper",
          model: "whisper-small-q5_1",
        },
      });

      await expect(
        handlers["stt:transcribe"]?.({}, req),
      ).rejects.toThrow(/尚未就绪/);

      expect(mockTranscribeLocal).not.toHaveBeenCalled();
    });

    it("模型 state=downloading 时也报未就绪", async () => {
      mockGetModelStatus.mockResolvedValue({
        id: "whisper-small-q5_1",
        state: "downloading",
        path: undefined,
      });

      const req = makeReq({
        asrSettings: {
          ...makeReq().asrSettings,
          protocol: "local-whisper",
          model: "whisper-small-q5_1",
        },
      });

      await expect(
        handlers["stt:transcribe"]?.({}, req),
      ).rejects.toThrow(/尚未就绪/);
    });

    it("getModelStatus 返回 undefined 时报找不到", async () => {
      mockGetModelStatus.mockResolvedValue(undefined);

      const req = makeReq({
        asrSettings: {
          ...makeReq().asrSettings,
          protocol: "local-whisper",
          model: "whisper-small-q5_1",
        },
      });

      await expect(
        handlers["stt:transcribe"]?.({}, req),
      ).rejects.toThrow(/尚未就绪|未找到/);
    });
  });
});
