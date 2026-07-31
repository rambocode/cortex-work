// Provider 用户偏好单测：隐藏列表、baseUrl 覆盖的校验/清除/幂等，以及
// 「同步读」这条给 pi-providers.ts 用的通道确实不依赖任何异步预热。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, promises as fsp, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const state = vi.hoisted(() => ({ home: "" }));

vi.mock("../paths", () => ({ cortexHome: () => state.home }));
vi.mock("../log", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import {
  getBaseUrlOverride,
  getBaseUrlOverrides,
  getHiddenProviderIds,
  providerPrefsPath,
  resetProviderPrefsForTests,
  setBaseUrlOverride,
  setHiddenProviderIds,
  validateBaseUrl,
} from "./prefs";

const readFile = () => JSON.parse(readFileSync(providerPrefsPath(), "utf8"));

beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), "cortex-prefs-"));
  resetProviderPrefsForTests();
});

afterEach(async () => {
  await fsp.rm(state.home, { recursive: true, force: true });
});

describe("隐藏偏好", () => {
  it("写入去重并落盘", () => {
    setHiddenProviderIds(["a", "a", "b"]);
    expect(getHiddenProviderIds()).toEqual(["a", "b"]);
    expect(readFile().hiddenProviderIds).toEqual(["a", "b"]);
  });

  it("过滤非字符串与空串", () => {
    setHiddenProviderIds(["a", 42, null, "", undefined]);
    expect(getHiddenProviderIds()).toEqual(["a"]);
  });

  it("首启无文件时返回空列表", () => {
    expect(getHiddenProviderIds()).toEqual([]);
  });
});

describe("validateBaseUrl", () => {
  it("接受 http/https 绝对地址", () => {
    expect(validateBaseUrl("https://gw.corp.com/v1")).toEqual({ ok: true, value: "https://gw.corp.com/v1" });
    expect(validateBaseUrl("  http://localhost:8080/v1  ")).toEqual({ ok: true, value: "http://localhost:8080/v1" });
  });

  it("拒绝空值、相对路径与非 http 协议", () => {
    expect(validateBaseUrl("")).toMatchObject({ ok: false });
    expect(validateBaseUrl("   ")).toMatchObject({ ok: false });
    expect(validateBaseUrl("/v1")).toMatchObject({ ok: false });
    expect(validateBaseUrl("gw.corp.com")).toMatchObject({ ok: false });
    // ws:// 之类只会在真发请求时才失败，那时的报错跟「Base URL 填错了」完全对不上。
    expect(validateBaseUrl("ws://gw.corp.com")).toMatchObject({ ok: false });
    expect(validateBaseUrl("file:///etc/passwd")).toMatchObject({ ok: false });
  });

  it("原样保留尾部斜杠与路径，不做归一化", () => {
    expect(validateBaseUrl("https://gw.corp.com/v1/")).toEqual({ ok: true, value: "https://gw.corp.com/v1/" });
  });
});

describe("baseUrl 覆盖", () => {
  it("写入后可读回并落盘", () => {
    setBaseUrlOverride("anthropic", "https://gw.corp.com/anthropic");
    expect(getBaseUrlOverride("anthropic")).toBe("https://gw.corp.com/anthropic");
    expect(readFile().baseUrlOverrides).toEqual({ anthropic: "https://gw.corp.com/anthropic" });
  });

  it("undefined / 空串清除覆盖，恢复内置端点", () => {
    setBaseUrlOverride("anthropic", "https://gw.corp.com");
    setBaseUrlOverride("anthropic", undefined);
    expect(getBaseUrlOverride("anthropic")).toBeUndefined();
    expect(readFile().baseUrlOverrides).toEqual({});

    setBaseUrlOverride("openai", "https://gw.corp.com");
    setBaseUrlOverride("openai", "   ");
    expect(getBaseUrlOverride("openai")).toBeUndefined();
  });

  // 一个填错的地址会让请求静默发往别处，比"没配上"危险得多，必须拒绝而不是勉强存下。
  it("非法地址抛错且不落盘", () => {
    expect(() => setBaseUrlOverride("anthropic", "not-a-url")).toThrow(/合法的 URL/);
    expect(getBaseUrlOverride("anthropic")).toBeUndefined();
  });

  it("清除一个不存在的覆盖是 no-op，不产生文件", () => {
    setBaseUrlOverride("anthropic", undefined);
    expect(() => readFile()).toThrow();
  });

  it("多个 Provider 的覆盖互不影响", () => {
    setBaseUrlOverride("anthropic", "https://a.corp.com");
    setBaseUrlOverride("openai", "https://o.corp.com");
    setBaseUrlOverride("anthropic", undefined);
    expect(getBaseUrlOverrides()).toEqual({ openai: "https://o.corp.com" });
  });

  it("与隐藏偏好共存，互不覆盖", () => {
    setHiddenProviderIds(["groq"]);
    setBaseUrlOverride("anthropic", "https://a.corp.com");
    expect(getHiddenProviderIds()).toEqual(["groq"]);
    expect(getBaseUrlOverride("anthropic")).toBe("https://a.corp.com");
  });
});

describe("同步读（供 pi-providers.ts 在 spawn 前调用）", () => {
  // extension 渲染是纯同步的，若这里要先异步预热，spawn 早于加载完成时会静默拿到「无覆盖」
  // → 请求发往官方端点，而用户以为自建网关已生效。
  it("不经任何预热，冷启动即能读到磁盘上的覆盖值", () => {
    writeFileSync(
      providerPrefsPath(),
      JSON.stringify({ version: 1, hiddenProviderIds: [], baseUrlOverrides: { anthropic: "https://gw.corp.com" } }),
      "utf8",
    );
    resetProviderPrefsForTests();
    expect(getBaseUrlOverride("anthropic")).toBe("https://gw.corp.com");
  });

  it("文件损坏时降级成空偏好，不抛错阻断 spawn", () => {
    writeFileSync(providerPrefsPath(), "{ 坏掉的 JSON", "utf8");
    resetProviderPrefsForTests();
    expect(getBaseUrlOverride("anthropic")).toBeUndefined();
    expect(getHiddenProviderIds()).toEqual([]);
  });

  it("版本不识别时降级成空偏好", () => {
    writeFileSync(providerPrefsPath(), JSON.stringify({ version: 99, baseUrlOverrides: { a: "x" } }), "utf8");
    resetProviderPrefsForTests();
    expect(getBaseUrlOverride("a")).toBeUndefined();
  });
});
