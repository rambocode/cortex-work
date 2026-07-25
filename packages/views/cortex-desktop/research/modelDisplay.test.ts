// modelDisplay.ts 的测试。这层薄，但它承担一件容易错的事：
// 显示的必须是**实际会用的模型**，而不是用户填在设置里的字面值——
// 偏好失效时两者不同，界面站错一侧就会让用户以为自己在用 A、其实跑的是 B。
import { describe, expect, it } from "vitest";
import type { ProviderSettings } from "@cortex-work/core/desktop/types";
import { resolveResearchModelDisplay } from "./modelDisplay";

function settings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    providers: [
      {
        id: "ollama",
        name: "本机 Ollama",
        baseUrl: "http://localhost:11434/v1",
        endpointFormat: "chat_completions",
        models: [{ id: "qwen3:8b" }],
        enabled: true,
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        endpointFormat: "chat_completions",
        models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
        enabled: true,
      },
    ],
    ...overrides,
  };
}

describe("resolveResearchModelDisplay", () => {
  it("按研究偏好显示「供应商名 / 模型」", () => {
    const display = resolveResearchModelDisplay(settings(), {
      providerId: "deepseek",
      modelId: "deepseek-reasoner",
    });
    expect(display.label).toBe("DeepSeek / deepseek-reasoner");
    expect(display.isLocal).toBe(false);
  });

  it("偏好缺省时跟随全局默认模型", () => {
    const display = resolveResearchModelDisplay(
      settings({ defaultProviderId: "deepseek", defaultModel: "deepseek-chat" }),
      {},
    );
    expect(display.label).toBe("DeepSeek / deepseek-chat");
  });

  it("偏好失效时显示**实际会用的**那个，而不是用户填的字面值", () => {
    const display = resolveResearchModelDisplay(
      settings({ defaultProviderId: "deepseek", defaultModel: "deepseek-chat" }),
      { providerId: "已删除的供应商", modelId: "已删除的模型" },
    );
    expect(display.label).toBe("DeepSeek / deepseek-chat");
    expect(display.label).not.toContain("已删除");
  });

  it("本地模型：出站说明写明数据不离开本机", () => {
    const display = resolveResearchModelDisplay(settings(), { providerId: "ollama" });
    expect(display.isLocal).toBe(true);
    expect(display.label).toBe("本机 Ollama / qwen3:8b");
    expect(display.egressZh).toContain("不会离开");
  });

  it("云端模型：出站说明写明正文会发送", () => {
    const display = resolveResearchModelDisplay(settings(), { providerId: "deepseek" });
    expect(display.isLocal).toBe(false);
    expect(display.egressZh).toContain("发送");
  });

  it("provider 没有展示名时退回 id", () => {
    const display = resolveResearchModelDisplay(
      settings({
        providers: [
          {
            id: "custom",
            name: "   ",
            baseUrl: "https://api.custom.com/v1",
            endpointFormat: "chat_completions",
            models: [{ id: "m1" }],
            enabled: true,
          },
        ],
      }),
      {},
    );
    expect(display.label).toBe("custom / m1");
  });

  it("一个可用供应商都没有时 label 为 null，并给出引导文案", () => {
    const display = resolveResearchModelDisplay({ providers: [] }, {});
    expect(display.label).toBeNull();
    expect(display.egressZh.length).toBeGreaterThan(0);
  });
});
