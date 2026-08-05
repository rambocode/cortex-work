// Provider 认证 IPC 边界单测：状态来源判定、ambient 凭据不可删、隐藏偏好落盘、
// 以及**过桥载荷不含任何密钥**（禁泄红线的回归护栏）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const state = vi.hoisted(() => ({
  home: "",
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sent: [] as unknown[],
  available: true,
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn),
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (_c: string, payload: unknown) => state.sent.push(payload) } },
    ],
  },
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (buf: Buffer) => {
      const s = buf.toString("utf8");
      if (!s.startsWith("enc:")) throw new Error("bad cipher");
      return s.slice(4);
    },
  },
  shell: { openExternal: async () => undefined },
}));

vi.mock("../paths", () => ({
  cortexHome: () => state.home,
  ensureMigrated: async () => undefined,
  workspaceStorePath: () => join(state.home, "personal-workspace.json"),
}));

vi.mock("../log", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// Catalog 由阶段① 提供，这里给一份最小替身，只关心 provider 列表与 envVars。
vi.mock("../providers/catalog", () => ({
  getProviderCatalog: () => ({
    schemaVersion: 1,
    piVersion: "0.82.1",
    hash: "test",
    providers: [
      { id: "acme", name: "Acme", api: "openai-completions", auth: ["api-key"], models: [] },
      { id: "envy", name: "Envy", api: "openai-completions", auth: ["api-key"], envVars: ["ENVY_API_KEY"], models: [] },
      { id: "bedrock", name: "Bedrock", api: "bedrock-converse-stream", auth: ["ambient"], models: [] },
    ],
  }),
  getProviderCatalogResult: () => ({ ok: true }),
}));

import { PROVIDER_IPC } from "../providers/contract";
import type { ProviderAuthSnapshot, ProviderConnectionTestResult } from "../providers/contract";
import { resetCredentialVaultForTests, setApiKeyCredential } from "../providers/credentials";
import { providerPrefsPath, resetProviderPrefsForTests } from "../providers/prefs";
import { setPiAuthRuntimeForTests } from "../providers/pi-runtime";
import type { PiAuthRuntime } from "../providers/pi-runtime";
import { registerProviderAuthHandlers, resetProviderAuthForTests } from "./provider-auth";

/** 调用某个已注册的 handler（第一个参数是 IpcMainInvokeEvent，测试里用不到）。 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = state.handlers.get(channel);
  if (!handler) throw new Error(`未注册的通道: ${channel}`);
  return Promise.resolve(handler(undefined, ...args) as T);
}

const statusOf = (snapshot: ProviderAuthSnapshot, providerId: string) =>
  snapshot.statuses.find((item) => item.providerId === providerId);

function stubRuntime(overrides: Partial<PiAuthRuntime> = {}): PiAuthRuntime {
  const runtime: PiAuthRuntime = {
    capabilities: async () => [{ providerId: "acme", oauth: true, apiKeyLogin: false }],
    checkAuth: async () => undefined,
    login: async () => undefined,
    logout: async () => undefined,
    probe: async () => ({ modelId: "m-1" }),
    ...overrides,
  };
  setPiAuthRuntimeForTests(runtime);
  return runtime;
}

beforeEach(async () => {
  state.home = mkdtempSync(join(tmpdir(), "cortex-auth-"));
  state.handlers.clear();
  state.sent.length = 0;
  state.available = true;
  vi.resetModules();
  resetCredentialVaultForTests();
  resetProviderPrefsForTests();
  resetProviderAuthForTests();
  stubRuntime();
  registerProviderAuthHandlers();
});

afterEach(async () => {
  setPiAuthRuntimeForTests(null);
  await fsp.rm(state.home, { recursive: true, force: true });
  delete process.env.ENVY_API_KEY;
});

describe("认证状态快照", () => {
  it("Catalog 里的 Provider 默认是未配置", async () => {
    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(statusOf(snapshot, "acme")).toEqual({ providerId: "acme", configured: false, source: "none" });
    expect(snapshot.health.available).toBe(true);
  });

  it("金库里有凭据时 source = safe-storage（Cortex 自己保存的）", async () => {
    await setApiKeyCredential("acme", "sk-live-ABCDEF");
    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(statusOf(snapshot, "acme")).toMatchObject({ configured: true, type: "api-key", source: "safe-storage" });
  });

  // 环境变量名形态的 source 标签（ANTHROPIC_API_KEY）归到 env；其余（~/.aws/credentials）归 ambient。
  it("pi 报告的 ambient 凭据按标签形态分类", async () => {
    stubRuntime({
      checkAuth: async (providerId) => {
        if (providerId === "envy") return { type: "api_key", source: "ENVY_API_KEY" };
        if (providerId === "bedrock") return { type: "api_key", source: "~/.aws/credentials" };
        return undefined;
      },
    });
    resetProviderAuthForTests();

    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(statusOf(snapshot, "envy")).toMatchObject({ configured: true, source: "env" });
    expect(statusOf(snapshot, "bedrock")).toMatchObject({ configured: true, source: "ambient" });
  });

  // pi 运行时加载不了时的降级：只能按 Catalog 声明的环境变量名探 process.env。
  it("pi 运行时不可用时退化成环境变量探测", async () => {
    stubRuntime({
      checkAuth: async () => {
        throw new Error("pi-ai 加载失败");
      },
    });
    process.env.ENVY_API_KEY = "sk-env";

    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(statusOf(snapshot, "envy")).toMatchObject({ configured: true, source: "env" });
    expect(statusOf(snapshot, "acme")).toMatchObject({ configured: false, source: "none" });
  });

  it("密钥库不可用时如实报告健康状态", async () => {
    state.available = false;
    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(snapshot.health.available).toBe(false);
    expect(snapshot.health.reason).toBeTruthy();
  });
});

describe("凭据写入与注销", () => {
  it("setApiKey 落盘后状态变为已配置，且过桥载荷不含明文", async () => {
    const result = await invoke<{ ok: boolean }>(PROVIDER_IPC.authSetApiKey, "acme", "sk-live-ABCDEF");
    expect(result.ok).toBe(true);
    expect(JSON.stringify(state.sent)).not.toContain("sk-live-ABCDEF");

    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(JSON.stringify(snapshot)).not.toContain("sk-live-ABCDEF");
    expect(statusOf(snapshot, "acme")?.configured).toBe(true);
  });

  it("密钥库不可用时保存失败，且错误文案不回显用户输入的 key", async () => {
    state.available = false;
    const result = await invoke<{ ok: boolean; error?: string }>(
      PROVIDER_IPC.authSetApiKey,
      "acme",
      "sk-live-ABCDEF",
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("sk-live-ABCDEF");
  });

  it("注销删除自己保存的凭据", async () => {
    await setApiKeyCredential("acme", "k");
    expect(await invoke<{ ok: boolean }>(PROVIDER_IPC.authLogout, "acme")).toEqual({ ok: true });
    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(statusOf(snapshot, "acme")?.configured).toBe(false);
  });

  // Cortex 只能删自己保存的凭据：env / ambient 的密钥在用户 shell 与系统配置里。
  it("拒绝注销来自环境或系统配置的凭据", async () => {
    stubRuntime({ checkAuth: async () => ({ type: "api_key", source: "ENVY_API_KEY" }) });
    resetProviderAuthForTests();

    const result = await invoke<{ ok: boolean; error?: string }>(PROVIDER_IPC.authLogout, "envy");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("环境变量或系统配置");
  });
});

describe("隐藏偏好", () => {
  it("写入后经快照读回，并去重", async () => {
    expect(await invoke<{ ok: boolean }>(PROVIDER_IPC.authSetHidden, ["envy", "envy", "bedrock"])).toEqual({
      ok: true,
    });
    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(snapshot.hiddenProviderIds).toEqual(["envy", "bedrock"]);
  });

  it("过滤非字符串项，不写脏数据", async () => {
    await invoke(PROVIDER_IPC.authSetHidden, ["envy", 42, null, ""]);
    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(snapshot.hiddenProviderIds).toEqual(["envy"]);
  });

  // 刻意落在 main-owned 文件而不是 personal-workspace.json：后者由 renderer 全量覆盖写回，
  // 而 core 的 toPersistedState 是白名单构造，主进程写进去的字段会被下一次保存抹掉。
  it("落在 main-owned 的 provider-prefs.json，不进 personal-workspace.json", async () => {
    await invoke(PROVIDER_IPC.authSetHidden, ["envy"]);
    expect(JSON.parse(await fsp.readFile(providerPrefsPath(), "utf8")).hiddenProviderIds).toEqual(["envy"]);
    await expect(fsp.access(join(state.home, "personal-workspace.json"))).rejects.toBeTruthy();
  });
});

describe("baseUrl 覆盖", () => {
  it("写入后经状态回显，并推 done 事件让 UI 立即刷新", async () => {
    expect(await invoke<{ ok: boolean }>(PROVIDER_IPC.authSetBaseUrl, "acme", "https://gw.corp.com/v1")).toEqual({
      ok: true,
    });

    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(statusOf(snapshot, "acme")?.baseUrlOverride).toBe("https://gw.corp.com/v1");
    expect(state.sent.at(-1)).toMatchObject({
      type: "done",
      providerId: "acme",
      status: { baseUrlOverride: "https://gw.corp.com/v1" },
    });
  });

  it("未配置凭据时也能先配好网关（覆盖与认证正交）", async () => {
    await invoke(PROVIDER_IPC.authSetBaseUrl, "acme", "https://gw.corp.com/v1");
    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(statusOf(snapshot, "acme")).toMatchObject({
      configured: false,
      source: "none",
      baseUrlOverride: "https://gw.corp.com/v1",
    });
  });

  it("传 undefined 清除覆盖，恢复 pi 内置端点", async () => {
    await invoke(PROVIDER_IPC.authSetBaseUrl, "acme", "https://gw.corp.com/v1");
    expect(await invoke<{ ok: boolean }>(PROVIDER_IPC.authSetBaseUrl, "acme", undefined)).toEqual({ ok: true });
    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(statusOf(snapshot, "acme")?.baseUrlOverride).toBeUndefined();
  });

  it("非法地址返回结构化错误且不生效", async () => {
    const result = await invoke<{ ok: boolean; error?: string }>(PROVIDER_IPC.authSetBaseUrl, "acme", "gw.corp.com");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("合法的 URL");
    const snapshot = await invoke<ProviderAuthSnapshot>(PROVIDER_IPC.authStatus);
    expect(statusOf(snapshot, "acme")?.baseUrlOverride).toBeUndefined();
  });

  it("缺 providerId 时拒绝", async () => {
    expect(await invoke<{ ok: boolean }>(PROVIDER_IPC.authSetBaseUrl, "", "https://gw.corp.com")).toMatchObject({
      ok: false,
    });
  });

  it("落在 main-owned 的 provider-prefs.json，不进 personal-workspace.json", async () => {
    await invoke(PROVIDER_IPC.authSetBaseUrl, "acme", "https://gw.corp.com/v1");
    expect(JSON.parse(await fsp.readFile(providerPrefsPath(), "utf8")).baseUrlOverrides).toEqual({
      acme: "https://gw.corp.com/v1",
    });
    await expect(fsp.access(join(state.home, "personal-workspace.json"))).rejects.toBeTruthy();
  });
});

describe("连接测试", () => {
  it("成功时返回实际使用的模型与耗时", async () => {
    const result = await invoke<ProviderConnectionTestResult>(PROVIDER_IPC.connectionTest, "acme");
    expect(result.ok).toBe(true);
    expect(result.modelId).toBe("m-1");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("失败时错误文案已脱敏", async () => {
    stubRuntime({
      probe: async () => {
        throw new Error('401 unauthorized: {"apiKey":"sk-live-ABCDEF"}');
      },
    });
    resetProviderAuthForTests();

    const result = await invoke<ProviderConnectionTestResult>(PROVIDER_IPC.connectionTest, "acme", "m-9");
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("sk-live-ABCDEF");
    expect(result.error).toContain("401 unauthorized");
  });

  it("成功时回带完整步骤轨迹（面板的「复制诊断信息」靠它，不能只在事件里给）", async () => {
    stubRuntime({
      probe: async (_p, _m, options) => {
        options?.onStep?.({ id: "runtime", state: "running" });
        options?.onStep?.({ id: "runtime", state: "ok", ms: 12 });
        options?.onStep?.({ id: "request", state: "ok", ms: 34, detail: "maxTokens 16" });
        return { modelId: "m-1" };
      },
    });
    resetProviderAuthForTests();

    const result = await invoke<ProviderConnectionTestResult>(PROVIDER_IPC.connectionTest, "acme");
    // 同一步的 running → ok 是更新同一行，不是追加两行。
    expect(result.steps?.map((s) => `${s.id}:${s.state}`)).toEqual(["runtime:ok", "request:ok"]);
  });

  it("失败时也回带已完成的步骤——用户要看的就是「卡在哪一步」", async () => {
    stubRuntime({
      probe: async (_p, _m, options) => {
        options?.onStep?.({ id: "runtime", state: "ok", ms: 12 });
        options?.onStep?.({ id: "request", state: "error", ms: 5, detail: "401 unauthorized" });
        throw new Error("401 unauthorized");
      },
    });
    resetProviderAuthForTests();

    const result = await invoke<ProviderConnectionTestResult>(PROVIDER_IPC.connectionTest, "acme");
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(2);
    expect(result.steps?.[1]).toMatchObject({ id: "request", state: "error" });
  });
});

describe("自定义 Provider 通道", () => {
  const json = JSON.stringify({
    name: "Corp",
    baseUrl: "https://ai.corp.com/v1",
    api: "openai-completions",
    apiKey: "${secret:CORP_KEY}",
    models: [
      {
        id: "corp-1",
        name: "Corp 1",
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  });

  it("未定义的 Secret 引用导致校验与保存都失败", async () => {
    const validation = await invoke<{ ok: boolean; errors: { message: string }[] }>(
      PROVIDER_IPC.customValidate,
      json,
    );
    expect(validation.ok).toBe(false);
    expect(validation.errors.map((e) => e.message).join()).toContain("未定义的 Secret");

    const saved = await invoke<{ ok: boolean }>(PROVIDER_IPC.customSave, {
      id: "corp",
      json,
      secretRefs: [],
      updatedAt: 0,
    });
    expect(saved.ok).toBe(false);
    expect(await invoke(PROVIDER_IPC.customList)).toEqual([]);
  });

  it("先写 Secret 再保存即可通过，且列表里只有引用没有明文", async () => {
    await invoke(PROVIDER_IPC.authSetSecrets, { CORP_KEY: "sk-live-ABCDEF" });
    expect(await invoke<{ ok: boolean }>(PROVIDER_IPC.customValidate, json)).toMatchObject({ ok: true });

    const saved = await invoke<{ ok: boolean }>(PROVIDER_IPC.customSave, {
      id: "corp",
      json,
      secretRefs: [],
      updatedAt: 0,
    });
    expect(saved.ok).toBe(true);

    const list = await invoke<unknown[]>(PROVIDER_IPC.customList);
    expect(JSON.stringify(list)).not.toContain("sk-live-ABCDEF");
    expect(JSON.stringify(list)).toContain("${secret:CORP_KEY}");
  });
});

describe("旧配置清理", () => {
  it("注册 handler 时触发一次性清理", async () => {
    await fsp.writeFile(
      join(state.home, "personal-workspace.json"),
      JSON.stringify({
        version: 1,
        projects: [],
        sessions: [],
        providerSettings: { providers: [{ id: "x", apiKey: "sk-live-OLD" }] },
      }),
      "utf8",
    );

    vi.resetModules();
    const fresh = await import("./provider-auth");
    fresh.resetProviderAuthForTests();
    fresh.registerProviderAuthHandlers();

    // 清理是 fire-and-forget，没有可 await 的句柄 → 只能轮询落盘结果。
    // 原先是固定 sleep 50ms：`vi.resetModules()` 后 `import("./provider-auth")` 要重新加载
    // 整条依赖链（含 @cortex-work/core），依赖图一变大就越过那个窗口、间歇性红。
    // 轮询取代固定值：既不受模块加载耗时影响，通过时也不必白等满整个超时。
    let raw = "";
    for (let i = 0; i < 100; i += 1) {
      raw = await fsp.readFile(join(state.home, "personal-workspace.json"), "utf8");
      if (raw.includes("legacyProviderSettingsCleared")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(raw).not.toContain("sk-live-OLD");
    expect(raw).toContain("legacyProviderSettingsCleared");
  });
});
