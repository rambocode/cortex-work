// WritingSettingsSection 单测:Kun 对齐后的三卡结构 + 模型引用/续写开关(writingLlm 分片)+
// 检索开关(spaces store 分片,与助手面板同一状态源)。静态文案按默认 locale(zh-Hans)断言。
// 阶段③收编后模型改为 Catalog 引用 {providerId, modelId}（不再有 baseUrl/apiKey 输入框）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoreProvider, resetProviderCatalogCache, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { DEFAULT_WRITING_LLM_SETTINGS } from "@cortex-work/core/desktop/types";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";

import { WritingSettingsSection } from "./WritingSettingsSection";

function renderUI(bridge: DesktopBridge | null = null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <WritingSettingsSection />
    </CoreProvider>,
  );
}

// 带 Catalog + 已认证状态的桥：模型选择器的候选完全来自这两个接口。
function catalogBridge(): DesktopBridge {
  return {
    providerCatalogGet: async () => ({
      ok: true,
      catalog: {
        schemaVersion: 1,
        piVersion: "0.82.1",
        hash: "t",
        providers: [
          {
            id: "wp",
            name: "WriterProvider",
            api: "openai-completions",
            auth: ["api-key"],
            models: [
              { id: "writer-model", name: "Writer Model", api: "openai-completions", input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 8192 },
            ],
          },
        ],
      },
    }),
    providerAuthStatus: async () => ({
      statuses: [{ providerId: "wp", configured: true, type: "api-key" as const, source: "safe-storage" as const }],
      health: { available: true },
      hiddenProviderIds: [],
    }),
    providerCustomList: async () => [],
  } as unknown as DesktopBridge;
}

afterEach(cleanup);
beforeEach(() => {
  resetProviderCatalogCache(); // Catalog 是模块级进程内缓存，跨用例必须清
  usePersonalStore.setState({ writingLlmSettings: { ...DEFAULT_WRITING_LLM_SETTINGS } });
  useWritingSpacesStore.setState({ retrievalEnabled: true });
});

describe("WritingSettingsSection", () => {
  it("渲染三卡:模型端点 / 写作建议 / 信息图与图片生成", () => {
    renderUI();
    expect(screen.getByText("续写/改写模型")).toBeTruthy();
    expect(screen.getByText("写作建议")).toBeTruthy();
    expect(screen.getByText("信息图与图片生成")).toBeTruthy();
    // 图片生成不在此重复配置,只给指向说明。
    expect(screen.getByText(/媒体生成 → 图片生成/)).toBeTruthy();
  });

  it("「输入停顿时显示建议」开关写 writingLlm 分片", () => {
    renderUI();
    const sw = screen.getByRole("switch", { name: "输入停顿时显示建议" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(usePersonalStore.getState().writingLlmSettings.completionEnabled).toBe(false);
  });

  it("「参考其他文档」开关写 spaces store 的 retrievalEnabled(检索单一真源)", () => {
    renderUI();
    const sw = screen.getByRole("switch", { name: "参考其他文档" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(useWritingSpacesStore.getState().retrievalEnabled).toBe(false);
  });

  it("未配置模型 → 阻断态（不再有 baseUrl/apiKey 输入框，明文密钥落盘点已消失）", () => {
    renderUI();
    expect(screen.getByText("未配置模型")).toBeTruthy();
    expect(screen.queryByPlaceholderText("https://api.example.com/v1")).toBeNull();
    expect(screen.queryByText("API Key")).toBeNull();
  });

  it("高级调优:去抖下拉写 debounceMs;maxTokens 输入写 maxTokens", () => {
    renderUI();
    // 去抖下拉(默认选中「均衡 · 650ms」)。
    const debounce = screen.getByDisplayValue("均衡 · 650ms") as HTMLSelectElement;
    fireEvent.change(debounce, { target: { value: "1000" } });
    expect(usePersonalStore.getState().writingLlmSettings.debounceMs).toBe(1000);
    // maxTokens 数字输入(aria-label)。
    const maxTokens = screen.getByLabelText("短建议最大长度") as HTMLInputElement;
    fireEvent.change(maxTokens, { target: { value: "200" } });
    expect(usePersonalStore.getState().writingLlmSettings.maxTokens).toBe(200);
  });

  it("从 Catalog 选中模型 → 写 providerId/modelId 两个字段", async () => {
    renderUI(catalogBridge());
    fireEvent.click(screen.getByText("未配置模型"));
    fireEvent.click(await screen.findByText("Writer Model"));
    const llm = usePersonalStore.getState().writingLlmSettings;
    expect(llm.providerId).toBe("wp");
    expect(llm.modelId).toBe("writer-model");
  });
});
