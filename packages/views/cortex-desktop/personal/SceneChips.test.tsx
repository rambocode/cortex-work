// 落地页场景 tab + 快捷能力 chips:skill chip 走 composerInsert 预置 pill,
// 视图 chip 直接切工作台;不可用能力(桥缺子域/研究引擎未开)整条不渲染。

import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { normalizeResearchEngineSettings } from "@cortex-work/core/research/settings";
import { SceneChips } from "./SceneChips";

// 桥能力开关:automationList / workflowList / research 决定对应 chip 是否渲染。
function fakeBridge(caps: { automation?: boolean; workflow?: boolean; research?: boolean } = {}): DesktopBridge {
  return {
    loadChat: async () => [],
    saveChat: async () => {},
    ...(caps.automation ? { automationList: async () => [] } : {}),
    ...(caps.workflow ? { workflowList: async () => [] } : {}),
    ...(caps.research ? { research: {} } : {}),
  } as unknown as DesktopBridge;
}

function renderChips(bridge: DesktopBridge) {
  return render(
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
      <SceneChips />
    </CoreProvider>,
  );
}

const FULL_BRIDGE = fakeBridge({ automation: true, workflow: true, research: true });

describe("SceneChips", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      composerInsert: undefined,
      composerSkill: undefined,
      homeOpen: true,
      researchOpen: false,
      writingOpen: false,
      automationOpen: false,
      workflowOpen: false,
      generalSettings: {
        ...usePersonalStore.getState().generalSettings,
        researchEngine: normalizeResearchEngineSettings({ enabled: true }),
      },
    });
  });

  it("默认「日常办公」active,展示该场景的 chips", () => {
    renderChips(FULL_BRIDGE);
    expect(screen.getByRole("tab", { name: "日常办公" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "设计创意" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "演示文稿" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "深度研究" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "写作" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "自动化" })).toBeInTheDocument();
    // 设计创意专属 chip 此时不在
    expect(screen.queryByRole("button", { name: "设计稿" })).toBeNull();
  });

  it("切到「设计创意」→ chips 换成该场景", () => {
    renderChips(FULL_BRIDGE);
    fireEvent.click(screen.getByRole("tab", { name: "设计创意" }));
    expect(screen.getByRole("tab", { name: "设计创意" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "设计稿" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Loop 工作流" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "写作" })).toBeNull();
  });

  it("点「演示文稿」→ 预置 /skill:slides pill(不直接发送)", () => {
    renderChips(FULL_BRIDGE);
    fireEvent.click(screen.getByRole("button", { name: "演示文稿" }));
    const insert = usePersonalStore.getState().composerInsert;
    // pill 展示名走中文(与输入框内 pill 一致)
    expect(insert?.skill).toEqual({ cmd: "/skill:slides", displayName: "演示文稿" });
    expect(insert?.text).toBe("");
    expect(insert?.submit).toBeFalsy();
  });

  it("点「设计稿」→ 预置 /skill:design pill,不碰死开关 designOpen", () => {
    renderChips(FULL_BRIDGE);
    fireEvent.click(screen.getByRole("tab", { name: "设计创意" }));
    fireEvent.click(screen.getByRole("button", { name: "设计稿" }));
    expect(usePersonalStore.getState().composerInsert?.skill?.cmd).toBe("/skill:design");
    expect(usePersonalStore.getState().designOpen).toBe(false);
  });

  it("点「深度研究」→ 打开研究工作台", () => {
    renderChips(FULL_BRIDGE);
    fireEvent.click(screen.getByRole("button", { name: "深度研究" }));
    expect(usePersonalStore.getState().researchOpen).toBe(true);
    expect(usePersonalStore.getState().homeOpen).toBe(false);
  });

  it("研究引擎未启用 → 深度研究 chip 不渲染", () => {
    usePersonalStore.setState({
      generalSettings: {
        ...usePersonalStore.getState().generalSettings,
        researchEngine: normalizeResearchEngineSettings({ enabled: false }),
      },
    });
    renderChips(FULL_BRIDGE);
    expect(screen.queryByRole("button", { name: "深度研究" })).toBeNull();
    // 其余 chip 不受影响
    expect(screen.getByRole("button", { name: "写作" })).toBeInTheDocument();
  });

  // 选中 skill 后的示例区：composerSkill 由 ComposerShell 镜像写入,这里直接置位模拟。
  it("未选 skill 时不显示示例区", () => {
    renderChips(FULL_BRIDGE);
    expect(screen.queryByText("像素风介绍 PPT")).toBeNull();
  });

  it("选中 slides 后整行换成示例,不再重复显示该 skill(输入框 pill 已经在了)", () => {
    renderChips(FULL_BRIDGE);
    act(() => usePersonalStore.setState({ composerSkill: { cmd: "/skill:slides", displayName: "演示文稿" } }));
    expect(screen.queryByRole("button", { name: "演示文稿" })).toBeNull();
    expect(screen.queryByRole("button", { name: "深度研究" })).toBeNull();
    expect(screen.getByRole("button", { name: "像素风介绍 PPT" })).toBeInTheDocument();
  });

  it("选中 slides 后点示例把完整提示词插入输入框", () => {
    renderChips(FULL_BRIDGE);
    act(() => usePersonalStore.setState({ composerSkill: { cmd: "/skill:slides", displayName: "演示文稿" } }));
    const example = screen.getByRole("button", { name: "像素风介绍 PPT" });
    expect(example).toBeInTheDocument();
    // 悬浮提示给出完整提示词(参考图的 tooltip 行为)
    expect(example).toHaveAttribute("title", expect.stringContaining("像素游戏风格"));

    fireEvent.click(example);
    const insert = usePersonalStore.getState().composerInsert;
    expect(insert?.text).toBe("做一份 6 页的产品介绍 PPT,像素游戏风格排版,配色炫酷丰富");
    // 只插文本:不重置 pill、不自动提交
    expect(insert?.skill).toBeUndefined();
    expect(insert?.submit).toBeFalsy();
  });

  it("选中 design 后展示 design 的示例,不串 slides 的", () => {
    renderChips(FULL_BRIDGE);
    act(() => usePersonalStore.setState({ composerSkill: { cmd: "/skill:design", displayName: "设计稿" } }));
    expect(screen.getByRole("button", { name: "产品落地页" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "像素风介绍 PPT" })).toBeNull();
  });

  it("非产物类 skill(无示例表)不渲染示例区,chips 保持完整", () => {
    renderChips(FULL_BRIDGE);
    act(() => usePersonalStore.setState({ composerSkill: { cmd: "/skill:code-review", displayName: "Code Review" } }));
    expect(screen.queryByText("像素风介绍 PPT")).toBeNull();
    expect(screen.queryByText("产品落地页")).toBeNull();
    expect(screen.getByRole("button", { name: "深度研究" })).toBeInTheDocument();
  });

  it("清空 pill 后 chips 恢复完整,示例消失", () => {
    renderChips(FULL_BRIDGE);
    act(() => usePersonalStore.setState({ composerSkill: { cmd: "/skill:slides", displayName: "演示文稿" } }));
    expect(screen.queryByRole("button", { name: "写作" })).toBeNull();
    act(() => usePersonalStore.setState({ composerSkill: undefined }));
    expect(screen.getByRole("button", { name: "写作" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "像素风介绍 PPT" })).toBeNull();
  });

  it("桥缺 automation/workflow 子域 → 对应 chip 不渲染,skill chip 仍在", () => {
    renderChips(fakeBridge({ research: true }));
    expect(screen.queryByRole("button", { name: "自动化" })).toBeNull();
    expect(screen.getByRole("button", { name: "演示文稿" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "设计创意" }));
    expect(screen.queryByRole("button", { name: "Loop 工作流" })).toBeNull();
    expect(screen.getByRole("button", { name: "设计稿" })).toBeInTheDocument();
  });
});
