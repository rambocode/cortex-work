// 登录交互状态机单测：prompt → respond → done / cancel / error / 超时，
// 以及 auth_url / device_code 缓冲、requestId 精确匹配、错误文本禁泄。

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openExternal: async () => undefined } }));
vi.mock("../log", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import type { AuthInteraction, AuthType } from "@earendil-works/pi-ai";

import type { ProviderAuthEvent, ProviderAuthStatus } from "./contract";
import { createLoginController } from "./oauth";
import type { PiAuthRuntime } from "./pi-runtime";

const CONFIGURED: ProviderAuthStatus = {
  providerId: "acme",
  configured: true,
  type: "oauth",
  source: "safe-storage",
};

interface Harness {
  events: ProviderAuthEvent[];
  opened: string[];
  controller: ReturnType<typeof createLoginController>;
}

function makeHarness(
  login: (providerId: string, type: AuthType, interaction: AuthInteraction) => Promise<void>,
  options: { oauth?: boolean; apiKeyLogin?: boolean; promptTimeoutMs?: number } = {},
): Harness {
  const events: ProviderAuthEvent[] = [];
  const opened: string[] = [];
  const runtime: PiAuthRuntime = {
    capabilities: async () => [
      { providerId: "acme", oauth: options.oauth ?? true, apiKeyLogin: options.apiKeyLogin ?? false },
    ],
    checkAuth: async () => undefined,
    login,
    logout: async () => undefined,
    probe: async () => ({ modelId: "m" }),
  };
  const controller = createLoginController({
    runtime,
    emit: (event) => events.push(event),
    resolveStatus: async () => CONFIGURED,
    openExternal: (url) => opened.push(url),
    ...(options.promptTimeoutMs ? { promptTimeoutMs: options.promptTimeoutMs } : {}),
  });
  return { events, opened, controller };
}

/** 轮询等待条件成立（登录流程是后台异步推进的，不能靠固定 sleep）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function lastPrompt(events: ProviderAuthEvent[]): Extract<ProviderAuthEvent, { type: "prompt" }> {
  const prompt = [...events].reverse().find((event) => event.type === "prompt");
  if (!prompt || prompt.type !== "prompt") throw new Error("没有 prompt 事件");
  return prompt;
}

describe("OAuth 登录交互", () => {
  it("连续多问：每一问有独立 requestId，答案不错配", async () => {
    const answers: string[] = [];
    const { events, controller } = makeHarness(async (_id, _type, interaction) => {
      answers.push(
        await interaction.prompt({
          type: "select",
          message: "选择登录方式",
          options: [
            { id: "browser", label: "浏览器" },
            { id: "device", label: "设备码" },
          ],
        }),
      );
      answers.push(await interaction.prompt({ type: "manual_code", message: "粘贴回调码" }));
    });

    expect(await controller.start("acme")).toEqual({ ok: true });

    await waitFor(() => events.some((e) => e.type === "prompt"));
    const first = lastPrompt(events);
    expect(first.prompt.kind).toBe("select");
    expect(first.prompt.options).toEqual([
      { value: "browser", label: "浏览器" },
      { value: "device", label: "设备码" },
    ]);
    expect(controller.respond(first.prompt.requestId, "browser")).toEqual({ ok: true });

    await waitFor(() => events.filter((e) => e.type === "prompt").length === 2);
    const second = lastPrompt(events);
    expect(second.prompt.requestId).not.toBe(first.prompt.requestId);
    expect(second.prompt.kind).toBe("manual_code");
    controller.respond(second.prompt.requestId, "code-123");

    await waitFor(() => events.some((e) => e.type === "done"));
    expect(answers).toEqual(["browser", "code-123"]);
    expect(events.at(-1)).toEqual({ type: "done", providerId: "acme", status: CONFIGURED });
    expect(controller.isActive("acme")).toBe(false);
  });

  // pi 先 notify(auth_url) 再 prompt(manual_code)，两次调用；契约把 authUrl 挂在 prompt 上。
  it("auth_url 缓冲到下一问，并打开系统浏览器", async () => {
    const { events, opened, controller } = makeHarness(async (_id, _type, interaction) => {
      interaction.notify({ type: "auth_url", url: "https://sso.example.com/authorize?x=1" });
      await interaction.prompt({ type: "manual_code", message: "粘贴回调码" });
    });

    await controller.start("acme");
    await waitFor(() => events.some((e) => e.type === "prompt"));

    expect(opened).toEqual(["https://sso.example.com/authorize?x=1"]);
    expect(lastPrompt(events).prompt.authUrl).toBe("https://sso.example.com/authorize?x=1");
    expect(events.some((e) => e.type === "notify")).toBe(true);
    controller.cancel("acme");
  });

  it("device_code 同时带出设备码与验证地址", async () => {
    const { events, controller } = makeHarness(async (_id, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://sso.example.com/device",
      });
      await interaction.prompt({ type: "manual_code", message: "完成后回来" });
    });

    await controller.start("acme");
    await waitFor(() => events.some((e) => e.type === "prompt"));
    const prompt = lastPrompt(events).prompt;
    expect(prompt.deviceCode).toBe("ABCD-1234");
    expect(prompt.authUrl).toBe("https://sso.example.com/device");
    controller.cancel("acme");
  });

  it("陈旧 / 未知 requestId 的回答不生效", async () => {
    const { events, controller } = makeHarness(async (_id, _type, interaction) => {
      await interaction.prompt({ type: "text", message: "问题" });
    });
    await controller.start("acme");
    await waitFor(() => events.some((e) => e.type === "prompt"));

    expect(controller.respond("不存在的-id", "x").ok).toBe(false);

    const requestId = lastPrompt(events).prompt.requestId;
    expect(controller.respond(requestId, "x").ok).toBe(true);
    // 同一个 requestId 再答一次属于陈旧回答，必须拒绝。
    expect(controller.respond(requestId, "y").ok).toBe(false);
  });

  it("取消：待答问题被拒绝，推 error 事件", async () => {
    const { events, controller } = makeHarness(async (_id, _type, interaction) => {
      await interaction.prompt({ type: "manual_code", message: "粘贴回调码" });
    });
    await controller.start("acme");
    await waitFor(() => events.some((e) => e.type === "prompt"));

    expect(controller.cancel("acme")).toEqual({ ok: true });
    await waitFor(() => events.some((e) => e.type === "error"));
    const error = events.at(-1);
    expect(error).toEqual({ type: "error", providerId: "acme", message: "登录已取消" });
    expect(controller.isActive("acme")).toBe(false);
    expect(controller.cancel("acme").ok).toBe(false);
  });

  it("超时：等待用户输入超过上限即失败并释放会话", async () => {
    const { events, controller } = makeHarness(
      async (_id, _type, interaction) => {
        await interaction.prompt({ type: "text", message: "问题" });
      },
      { promptTimeoutMs: 30 },
    );
    await controller.start("acme");
    await waitFor(() => events.some((e) => e.type === "error"), 2000);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("超时") });
    expect(controller.isActive("acme")).toBe(false);
  });

  it("同一 Provider 不允许并发登录", async () => {
    const { events, controller } = makeHarness(async (_id, _type, interaction) => {
      await interaction.prompt({ type: "text", message: "问题" });
    });
    await controller.start("acme");
    await waitFor(() => events.some((e) => e.type === "prompt"));
    expect((await controller.start("acme")).ok).toBe(false);
    controller.cancel("acme");
  });

  it("纯 ambient Provider 无从登录", async () => {
    const { controller } = makeHarness(async () => undefined, { oauth: false, apiKeyLogin: false });
    const result = await controller.start("acme");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("不支持交互式登录");
  });

  it("未知 Provider 直接拒绝", async () => {
    const { controller } = makeHarness(async () => undefined);
    expect((await controller.start("unknown")).ok).toBe(false);
  });

  // provider SDK 抛出的错误常整段带着回调 URL（含 code）与 token，绝不能原样推给 UI。
  it("失败事件的文案已脱敏", async () => {
    const { events, controller } = makeHarness(async () => {
      throw new Error("token exchange failed: https://sso/cb?code=AUTHCODE999 access_token=AT-SECRET");
    });
    await controller.start("acme");
    await waitFor(() => events.some((e) => e.type === "error"));
    const error = events.at(-1);
    const message = error?.type === "error" ? error.message : "";
    expect(message).not.toContain("AUTHCODE999");
    expect(message).not.toContain("AT-SECRET");
    expect(message).toContain("token exchange failed");
  });

  // pi 的 per-prompt signal：回调服务器抢先拿到 code 时会 abort 这一问（auth/types.d.ts:95-100）。
  it("pi 中途 abort 某一问时，该问被判失效", async () => {
    const abort = new AbortController();
    const { events, controller } = makeHarness(async (_id, _type, interaction) => {
      const promise = interaction.prompt({ type: "manual_code", message: "粘贴回调码", signal: abort.signal });
      abort.abort();
      await promise;
    });
    await controller.start("acme");
    await waitFor(() => events.some((e) => e.type === "error"));
    const requestId = lastPrompt(events).prompt.requestId;
    expect(controller.respond(requestId, "late").ok).toBe(false);
  });
});

describe("交互式 API Key 登录", () => {
  it("没有 OAuth 钩子时走 api_key 登录流程", async () => {
    let seenType: AuthType | undefined;
    const { events, controller } = makeHarness(
      async (_id, type, interaction) => {
        seenType = type;
        await interaction.prompt({ type: "secret", message: "API key" });
      },
      { oauth: false, apiKeyLogin: true },
    );
    await controller.start("acme");
    await waitFor(() => events.some((e) => e.type === "prompt"));
    expect(seenType).toBe("api_key");
    expect(lastPrompt(events).prompt.kind).toBe("secret");
    controller.cancel("acme");
  });
});
