// model-selection.ts 的研究模型选型测试。
//
// 关键约定：**失效的偏好一律静默降级，绝不让研究不可用**（三级回落），
// 而 isLocal 必须如实反映所选 provider —— UI 拿它向用户承诺「正文会不会离开本机」，
// 报错了就是给出一个错误的隐私承诺。
import { describe, expect, it } from "vitest";

import { describeModelEgress, isLoopbackBaseUrl, selectResearchModel } from "./model-selection";
import type { ModelSelectionInput } from "./model-selection";

type Provider = ModelSelectionInput["providers"][number];

const localProvider: Provider = {
  id: "ollama",
  baseUrl: "http://localhost:11434/v1",
  enabled: true,
  models: [{ id: "qwen3:8b" }, { id: "llama3.1" }],
};

const localProvider2: Provider = {
  id: "lmstudio",
  baseUrl: "http://127.0.0.1:1234",
  enabled: true,
  models: [{ id: "mlx-community/gemma" }],
};

const cloudProvider: Provider = {
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  enabled: true,
  models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }],
};

describe("isLoopbackBaseUrl", () => {
  it.each([
    ["http://localhost:11434/v1", true, "localhost 主机名"],
    ["http://LOCALHOST:11434", true, "大小写无关"],
    ["http://api.localhost/v1", true, ".localhost 子域按 RFC 6761 解析到本机"],
    ["http://127.0.0.1:1234", true, "IPv4 loopback"],
    ["http://127.5.6.7/", true, "127/8 全段都是本机"],
    ["http://[::1]:8080", true, "IPv6 loopback"],
    ["http://0x7f000001/", true, "十六进制 loopback"],
    ["http://2130706433/", true, "十进制 loopback"],
    ["http://[::ffff:127.0.0.1]/", true, "IPv4-mapped loopback"],
    ["https://api.openai.com", false, "云端点"],
    ["http://192.168.1.5", false, "私网不等于本机"],
    ["http://10.0.0.2:8000", false, "私网不等于本机"],
    ["http://169.254.169.254", false, "link-local 不等于本机"],
    ["https://localhost.evil.com/", false, "后缀伪装"],
    ["not a url", false, "无法解析"],
    ["", false, "空串"],
  ])("%s → %s（%s）", (baseUrl, expected) => {
    expect(isLoopbackBaseUrl(baseUrl)).toBe(expected);
  });
});

describe("selectResearchModel 供应商三级回落", () => {
  it("研究偏好优先于全局默认", () => {
    const result = selectResearchModel({
      providers: [localProvider, cloudProvider],
      preference: { providerId: "openai", modelId: "gpt-5-mini" },
      fallbackProviderId: "ollama",
      fallbackModel: "qwen3:8b",
    });
    expect(result).toEqual({ ok: true, providerId: "openai", model: "gpt-5-mini", isLocal: false });
  });

  it("无研究偏好时用全局默认", () => {
    const result = selectResearchModel({
      providers: [localProvider, cloudProvider],
      fallbackProviderId: "openai",
      fallbackModel: "gpt-5-mini",
    });
    expect(result).toEqual({ ok: true, providerId: "openai", model: "gpt-5-mini", isLocal: false });
  });

  it("两级偏好都缺省时用首个可用 provider 的首个模型", () => {
    const result = selectResearchModel({ providers: [localProvider, cloudProvider] });
    expect(result).toEqual({ ok: true, providerId: "ollama", model: "qwen3:8b", isLocal: true });
  });

  it("研究偏好的 providerId 已失效（被删/改名）→ 降级到全局默认，不失败", () => {
    const result = selectResearchModel({
      providers: [localProvider, cloudProvider],
      preference: { providerId: "已删除的供应商", modelId: "某模型" },
      fallbackProviderId: "openai",
      fallbackModel: "gpt-5",
    });
    expect(result).toEqual({ ok: true, providerId: "openai", model: "gpt-5", isLocal: false });
  });

  it("研究偏好与全局默认都失效 → 降级到首个可用 provider", () => {
    const result = selectResearchModel({
      providers: [cloudProvider],
      preference: { providerId: "不存在" },
      fallbackProviderId: "也不存在",
    });
    expect(result).toEqual({ ok: true, providerId: "openai", model: "gpt-5", isLocal: false });
  });

  it("被禁用的 provider 不参与选择——哪怕偏好明确指向它", () => {
    const result = selectResearchModel({
      providers: [{ ...cloudProvider, enabled: false }, localProvider],
      preference: { providerId: "openai" },
    });
    expect(result).toEqual({ ok: true, providerId: "ollama", model: "qwen3:8b", isLocal: true });
  });
});

