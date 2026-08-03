// 自定义 Provider 校验与落盘单测：pi schema 必填字段、行级错误、明文 Secret 禁令、
// `${secret:NAME}` 引用检查。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const state = vi.hoisted(() => ({ home: "" }));

vi.mock("../paths", () => ({ cortexHome: () => state.home }));
vi.mock("../log", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import {
  customProvidersPath,
  deleteCustomProvider,
  listCustomProviders,
  resetCustomProvidersForTests,
  saveCustomProvider,
  validateCustomProviderJson,
} from "./custom-providers";

/** 一份完整合法的 Pi Provider 配置（所有必填能力字段齐备）。 */
function validJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      name: "Corp Gateway",
      baseUrl: "https://ai.corp.com/v1",
      api: "openai-completions",
      apiKey: "${secret:CORP_KEY}",
      models: [
        {
          id: "corp-large",
          name: "Corp Large",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          contextWindow: 200000,
          maxTokens: 16384,
        },
      ],
      ...overrides,
    },
    null,
    2,
  );
}

const messages = (result: { errors: { message: string }[] }) => result.errors.map((e) => e.message).join("\n");

beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), "cortex-custom-"));
  resetCustomProvidersForTests();
});

afterEach(async () => {
  await fsp.rm(state.home, { recursive: true, force: true });
});

