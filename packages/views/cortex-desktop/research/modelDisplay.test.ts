// 研究模型展示解析的回归测试（阶段③收编后：Catalog 驱动 + 两级各自成套 + 不兜底）。
//
// 这里的核心不是「显示得好看」，而是**显示的模型必须等于主进程实际会用的模型**。
// 主进程侧 llm-hooks-wiring 的规则是「研究偏好 → 全局默认，两级各自成套，不取第一个模型」，
// 本文件逐条锁住同一套规则；一旦两边漂移，用户会看到「本次研究用 X」而实际什么都没跑。

import { describe, expect, it } from "vitest";
import { resolveResearchModelDisplay } from "./modelDisplay";
import type { ProviderView } from "../personal/settings/provider/useProviderData";

function view(
  id: string,
  name: string,
  baseUrl: string,
  modelIds: string[],
  over: Partial<ProviderView> = {},
): ProviderView {
  return {
    provider: {
      id,
      name,
      api: "openai-completions",
      baseUrl,
      auth: ["api-key"],
      models: modelIds.map((m) => ({
        id: m,
        name: m,
        api: "openai-completions",
        input: ["text"],
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 8_192,
      })),
    },
    status: { providerId: id, configured: true, type: "api-key", source: "safe-storage" },
    hidden: false,
    custom: false,
    ...over,
  };
}

const VIEWS: ProviderView[] = [
  view("ollama", "本机 Ollama", "http://localhost:11434/v1", ["qwen3:8b", "llama3.1"]),
  view("deepseek", "DeepSeek", "https://api.deepseek.com/v1", ["deepseek-chat"]),
];

describe("resolveResearchModelDisplay", () => {
  it("研究偏好成套且在 Catalog 里 → 用它，出站说明按 baseUrl 判本机", () => {
    const d = resolveResearchModelDisplay(VIEWS, { providerId: "ollama", modelId: "qwen3:8b" }, undefined);
    expect(d.label).toBe("本机 Ollama / qwen3:8b");
    expect(d.isLocal).toBe(true);
    expect(d.egressZh).toContain("不会离开这台设备");
  });

  it("云端 provider → 出站说明改为会发送给供应商", () => {
    const d = resolveResearchModelDisplay(VIEWS, { providerId: "deepseek", modelId: "deepseek-chat" }, undefined);
    expect(d.isLocal).toBe(false);
    expect(d.egressZh).toContain("发送给所选的模型供应商");
  });

  it("研究偏好只有一半 id → **整级作废**，落到全局默认（不拼半截引用）", () => {
    const d = resolveResearchModelDisplay(
      VIEWS,
      { providerId: "ollama" }, // 缺 modelId
      { providerId: "deepseek", modelId: "deepseek-chat" },
    );
    expect(d.label).toBe("DeepSeek / deepseek-chat");
  });

  it("研究偏好悬空（Catalog 里没有）→ 落到全局默认，仍不兜底到第一个模型", () => {
    const d = resolveResearchModelDisplay(
      VIEWS,
      { providerId: "gone", modelId: "gone-model" },
      { providerId: "ollama", modelId: "llama3.1" },
    );
    expect(d.label).toBe("本机 Ollama / llama3.1");
  });

  it("两级都悬空 → 未配置，**绝不**回退到「第一个可用模型」", () => {
    const d = resolveResearchModelDisplay(
      VIEWS,
      { providerId: "gone", modelId: "x" },
      { providerId: "also-gone", modelId: "y" },
    );
    expect(d.label).toBeNull();
    expect(d.egressZh).toContain("尚未配置");
  });

  it("两级都没有 → 未配置", () => {
    expect(resolveResearchModelDisplay(VIEWS, {}, undefined).label).toBeNull();
  });

  it("Provider 未认证或被用户隐藏 → 不算候选（与模型选择器同一口径）", () => {
    const unauth = [
      view("ollama", "本机 Ollama", "http://localhost:11434/v1", ["qwen3:8b"], {
        status: { providerId: "ollama", configured: false, source: "none" },
      }),
      view("deepseek", "DeepSeek", "https://api.deepseek.com/v1", ["deepseek-chat"], { hidden: true }),
    ];
    expect(resolveResearchModelDisplay(unauth, { providerId: "ollama", modelId: "qwen3:8b" }, undefined).label).toBeNull();
    expect(
      resolveResearchModelDisplay(unauth, { providerId: "deepseek", modelId: "deepseek-chat" }, undefined).label,
    ).toBeNull();
  });

  it("候选集为空 → 未配置", () => {
    expect(resolveResearchModelDisplay([], { providerId: "p", modelId: "m" }, undefined).label).toBeNull();
  });
});