describe("selectResearchModel 模型三级回落", () => {
  it("偏好的 modelId 只在所选 provider 内查找——跨供应商的模型名一律作废", () => {
    // providerId 指向本地 provider，modelId 却是云家的模型名：不能硬套，
    // 否则会拼出一个必然 404 的请求。
    const result = selectResearchModel({
      providers: [localProvider, cloudProvider],
      preference: { providerId: "ollama", modelId: "gpt-5" },
    });
    expect(result).toEqual({ ok: true, providerId: "ollama", model: "qwen3:8b", isLocal: true });
  });

  it("只设 modelId 不设 providerId → 作用在全局默认 provider 上", () => {
    const result = selectResearchModel({
      providers: [localProvider, cloudProvider],
      preference: { modelId: "gpt-5-mini" },
      fallbackProviderId: "openai",
    });
    expect(result).toEqual({ ok: true, providerId: "openai", model: "gpt-5-mini", isLocal: false });
  });

  it("研究偏好 modelId 失效时退全局默认模型，再退首个模型", () => {
    const withFallback = selectResearchModel({
      providers: [cloudProvider],
      preference: { providerId: "openai", modelId: "不存在" },
      fallbackModel: "gpt-5-mini",
    });
    expect(withFallback.ok && withFallback.model).toBe("gpt-5-mini");

    const noFallback = selectResearchModel({
      providers: [cloudProvider],
      preference: { providerId: "openai", modelId: "不存在" },
      fallbackModel: "同样不存在",
    });
    expect(noFallback.ok && noFallback.model).toBe("gpt-5");
  });

  it("空串偏好等同未设置（UI 的「跟随全局默认」提交空串）", () => {
    const result = selectResearchModel({
      providers: [localProvider, cloudProvider],
      preference: { providerId: "", modelId: "" },
      fallbackProviderId: "openai",
      fallbackModel: "gpt-5-mini",
    });
    expect(result).toEqual({ ok: true, providerId: "openai", model: "gpt-5-mini", isLocal: false });
  });
});

describe("selectResearchModel 无可用供应商", () => {
  it.each([
    ["providers 为空", [] as Provider[]],
    ["全部被禁用", [{ ...localProvider, enabled: false }]],
    ["provider 存在但没有任何模型", [{ ...cloudProvider, models: [] }]],
  ])("%s → no_provider_configured", (_label, providers) => {
    const result = selectResearchModel({ providers });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("no_provider_configured");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe("isLocal", () => {
  it("如实反映所选 provider 的 baseUrl", () => {
    const local = selectResearchModel({ providers: [localProvider2] });
    const cloud = selectResearchModel({ providers: [cloudProvider] });
    expect(local.ok && local.isLocal).toBe(true);
    expect(cloud.ok && cloud.isLocal).toBe(false);
  });
});

describe("describeModelEgress", () => {
  it("本地模型：不出站", () => {
    const described = describeModelEgress(true);
    expect(described.sendsToRemote).toBe(false);
    expect(described.summaryZh.length).toBeGreaterThan(0);
  });

  it("远端模型：会出站", () => {
    const described = describeModelEgress(false);
    expect(described.sendsToRemote).toBe(true);
    expect(described.summaryZh.length).toBeGreaterThan(0);
  });

  it("两种情形的文案不同（UI 需要可区分的说明）", () => {
    expect(describeModelEgress(true).summaryZh).not.toBe(describeModelEgress(false).summaryZh);
  });
});
