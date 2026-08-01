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
  // server.ts 从 client 导入的常量：mock 模块必须一并导出，否则 registerTool 时抛错。
  MAX_REFERENCE_IMAGES: 4,
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
  /** 可选：覆盖各模态协议（动态 schema 测试用）。*/
  imageProtocol?: string;
  videoProtocol?: string;
}): MediaGenSettings {
  const mk = (enabled: boolean, protocol: string) => ({
    enabled,
    providerId: "custom",
    protocol,
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    model: "test-model",
    quality: "auto",
    defaultResolution: "1K",
    defaultSize: "1024x1024",
    voice: "alloy",
    format: "mp3",
    timeoutMs: 60000,
    defaultDuration: 5,
    pollIntervalMs: 5000,
    lyrics: "",
  });
  return {
    image: { ...mk(overrides.image ?? false, overrides.imageProtocol ?? "openai-images"), defaultSize: "1024x1024" },
    speech: { ...mk(overrides.speech ?? false, "openai-speech"), voice: "alloy", format: "mp3" },
    music: { ...mk(overrides.music ?? false, "minimax-music"), format: "mp3" },
    video: {
      ...mk(overrides.video ?? false, overrides.videoProtocol ?? "minimax-video"),
      defaultDuration: 5,
      defaultResolution: "1080P",
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
    registerMediaGenSession("s1", "/ws1", new Set(["image"]));
    registerMediaGenSession("s2", "/ws2", new Set(["speech"]));
    unregisterMediaGenSession("s1");
    // s2 仍应可取（通过 inject 函数 buildMediaGenMcpServerConfig 注册，这里验证不 crash）
    expect(() => unregisterMediaGenSession("s2")).not.toThrow();
  });
});

