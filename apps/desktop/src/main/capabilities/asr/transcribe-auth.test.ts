// transcribe-auth.test.ts — isLocalOmlxUrl / localOmlxApiKey / authHeaders 单测
// mock: node:fs/promises（readFile）、node:os（homedir）
// 直接测试模块私有行为，通过 authHeaders 的间接效果验证内部逻辑。

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock node:os ───────────────────────────────────────────────────────────────
vi.mock("node:os", () => ({
  homedir: () => "/home/testuser",
}));

// ── mock node:fs/promises ──────────────────────────────────────────────────────
const mockReadFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// ── mock 上级目录的 push-sign（audioTranscriptionsUrl re-export 源）──────────
vi.mock("../../ipc/push-sign", () => ({
  audioTranscriptionsUrl: (baseUrl: string) => `${baseUrl}/v1/audio/transcriptions`,
}));

// ── 被测模块 ──────────────────────────────────────────────────────────────────
import { authHeaders } from "./transcribe-auth";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── isLocalOmlxUrl（通过 authHeaders 间接验证） ───────────────────────────────

describe("isLocalOmlxUrl / localOmlxApiKey（通过 authHeaders 间接验证）", () => {
  describe("本地地址识别", () => {
    const LOCAL_URLS = [
      "http://localhost:8000",
      "http://127.0.0.1:8000",
      "http://[::1]:8000",
    ];

    for (const url of LOCAL_URLS) {
      it(`${url} 识别为本地地址（尝试读 omlx settings）`, async () => {
        // 读 settings 失败（文件不存在）→ 无 key → 无 Authorization 头
        mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

        const headers = await authHeaders(url);

        // 关键：本地地址时 readFile 被调用（尝试读 omlx key）
        expect(mockReadFile).toHaveBeenCalledWith(
          expect.stringContaining(".omlx"),
          "utf8",
        );
        // 文件不存在时无头
        expect(headers).toEqual({});
      });
    }

    it("非 8000 端口的 localhost 不识别为 omlx 地址", async () => {
      // 端口非 8000 时 isLocalOmlxUrl 返回 false，不读 settings
      const headers = await authHeaders("http://localhost:9999", undefined);

      // 无 apiKey + 非 omlx 地址 → 空头，且 readFile 不被调用
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(headers).toEqual({});
    });

    it("公网地址不识别为本地（不读 omlx settings）", async () => {
      const headers = await authHeaders("https://api.example.com", undefined);

      expect(mockReadFile).not.toHaveBeenCalled();
      expect(headers).toEqual({});
    });
  });

  describe("localOmlxApiKey", () => {
    it("settings.json 存在且含 api_key 时返回 Bearer 头", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ auth: { api_key: "omlx-secret-key" } }),
      );

      const headers = await authHeaders("http://localhost:8000");

      expect(headers).toEqual({ Authorization: "Bearer omlx-secret-key" });
    });

    it("settings.json 存在但 api_key 为空时无 Authorization 头", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ auth: { api_key: "" } }),
      );

      const headers = await authHeaders("http://localhost:8000");

      expect(headers).toEqual({});
    });

    it("settings.json JSON 解析失败时静默降级（无头，不抛出）", async () => {
      mockReadFile.mockResolvedValueOnce("not valid json {{{{");

      await expect(authHeaders("http://localhost:8000")).resolves.toEqual({});
    });

    it("settings.json 文件缺失时静默降级（ENOENT）", async () => {
      mockReadFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      await expect(authHeaders("http://localhost:8000")).resolves.toEqual({});
    });
  });
});

// ── authHeaders ───────────────────────────────────────────────────────────────

describe("authHeaders", () => {
  it("apiKey 优先于 omlx settings", async () => {
    // 提供了 apiKey，不应再读 omlx settings
    const headers = await authHeaders("http://localhost:8000", "explicit-key");

    // apiKey 直接使用，不读 fs
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(headers).toEqual({ Authorization: "Bearer explicit-key" });
  });

  it("apiKey 为空串时回退到 omlx settings", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ auth: { api_key: "omlx-key" } }),
    );

    const headers = await authHeaders("http://localhost:8000", "");

    expect(headers).toEqual({ Authorization: "Bearer omlx-key" });
  });

  it("公网地址 + apiKey → 直接使用 apiKey", async () => {
    const headers = await authHeaders("https://api.example.com", "my-api-key");

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(headers).toEqual({ Authorization: "Bearer my-api-key" });
  });

  it("公网地址 + 无 apiKey → 空头", async () => {
    const headers = await authHeaders("https://api.example.com", undefined);

    expect(headers).toEqual({});
  });
});
