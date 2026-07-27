// 落地页场景 tab + 快捷能力 chips:skill chip 走 composerInsert 预置 pill,
// 视图 chip 直接切工作台;不可用能力(桥缺子域/研究引擎未开)整条不渲染。
//
// 深度研究已从视图 chip 改为 skill chip(`/skill:research`),因此它的门控走 skill 侧的
// gate 字段,判定复用 useSlashCommands 的 useResearchSkillAvailable——**两个研究开关都要开**。

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
      writingOpen: false,
      automationOpen: false,
      workflowOpen: false,
      generalSettings: {
        ...usePersonalStore.getState().generalSettings,
        // 两档都要开:deepResearchEnabled 默认是 false,只开总开关时 chip 不该出现。
        researchEngine: normalizeResearchEngineSettings({ enabled: true, deepResearchEnabled: true }),
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

  // 深度研究不再是整窗工作台入口:点 chip 只预置 pill,与演示文稿/设计稿同构,
  // 用户补一句研究目标后回车才真正发起（派发在 PersonalChatArea / NewSessionLanding）。
  it("点「深度研究」→ 预置 /skill:research pill,不打开任何工作台", () => {
    renderChips(FULL_BRIDGE);
    fireEvent.click(screen.getByRole("button", { name: "深度研究" }));
    const insert = usePersonalStore.getState().composerInsert;
    expect(insert?.skill).toEqual({ cmd: "/skill:research", displayName: "深度研究" });
    expect(insert?.text).toBe("");
    expect(insert?.submit).toBeFalsy();
    // 落地页留在原地:发起研究是回车之后的事,点 chip 不该跳走。
    expect(usePersonalStore.getState().homeOpen).toBe(true);
  });

  it("研究引擎总开关未启用 → 深度研究 chip 不渲染", () => {
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

  // 总开关开着但深度研究这一档关着:后端会直接拒绝创建,chip 再可点也只是个空壳。
  it("深度研究档位未启用 → chip 不渲染(总开关开着也一样)", () => {
    usePersonalStore.setState({
      generalSettings: {
        ...usePersonalStore.getState().generalSettings,
        researchEngine: normalizeResearchEngineSettings({ enabled: true, deepResearchEnabled: false }),
      },
    });
    renderChips(FULL_BRIDGE);
    expect(screen.queryByRole("button", { name: "深度研究" })).toBeNull();
    expect(screen.getByRole("button", { name: "演示文稿" })).toBeInTheDocument();
  });

  it("桥缺 research 子域(旧壳 / Web 端) → 深度研究 chip 不渲染", () => {
    renderChips(fakeBridge({ automation: true, workflow: true }));
    expect(screen.queryByRole("button", { name: "深度研究" })).toBeNull();
    expect(screen.getByRole("button", { name: "演示文稿" })).toBeInTheDocument();
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

  // 研究示例是完整可跑的研究目标(不是「补一个词」的半句话),点一下即可回车发起。
  it("选中 research 后整行换成研究示例,示例是完整目标句", () => {
    renderChips(FULL_BRIDGE);
    act(() => usePersonalStore.setState({ composerSkill: { cmd: "/skill:research", displayName: "深度研究" } }));
    expect(screen.queryByRole("button", { name: "演示文稿" })).toBeNull();
    const example = screen.getByRole("button", { name: "行业市场调研" });
    expect(example).toHaveAttribute("title", expect.stringContaining("市场格局"));

    fireEvent.click(example);
    const insert = usePersonalStore.getState().composerInsert;
    expect(insert?.text).toContain("AI 编程助手");
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
