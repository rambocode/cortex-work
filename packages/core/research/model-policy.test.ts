// model-policy.ts 的模型出站闸测试（spec KTD5 / §19.2.5）。
//
// 最关键的一条：local_only 且没有任何 loopback provider 时必须失败，**绝不能**回落到云 provider —
// 那等于把用户明确拒绝出站的正文偷偷发出去。
import { describe, expect, it } from "vitest";

import { describeEgress, isLoopbackBaseUrl, selectResearchModel } from "./model-policy";
import type { ModelSelectionInput } from "./model-policy";
import type { ModelDataPolicy } from "./types";

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

describe("selectResearchModel", () => {
  const policies: ModelDataPolicy[] = ["local_only", "metadata_only", "evidence_allowed"];

  // policy × provider 组合矩阵：每格给出期望的 ok / code。
  it.each([
    ["local_only", [localProvider, cloudProvider], "ollama", true, undefined],
    ["local_only", [localProvider], "ollama", true, undefined],
    ["local_only", [cloudProvider], undefined, false, "local_model_unavailable"],
    ["local_only", [], undefined, false, "no_provider_configured"],
    ["metadata_only", [localProvider, cloudProvider], "ollama", true, undefined],
    ["metadata_only", [cloudProvider], "openai", true, undefined],
    ["metadata_only", [], undefined, false, "no_provider_configured"],
    ["evidence_allowed", [localProvider, cloudProvider], "ollama", true, undefined],
    ["evidence_allowed", [cloudProvider], "openai", true, undefined],
    ["evidence_allowed", [], undefined, false, "no_provider_configured"],
  ] as const)("policy=%s providers=%# → ok=%s", (policy, providers, providerId, ok, code) => {
    const result = selectResearchModel({ policy, providers: [...providers] });
    expect(result.ok).toBe(ok);
    if (result.ok) {
      expect(result.providerId).toBe(providerId);
      expect(result.model.length).toBeGreaterThan(0);
    } else {
      expect(result.code).toBe(code);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("local_only + 只有云 provider → local_model_unavailable，绝不回落", () => {
    const result = selectResearchModel({
      policy: "local_only",
      providers: [cloudProvider],
      preferredProviderId: "openai",
      preferredModel: "gpt-5",
    });
    expect(result).toEqual({
      ok: false,
      code: "local_model_unavailable",
      message: expect.any(String),
    });
  });

  it("local_only 下 preferredProviderId 指向云 provider 时，改选本地 provider", () => {
    const result = selectResearchModel({
      policy: "local_only",
      providers: [cloudProvider, localProvider2],
      preferredProviderId: "openai",
      preferredModel: "gpt-5",
    });
    expect(result).toEqual({
      ok: true,
      providerId: "lmstudio",
      model: "mlx-community/gemma",
      isLocal: true,
    });
  });

  it.each(policies)("%s 下 disabled provider 不参与选择", (policy) => {
    const result = selectResearchModel({
      policy,
      providers: [{ ...cloudProvider, enabled: false }, localProvider],
    });
    expect(result).toEqual({ ok: true, providerId: "ollama", model: "qwen3:8b", isLocal: true });
  });

  it("provider 存在但没有任何模型时视为未配置", () => {
    const result = selectResearchModel({
      policy: "evidence_allowed",
      providers: [{ ...cloudProvider, models: [] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no_provider_configured");
  });

  it("全部 provider 被禁用时视为未配置", () => {
    const result = selectResearchModel({
      policy: "local_only",
      providers: [{ ...localProvider, enabled: false }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no_provider_configured");
  });

  it("尊重 preferredProviderId 与 preferredModel", () => {
    const result = selectResearchModel({
      policy: "evidence_allowed",
      providers: [localProvider, cloudProvider],
      preferredProviderId: "openai",
      preferredModel: "gpt-5-mini",
    });
    expect(result).toEqual({ ok: true, providerId: "openai", model: "gpt-5-mini", isLocal: false });
  });

  it("preferredModel 不属于所选 provider 时回落到该 provider 的首个模型", () => {
    const result = selectResearchModel({
      policy: "evidence_allowed",
      providers: [cloudProvider],
      preferredProviderId: "openai",
      preferredModel: "不存在的模型",
    });
    expect(result).toEqual({ ok: true, providerId: "openai", model: "gpt-5", isLocal: false });
  });

  it("preferredProviderId 不存在时回落到首个可用 provider", () => {
    const result = selectResearchModel({
      policy: "evidence_allowed",
      providers: [cloudProvider],
      preferredProviderId: "不存在",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerId).toBe("openai");
  });

  it("isLocal 如实反映所选 provider", () => {
    const local = selectResearchModel({ policy: "metadata_only", providers: [localProvider] });
    const cloud = selectResearchModel({ policy: "metadata_only", providers: [cloudProvider] });
    expect(local.ok && local.isLocal).toBe(true);
    expect(cloud.ok && cloud.isLocal).toBe(false);
  });
});

describe("describeEgress", () => {
  it.each([
    ["local_only", { sendsFullText: true, sendsMetadata: true, sendsToRemote: false }],
    ["metadata_only", { sendsFullText: false, sendsMetadata: true, sendsToRemote: true }],
    ["evidence_allowed", { sendsFullText: true, sendsMetadata: true, sendsToRemote: true }],
  ] as const)("%s 的出站描述", (policy, expected) => {
    const described = describeEgress(policy);
    expect(described.sendsFullText).toBe(expected.sendsFullText);
    expect(described.sendsMetadata).toBe(expected.sendsMetadata);
    expect(described.sendsToRemote).toBe(expected.sendsToRemote);
    expect(described.summaryZh.length).toBeGreaterThan(0);
  });

  it("三种策略的中文摘要互不相同（UI 需要可区分的文案）", () => {
    const summaries = (["local_only", "metadata_only", "evidence_allowed"] as const).map(
      (p) => describeEgress(p).summaryZh,
    );
    expect(new Set(summaries).size).toBe(3);
  });
});