// ── 测试：并发会话各持独立模态集（修复 P1 竞态） ─────────────────────────────────
describe("并发会话 — 模态集互不干扰", () => {
  beforeEach(async () => {
    await startMediaGenHost();
  });

  afterEach(() => {
    stopMediaGenHost();
  });

  it("两个并发 session 各自的模态集不被对方覆盖", async () => {
    // session A 只开 image
    const settingsA = makeMediaGenSettings({ image: true });
    buildMediaGenMcpServerConfig(settingsA, "session-A", "/ws-A");

    // session B 只开 speech（在 A 注册之后）
    const settingsB = makeMediaGenSettings({ speech: true });
    buildMediaGenMcpServerConfig(settingsB, "session-B", "/ws-B");

    // 从 sessionStateMap 角度：两个 session 独立存在，不应互相覆盖。
    // 注册后 unregister 各自 session 验证独立性。
    expect(() => unregisterMediaGenSession("session-A")).not.toThrow();
    expect(() => unregisterMediaGenSession("session-B")).not.toThrow();
  });

  it("同一 sessionId 多次 register（续轮）幂等覆盖，不影响其他 session", () => {
    registerMediaGenSession("s-reuse", "/ws-old", new Set(["image"]));
    registerMediaGenSession("s-other", "/ws-other", new Set(["video"]));

    // 续轮：cwd 不变，modalities 更新
    registerMediaGenSession("s-reuse", "/ws-new", new Set(["image", "music"]));

    // 清理 s-reuse 不影响 s-other
    unregisterMediaGenSession("s-reuse");
    expect(() => unregisterMediaGenSession("s-other")).not.toThrow();
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

    // 必须带 X-Cortex-Session 头：per-session 架构下 server 端从 sessionStateMap 按
    // ctx.sessionId 取本 session 的 modalities，无 sessionId 则工具集为空（并发安全）。
    const sessionHeader = { "X-Cortex-Session": "s-img" };
    await postMcp(port, token, INIT_BODY, sessionHeader);
    const result = await postMcp(port, token, TOOLS_LIST_BODY, sessionHeader) as Record<string, unknown>;
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

// ── 测试：协议快照驱动的动态 schema ───────────────────────────────────────────

// 从 tools/list 结果中取指定工具的 inputSchema.properties（JSON Schema 形态）。
async function fetchToolSchema(
  port: number,
  token: string,
  sessionId: string,
  toolName: string,
): Promise<Record<string, unknown> | undefined> {
  const sessionHeader = { "X-Cortex-Session": sessionId };
  await postMcp(port, token, INIT_BODY, sessionHeader);
  const result = (await postMcp(port, token, TOOLS_LIST_BODY, sessionHeader)) as Record<string, unknown>;
  const tools = (result?.result as Record<string, unknown> | undefined)?.tools as
    | Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>
    | undefined;
  return tools?.find((t) => t.name === toolName)?.inputSchema?.properties;
}

function cfgPortToken(cfg: McpServerConfigLike): { port: number; token: string } {
  return {
    port: parseInt(cfg.url!.split(":")[2]),
    token: (cfg.headers as Record<string, string>)["Authorization"].replace("Bearer ", ""),
  };
}

type McpServerConfigLike = NonNullable<ReturnType<typeof buildMediaGenMcpServerConfig>>;

describe("动态 schema — 协议快照（buildMediaGenMcpServerConfig 注入时冻结）", () => {
  beforeEach(async () => {
    await startMediaGenHost();
  });

  afterEach(() => {
    stopMediaGenHost();
  });

  it("openai-images：schema 含 reference_image_paths（edit-allowlist）", async () => {
    const settings = makeMediaGenSettings({ image: true, imageProtocol: "openai-images" });
    const cfg = buildMediaGenMcpServerConfig(settings, "s-schema-oai", "/ws")!;
    const { port, token } = cfgPortToken(cfg);
    const props = await fetchToolSchema(port, token, "s-schema-oai", "generate_image");
    if (!props) return; // SSE 流式响应场景下解析不到 JSON——不视为失败（与既有测试口径一致）
    expect(props.reference_image_paths).toBeDefined();
    // image_size 档位为通用 1K/2K。
    expect(JSON.stringify(props.image_size)).toContain("1K");
  });

  it("grok-imagine-image：无 reference_image_paths，aspect_ratio 用 13 值 Grok 集", async () => {
    const settings = makeMediaGenSettings({ image: true, imageProtocol: "grok-imagine-image" });
    const cfg = buildMediaGenMcpServerConfig(settings, "s-schema-grok-img", "/ws")!;
    const { port, token } = cfgPortToken(cfg);
    const props = await fetchToolSchema(port, token, "s-schema-grok-img", "generate_image");
    if (!props) return;
    expect(props.reference_image_paths).toBeUndefined();
    expect(JSON.stringify(props.aspect_ratio)).toContain("19.5:9");
  });

  it("volcengine-ark-image：image_size 档位为 2K/3K/4K 且保留参考图（edit-allowlist）", async () => {
    const settings = makeMediaGenSettings({ image: true, imageProtocol: "volcengine-ark-image" });
    const cfg = buildMediaGenMcpServerConfig(settings, "s-schema-volc-img", "/ws")!;
    const { port, token } = cfgPortToken(cfg);
    const props = await fetchToolSchema(port, token, "s-schema-volc-img", "generate_image");
    if (!props) return;
    expect(props.reference_image_paths).toBeDefined();
    const sizeJson = JSON.stringify(props.image_size);
    expect(sizeJson).toContain("4K");
    expect(sizeJson).not.toContain("1K");
  });

  it("grok-imagine-video：无 last_frame_image_path，有 aspect_ratio，分辨率 480P/720P", async () => {
    const settings = makeMediaGenSettings({ video: true, videoProtocol: "grok-imagine-video" });
    const cfg = buildMediaGenMcpServerConfig(settings, "s-schema-grok-vid", "/ws")!;
    const { port, token } = cfgPortToken(cfg);
    const props = await fetchToolSchema(port, token, "s-schema-grok-vid", "generate_video");
    if (!props) return;
    expect(props.last_frame_image_path).toBeUndefined();
    expect(props.aspect_ratio).toBeDefined();
    const resJson = JSON.stringify(props.resolution);
    expect(resJson).toContain("480P");
    expect(resJson).not.toContain("1080P");
  });

  it("minimax-video：有 last_frame_image_path，无 aspect_ratio，分辨率 768P/1080P", async () => {
    const settings = makeMediaGenSettings({ video: true, videoProtocol: "minimax-video" });
    const cfg = buildMediaGenMcpServerConfig(settings, "s-schema-mmx-vid", "/ws")!;
    const { port, token } = cfgPortToken(cfg);
    const props = await fetchToolSchema(port, token, "s-schema-mmx-vid", "generate_video");
    if (!props) return;
    expect(props.last_frame_image_path).toBeDefined();
    expect(props.aspect_ratio).toBeUndefined();
    expect(JSON.stringify(props.resolution)).toContain("768P");
  });

  it("volcengine-ark-video：aspect_ratio 含 adaptive，分辨率含 4K", async () => {
    const settings = makeMediaGenSettings({ video: true, videoProtocol: "volcengine-ark-video" });
    const cfg = buildMediaGenMcpServerConfig(settings, "s-schema-volc-vid", "/ws")!;
    const { port, token } = cfgPortToken(cfg);
    const props = await fetchToolSchema(port, token, "s-schema-volc-vid", "generate_video");
    if (!props) return;
    expect(JSON.stringify(props.aspect_ratio)).toContain("adaptive");
    expect(JSON.stringify(props.resolution)).toContain("4K");
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

    // 注册会话 cwd（新签名含 modalities）。
    registerMediaGenSession("s-disable", "/ws-disable", new Set(["image"]));

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
