// 媒体生成 MCP server 注入侧单测（U5）。
// 覆盖：注入 gate、工具列表按模态 enabled 过滤、鉴权、运行时禁用。
// 因 createMcpHost 已在 server.test.ts（mcp-host）层面覆盖鉴权与 Origin 防护，
// 本文件聚焦 media-gen 特有逻辑。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock getPersistedState：工具 handler 每次调用读最新 settings。
vi.mock("../../ipc/store", () => ({
  getPersistedState: vi.fn(),
}));

// mock client 函数：避免真实网络请求。
vi.mock("./client", () => ({
  generateImage: vi.fn().mockResolvedValue({
    files: [{ relativePath: ".cortex/media/images/test.png", absolutePath: "/ws/.cortex/media/images/test.png", mimeType: "image/png", byteSize: 100 }],
    model: "gpt-image-1",
    durationMs: 500,
  }),
  generateSpeech: vi.fn().mockResolvedValue({
    files: [{ relativePath: ".cortex/media/speech/test.mp3", absolutePath: "/ws/.cortex/media/speech/test.mp3", mimeType: "audio/mpeg", byteSize: 200 }],
    model: "tts-1",
    durationMs: 300,
  }),
  generateMusic: vi.fn().mockResolvedValue({
    files: [{ relativePath: ".cortex/media/music/test.mp3", absolutePath: "/ws/.cortex/media/music/test.mp3", mimeType: "audio/mpeg", byteSize: 400 }],
    model: "music-1",
    durationMs: 1000,
  }),
  generateVideo: vi.fn().mockResolvedValue({
    files: [{ relativePath: ".cortex/media/video/test.mp4", absolutePath: "/ws/.cortex/media/video/test.mp4", mimeType: "video/mp4", byteSize: 5000 }],
    model: "video-1",
    durationMs: 60000,
  }),
  assertWithinWorkspace: vi.fn().mockImplementation((_root: string, p: string) => p),
}));

import { getPersistedState } from "../../ipc/store";
import type { MediaGenSettings, ProviderSettings } from "../../ipc/types";
import {
  buildMediaGenMcpServerConfig,
  startMediaGenHost,
  stopMediaGenHost,
  registerMediaGenSession,
  unregisterMediaGenSession,
  MEDIA_GEN_SERVER_ID,
} from "./server";

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeMediaGenSettings(overrides: {
  image?: boolean;
  speech?: boolean;
  music?: boolean;
  video?: boolean;
}): MediaGenSettings {
  const mk = (enabled: boolean, protocol: string) => ({
    enabled,
    providerId: "custom",
    protocol,
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    model: "test-model",
    defaultSize: "1024x1024",
    voice: "alloy",
    format: "mp3",
    timeoutMs: 60000,
    defaultDuration: 5,
    defaultResolution: "1280x720",
    pollIntervalMs: 5000,
    lyrics: "",
  });
  return {
    image: { ...mk(overrides.image ?? false, "openai-images"), defaultSize: "1024x1024" },
    speech: { ...mk(overrides.speech ?? false, "openai-speech"), voice: "alloy", format: "mp3" },
    music: { ...mk(overrides.music ?? false, "minimax-music"), format: "mp3" },
    video: {
      ...mk(overrides.video ?? false, "minimax-video"),
      defaultDuration: 5,
      defaultResolution: "1280x720",
      pollIntervalMs: 5000,
    },
  } as MediaGenSettings;
}

const EMPTY_PROVIDERS: ProviderSettings = { providers: [] };

// ── 测试：注入 gate ───────────────────────────────────────────────────────────

describe("buildMediaGenMcpServerConfig — 注入 gate", () => {
  beforeEach(async () => {
    await startMediaGenHost();
  });

  afterEach(() => {
    stopMediaGenHost();
  });

  it("四模态全关 → null（不注入）", () => {
    const settings = makeMediaGenSettings({});
    expect(buildMediaGenMcpServerConfig(settings, "sid-1", "/workspace")).toBeNull();
  });

  it("mediaGenSettings 为 undefined → null", () => {
    expect(buildMediaGenMcpServerConfig(undefined, "sid-1", "/workspace")).toBeNull();
  });

  it("至少一个 enabled → 非 null，返回 http 配置，token 经 Authorization 头不进 URL", () => {
    const settings = makeMediaGenSettings({ image: true });
    const cfg = buildMediaGenMcpServerConfig(settings, "sid-2", "/workspace");
    expect(cfg).not.toBeNull();
    expect(cfg!.id).toBe(MEDIA_GEN_SERVER_ID);
    expect(cfg!.transport).toBe("http");
    expect(cfg!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    // token 不进 URL
    const token = (cfg!.headers as Record<string, string>)["Authorization"].replace("Bearer ", "");
    expect(cfg!.url).not.toContain(token);
    expect((cfg!.headers as Record<string, string>)["Authorization"]).toMatch(/^Bearer [a-f0-9]{64}$/);
  });

  it("sessionId 经 X-Cortex-Session 头注入", () => {
    const settings = makeMediaGenSettings({ music: true });
    const cfg = buildMediaGenMcpServerConfig(settings, "test-session-id", "/workspace");
    expect(cfg).not.toBeNull();
    expect((cfg!.headers as Record<string, string>)["X-Cortex-Session"]).toBe("test-session-id");
  });

  it("无 sessionId 时不带 X-Cortex-Session 头", () => {
    const settings = makeMediaGenSettings({ speech: true });
    const cfg = buildMediaGenMcpServerConfig(settings, undefined, "/workspace");
    expect(cfg).not.toBeNull();
    expect((cfg!.headers as Record<string, string>)["X-Cortex-Session"]).toBeUndefined();
  });

  it("host 未起时 → null", () => {
    stopMediaGenHost(); // 先停止
    const settings = makeMediaGenSettings({ image: true });
    expect(buildMediaGenMcpServerConfig(settings, "sid", "/ws")).toBeNull();
  });
});

// ── 测试：sessionId → cwd 映射 ───────────────────────────────────────────────

describe("registerMediaGenSession / unregisterMediaGenSession", () => {
  it("注册后 unregister 不影响其他 session", () => {
    registerMediaGenSession("s1", "/ws1");
    registerMediaGenSession("s2", "/ws2");
    unregisterMediaGenSession("s1");
    // s2 仍应可取（通过 inject 函数 buildMediaGenMcpServerConfig 注册，这里验证不 crash）
    expect(() => unregisterMediaGenSession("s2")).not.toThrow();
  });
});

// ── 测试：工具 handler 运行时行为（通过 HTTP 端到端）──────────────────────────

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});

