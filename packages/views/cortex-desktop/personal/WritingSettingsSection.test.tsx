// WritingSettingsSection 单测:Kun 对齐后的三卡结构 + 续写端点/续写开关(writingLlm 分片)+
// 检索开关(spaces store 分片,与助手面板同一状态源)。静态文案按默认 locale(zh-Hans)断言。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import { DEFAULT_WRITING_LLM_SETTINGS } from "@cortex-work/core/desktop/types";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";

import { WritingSettingsSection } from "./WritingSettingsSection";

function renderUI() {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={null}>
      <WritingSettingsSection />
    </CoreProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
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

  it("接口地址输入写 writingLlm 分片", () => {
    renderUI();
    const input = screen.getByPlaceholderText("https://api.example.com/v1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://api.test/v1" } });
    expect(usePersonalStore.getState().writingLlmSettings.baseUrl).toBe("https://api.test/v1");
  });
});
