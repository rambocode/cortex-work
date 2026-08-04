// voiceRecorder.test.ts — 指定麦克风约束、设备失效回退与听写 prompt 透传。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AsrSettings } from "@cortex-work/core/desktop/media-gen-types";

const mockEncodeBlobAsWav = vi.fn();
vi.mock("./encodeWav", () => ({
  encodeBlobAsWav: (blob: Blob) => mockEncodeBlobAsWav(blob),
}));

import { transcribeRecording, VoiceCapture } from "./voiceRecorder";

class MockMediaRecorder {
  static isTypeSupported = vi.fn().mockReturnValue(true);

  readonly mimeType: string;
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? "audio/webm";
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.onstop?.();
  }
}

const stream = {
  getTracks: () => [{ stop: vi.fn() }],
} as unknown as MediaStream;

const asr = {
  enabled: true,
  providerId: "default",
  protocol: "openai-transcriptions",
  baseUrl: "https://api.example.com",
  apiKey: "sk-test",
  model: "whisper-1",
  localWhisperDownloadSource: "huggingface",
  language: "zh",
  timeoutMs: 60_000,
} satisfies AsrSettings;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  MockMediaRecorder.isTypeSupported.mockReturnValue(true);
  mockEncodeBlobAsWav.mockResolvedValue(new ArrayBuffer(16));
});

describe("VoiceCapture.start", () => {
  it("指定设备约束不满足时回退到系统默认麦克风", async () => {
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(new DOMException("设备不可用", "OverconstrainedError"))
      .mockResolvedValueOnce(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const capture = new VoiceCapture();

    await capture.start("microphone-42");

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: { deviceId: { exact: "microphone-42" } },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: true });
    expect(capture.active).toBe(true);
    capture.dispose();
  });
});

describe("transcribeRecording", () => {
  it("将可选 prompt 传入统一转写请求", async () => {
    const transcribeSpeech = vi.fn().mockResolvedValue({ text: "Cortex" });

    await expect(
      transcribeRecording(
        { transcribeSpeech },
        asr,
        new Blob(["audio"], { type: "audio/webm" }),
        { prompt: "Cortex, Whisper, 麦克风" },
      ),
    ).resolves.toBe("Cortex");

    expect(transcribeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Cortex, Whisper, 麦克风" }),
      asr,
    );
  });
});