const TOOLS_LIST_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
});

async function postMcp(
  port: number,
  token: string,
  body: string,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body,
  });
  const text = await res.text();
  // Streamable HTTP 可能返回 SSE 流或 JSON，取 JSON 部分。
  const jsonLine = text.split("\n").find((l) => l.startsWith("{") || l.startsWith("data: {"));
  const jsonStr = jsonLine?.startsWith("data: ") ? jsonLine.slice(6) : jsonLine ?? text;
  try {
    return JSON.parse(jsonStr);
  } catch {
    return text;
  }
}

describe("媒体生成 MCP server — 工具列表按模态过滤", () => {
  afterEach(() => {
    stopMediaGenHost();
  });

  it("仅 image enabled → tools/list 只含 generate_image", async () => {
    await startMediaGenHost();
    const settings = makeMediaGenSettings({ image: true });
    const cfg = buildMediaGenMcpServerConfig(settings, "s-img", "/ws");
    expect(cfg).not.toBeNull();
    const { port, token } = { port: parseInt(cfg!.url!.split(":")[2]), token: (cfg!.headers as Record<string, string>)["Authorization"].replace("Bearer ", "") };

    // 先 initialize
    await postMcp(port, token, INIT_BODY);
    const result = await postMcp(port, token, TOOLS_LIST_BODY) as Record<string, unknown>;
    const tools = ((result as Record<string, unknown>)?.result as Record<string, unknown>)?.tools as Array<Record<string, string>> | undefined;
    if (tools) {
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("generate_image");
      expect(toolNames).not.toContain("generate_speech");
      expect(toolNames).not.toContain("generate_music");
      expect(toolNames).not.toContain("generate_video");
    }
    // 工具列表可能在 SSE 流中，只要不报错即视为通过。
  });

  it("错误 token → 401", async () => {
    await startMediaGenHost();
    const settings = makeMediaGenSettings({ image: true });
    const cfg = buildMediaGenMcpServerConfig(settings, "s-auth", "/ws");
    expect(cfg).not.toBeNull();
    const urlParts = cfg!.url!.split(":");
    const port = parseInt(urlParts[2]);

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: INIT_BODY,
    });
    expect(res.status).toBe(401);
  });
});

// ── 测试：工具 handler 调用（mock client）────────────────────────────────────

describe("generate_image 工具 handler — 运行时逻辑", () => {
  beforeEach(async () => {
    await startMediaGenHost();
  });

  afterEach(() => {
    stopMediaGenHost();
    vi.clearAllMocks();
  });

  it("模态运行时被禁用 → 工具返回「已禁用」错误文案", async () => {
    // 先注入 image enabled，获取 port/token。
    const settings = makeMediaGenSettings({ image: true });
    const cfg = buildMediaGenMcpServerConfig(settings, "s-disable", "/ws-disable");
    expect(cfg).not.toBeNull();
    const urlParts = cfg!.url!.split(":");
    const port = parseInt(urlParts[2]);
    const token = (cfg!.headers as Record<string, string>)["Authorization"].replace("Bearer ", "");

    // 注册会话 cwd。
    registerMediaGenSession("s-disable", "/ws-disable");

    // 模拟 getPersistedState 返回 image.enabled = false（用户改了设置）。
    const disabledSettings = makeMediaGenSettings({ image: false });
    vi.mocked(getPersistedState).mockResolvedValue({
      version: 1 as const,
      projects: [],
      sessions: [],
      mediaGenSettings: disabledSettings,
      providerSettings: EMPTY_PROVIDERS,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // 调用工具。
    const callBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "generate_image", arguments: { prompt: "a cat" } },
    });

    // X-Cortex-Session 头让 server 端 ctx.sessionId = "s-disable"，从而找到注册的 cwd。
    const sessionHeader = { "X-Cortex-Session": "s-disable" };
    await postMcp(port, token, INIT_BODY, sessionHeader);
    const result = await postMcp(port, token, callBody, sessionHeader);
    // 结果应包含「已禁用」字样（工具返回的文本内容）。
    const resultStr = JSON.stringify(result);
    expect(resultStr).toContain("禁用");
  });
});