describe("validateCustomProviderJson", () => {
  it("完整配置通过", () => {
    expect(validateCustomProviderJson(validJson(), ["CORP_KEY"])).toEqual({ ok: true, errors: [] });
  });

  it("空内容与非对象顶层被拒", () => {
    expect(validateCustomProviderJson("", []).ok).toBe(false);
    expect(validateCustomProviderJson("[]", []).ok).toBe(false);
  });

  it("JSON 语法错误带行号", () => {
    const broken = '{\n  "name": "x",\n  "baseUrl": "y",\n}';
    const result = validateCustomProviderJson(broken, []);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain("JSON 语法错误");
    expect(result.errors[0]?.line).toBe(4);
  });

  // V8 少数错误文案里既没有 position 也没有 line，此时只给整体错误、不给行号，
  // 但绝不能因此崩掉校验。
  it("拿不到位置时仍返回结构化错误", () => {
    const result = validateCustomProviderJson('{\n"a": tru\n}', []);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  // 事故根因：旧实现给缺失能力字段猜默认值（reasoning:false / input:["text"] / 131072 / 8192），
  // 写进 extension 后覆盖 pi 内置目录。现在缺一个字段就拒绝保存。
  it.each([
    ["reasoning", "reasoning"],
    ["input", "input"],
    ["contextWindow", "contextWindow"],
    ["maxTokens", "maxTokens"],
    ["cost", "cost"],
    ["name", "name"],
  ])("模型缺 %s 时拒绝，不做默认值猜测", (field, expected) => {
    const parsed = JSON.parse(validJson()) as { models: Record<string, unknown>[] };
    delete parsed.models[0]![field];
    const result = validateCustomProviderJson(JSON.stringify(parsed, null, 2), ["CORP_KEY"]);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(expected);
  });

  it("input 只接受 text / image", () => {
    const result = validateCustomProviderJson(
      validJson({
        models: [
          {
            id: "m",
            name: "M",
            reasoning: false,
            input: ["text", "audio"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 100,
          },
        ],
      }),
      ["CORP_KEY"],
    );
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("input");
  });

  it("未知 api 被拒", () => {
    const result = validateCustomProviderJson(validJson({ api: "my-weird-api" }), ["CORP_KEY"]);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("不是 pi 已知的流式 API");
  });

  it("provider 与 model 都没有 api 时被拒", () => {
    const parsed = JSON.parse(validJson()) as Record<string, unknown>;
    delete parsed.api;
    const result = validateCustomProviderJson(JSON.stringify(parsed, null, 2), ["CORP_KEY"]);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("api 缺失");
  });

  it("定义模型时 baseUrl 必填且须是 http(s)", () => {
    expect(validateCustomProviderJson(validJson({ baseUrl: "ftp://x" }), ["CORP_KEY"]).ok).toBe(false);
  });

  it("空 models 或缺 models 被拒", () => {
    expect(validateCustomProviderJson(validJson({ models: [] }), ["CORP_KEY"]).ok).toBe(false);
    const parsed = JSON.parse(validJson()) as Record<string, unknown>;
    delete parsed.models;
    expect(validateCustomProviderJson(JSON.stringify(parsed), ["CORP_KEY"]).ok).toBe(false);
  });

  it("行号落在出错模型自身而不是第一个同名键上", () => {
    const parsed = JSON.parse(validJson()) as { models: Record<string, unknown>[] };
    parsed.models.push({
      id: "corp-small",
      name: "Corp Small",
      reasoning: false,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      // maxTokens 故意缺失
    });
    const text = JSON.stringify(parsed, null, 2);
    const result = validateCustomProviderJson(text, ["CORP_KEY"]);
    expect(result.ok).toBe(false);
    const firstModelLine = text.slice(0, text.indexOf('"corp-large"')).split("\n").length;
    expect(result.errors[0]?.line).toBeGreaterThan(firstModelLine);
  });
});

describe("Secret 引用与明文禁令", () => {
  it("apiKey 内嵌明文被拒", () => {
    const result = validateCustomProviderJson(validJson({ apiKey: "sk-live-ABCDEF" }), ["CORP_KEY"]);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("不得内嵌明文");
  });

  it("敏感 Header 内嵌明文被拒，引用与环境变量插值放行", () => {
    const bad = validateCustomProviderJson(
      validJson({ headers: { Authorization: "Bearer sk-live-ABCDEF" } }),
      ["CORP_KEY"],
    );
    expect(bad.ok).toBe(false);
    expect(messages(bad)).toContain("Authorization");

    const good = validateCustomProviderJson(
      validJson({ headers: { Authorization: "${secret:CORP_KEY}", "X-Corp-Auth": "$CORP_AUTH_TOKEN" } }),
      ["CORP_KEY"],
    );
    expect(good.ok).toBe(true);
  });

  it("非敏感 Header 的字面量不受影响", () => {
    expect(validateCustomProviderJson(validJson({ headers: { "X-Tenant": "acme" } }), ["CORP_KEY"]).ok).toBe(true);
  });

  it("引用未定义的 Secret 被拒", () => {
    const result = validateCustomProviderJson(validJson(), []);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("未定义的 Secret");
    expect(result.errors[0]?.line).toBeGreaterThan(0);
  });
});

describe("落盘", () => {
  it("保存后可列出，secretRefs 由主进程重新扫描（不信 renderer 传值）", async () => {
    const result = await saveCustomProvider(
      { id: "corp", json: validJson(), secretRefs: ["伪造的"], updatedAt: 0 },
      ["CORP_KEY"],
    );
    expect(result.ok).toBe(true);

    const list = await listCustomProviders();
    expect(list).toHaveLength(1);
    expect(list[0]?.secretRefs).toEqual(["CORP_KEY"]);
    expect(list[0]?.updatedAt).toBeGreaterThan(0);
  });

  it("compat 里的 maxTokensField 不被误判成明文密钥（线上故障回归）", () => {
    // isSensitiveFieldName 把键名归一后按 `includes("token")` 判定，`maxTokensField` 会中招。
    // 但它是 pi 的**协议行为开关**（目录里 93 个模型都有，取值恒为 "max_tokens"），
    // 与认证 token 毫无关系。误判的后果格外反讽：**恰恰是最需要这个开关的那批模型**
    // （经网关转发、必须用 max_tokens 而非 max_completion_tokens 的）保存不进去。
    const json = validJson({
      models: [
        {
          id: "minimax-m2.7",
          name: "MiniMax-M2.7",
          reasoning: true,
          input: ["text"],
          cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
          contextWindow: 204800,
          maxTokens: 131072,
          compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens", supportsToolSearch: true },
        },
      ],
    });
    expect(validateCustomProviderJson(json, ["CORP_KEY"])).toEqual({ ok: true, errors: [] });
  });

  it("compat 之外的敏感字段照常被拒（跳过 compat 不等于整体放松）", () => {
    const json = validJson({ headers: { Authorization: "Bearer sk-plain" } });
    expect(messages(validateCustomProviderJson(json, ["CORP_KEY"]))).toContain("不得内嵌明文");
  });

  it("落盘文件里没有明文密钥，只有 ${secret:} 引用", async () => {
    await saveCustomProvider({ id: "corp", json: validJson(), secretRefs: [], updatedAt: 0 }, ["CORP_KEY"]);
    const text = await fsp.readFile(customProvidersPath(), "utf8");
    expect(text).toContain("${secret:CORP_KEY}");
    expect(text).not.toContain("sk-live");
  });

  it("同 id 覆盖而非追加", async () => {
    await saveCustomProvider({ id: "corp", json: validJson(), secretRefs: [], updatedAt: 0 }, ["CORP_KEY"]);
    await saveCustomProvider(
      { id: "corp", json: validJson({ name: "改名了" }), secretRefs: [], updatedAt: 0 },
      ["CORP_KEY"],
    );
    const list = await listCustomProviders();
    expect(list).toHaveLength(1);
    expect(list[0]?.json).toContain("改名了");
  });

  it("校验不通过时拒绝落盘", async () => {
    const result = await saveCustomProvider(
      { id: "corp", json: validJson({ apiKey: "sk-live-ABCDEF" }), secretRefs: [], updatedAt: 0 },
      ["CORP_KEY"],
    );
    expect(result.ok).toBe(false);
    expect(await listCustomProviders()).toEqual([]);
  });

  it("非法 id 被拒", async () => {
    const result = await saveCustomProvider({ id: "有 空格", json: validJson(), secretRefs: [], updatedAt: 0 }, [
      "CORP_KEY",
    ]);
    expect(result.ok).toBe(false);
  });

  it("删除幂等", async () => {
    await saveCustomProvider({ id: "corp", json: validJson(), secretRefs: [], updatedAt: 0 }, ["CORP_KEY"]);
    expect(await deleteCustomProvider("corp")).toEqual({ ok: true });
    expect(await deleteCustomProvider("corp")).toEqual({ ok: true });
    expect(await listCustomProviders()).toEqual([]);
  });
});
