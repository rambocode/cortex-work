import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CoreProvider,
  DEFAULT_GENERAL_SETTINGS,
  useCortexUIStore,
  usePersonalStore,
  type DesktopBridge,
} from "@cortex-work/core";
import { PersonalRightRail } from "../layout/PersonalRightRail";
import { SubagentsPanel } from "./SubagentsPanel";

const bridge = {} as DesktopBridge;

function wrapper(children: ReactNode) {
  return (
    <CoreProvider wsId="test" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      {children}
    </CoreProvider>
  );
}

describe("子代理右栏", () => {
  beforeEach(() => {
    useCortexUIStore.setState({ rightOpen: false });
    usePersonalStore.setState({
      rightView: "todos",
      terminalOpen: false,
      derivedAgents: [],
      generalSettings: {
        ...DEFAULT_GENERAL_SETTINGS,
        subagents: {
          useExistingAgents: true,
          maxParallel: 256,
          maxChildRuns: 25,
          extensionAgentsEnabled: false,
          profiles: {},
          customProfiles: [],
          automaticRoles: { title: { agent: "claude", model: "haiku" } },
        },
      },
    });
  });
  afterEach(() => cleanup());

  it("竖向工具栏打开/再次点击收起子代理面板，并保留终端入口", () => {
    render(wrapper(<PersonalRightRail />));
    fireEvent.click(screen.getByRole("button", { name: "子代理" }));
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
    expect(usePersonalStore.getState().rightView).toBe("subagents");
    fireEvent.click(screen.getByRole("button", { name: "子代理" }));
    expect(useCortexUIStore.getState().rightOpen).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "终端" }));
    expect(usePersonalStore.getState().terminalOpen).toBe(true);
  });

  it("显示 Kun 的 45 个角色，基础角色常驻，扩展角色可启用并配置", () => {
    const view = render(wrapper(<SubagentsPanel />));
    expect(screen.getByText("45 个可委派角色")).toBeInTheDocument();
    expect(screen.getByText("基础 8")).toBeInTheDocument();
    expect(screen.getByText("General Agent")).toBeInTheDocument();
    expect(screen.getByText("Frontend UI Engineer")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "启用 Frontend UI Engineer" })).toBeDisabled();

    expect(screen.queryByRole("switch", { name: "启用子代理编排" })).toBeNull();
    expect(screen.getByText("由主模型自主委派")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("spinbutton", { name: "最大并行子代理数" }), { target: { value: "4" } });
    fireEvent.blur(screen.getByRole("spinbutton", { name: "最大并行子代理数" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "单个会话的子任务上限" }), { target: { value: "12" } });
    fireEvent.blur(screen.getByRole("spinbutton", { name: "单个会话的子任务上限" }));
    fireEvent.click(screen.getByRole("switch", { name: "启用扩展代理" }));
    expect(screen.getByRole("switch", { name: "启用 Frontend UI Engineer" })).toBeEnabled();
    fireEvent.click(screen.getByRole("switch", { name: "启用 Frontend UI Engineer" }));
    expect(usePersonalStore.getState().generalSettings.subagents?.maxParallel).toBe(4);
    expect(usePersonalStore.getState().generalSettings.subagents?.maxChildRuns).toBe(12);
    expect(usePersonalStore.getState().generalSettings.subagents?.extensionAgentsEnabled).toBe(true);
    expect(usePersonalStore.getState().generalSettings.subagents?.profiles["frontend-ui-engineering"]?.enabled).toBe(true);

    fireEvent.click(view.getByRole("button", { name: "配置 Frontend UI Engineer" }));
    fireEvent.change(screen.getByLabelText("运行 Agent"), { target: { value: "codex" } });
    expect(usePersonalStore.getState().generalSettings.subagents?.profiles["frontend-ui-engineering"]?.agent).toBe("codex");
  });

  it("设置页分类默认值批量写入该分类，启用扩展角色时同步打开扩展目录", () => {
    const view = render(wrapper(<SubagentsPanel variant="settings" />));
    expect(screen.getByRole("heading", { name: "子代理" })).toBeInTheDocument();
    expect(screen.getByText(/集中管理可委派子代理的运行策略/)).toBeInTheDocument();
    expect(screen.getByText("修改会自动生效")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "子代理配置" }));

    const filters = view.container.querySelector(".pw-sa-filters");
    const researchFilter = Array.from(filters?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent?.includes("研究"));
    expect(researchFilter).toBeTruthy();
    fireEvent.click(researchFilter!);

    const defaults = view.container.querySelector(".pw-sa-category-defaults");
    expect(defaults).toBeTruthy();
    const modelInput = defaults?.querySelector("input");
    expect(modelInput).toBeTruthy();
    fireEvent.change(modelInput!, { target: { value: "research-model" } });

    const researchEntries = usePersonalStore.getState().generalSettings.subagents?.profiles ?? {};
    expect(researchEntries.explore?.model).toBe("research-model");
    expect(researchEntries["documentation-and-adrs"]?.model).toBe("research-model");
    expect(researchEntries["source-driven-development"]?.model).toBe("research-model");
    expect(researchEntries["write-citation-researcher"]?.model).toBe("research-model");
    expect(researchEntries["design-ux-researcher"]?.model).toBe("research-model");

    fireEvent.click(screen.getByRole("button", { name: /文档与 ADR 工程师/ }));
    fireEvent.click(screen.getByRole("switch", { name: "启用 文档与 ADR 工程师" }));
    expect(usePersonalStore.getState().generalSettings.subagents?.extensionAgentsEnabled).toBe(true);
    expect(usePersonalStore.getState().generalSettings.subagents?.profiles["documentation-and-adrs"]?.enabled).toBe(true);
  });

  it("设置页可创建并持久化真实自定义子代理", () => {
    render(wrapper(<SubagentsPanel variant="settings" />));
    fireEvent.click(screen.getByRole("tab", { name: "子代理配置" }));
    fireEvent.click(screen.getByRole("button", { name: "新建子代理" }));

    fireEvent.change(screen.getByPlaceholderText("例如：发布风险审查员"), { target: { value: "发布风险审查员" } });
    fireEvent.change(screen.getByPlaceholderText("说明这个角色何时应该被调用"), { target: { value: "检查上线风险" } });
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const custom = usePersonalStore.getState().generalSettings.subagents?.customProfiles[0];
    expect(custom).toMatchObject({ name: "发布风险审查员", description: "检查上线风险", surfaces: ["code"] });
    expect(screen.getByRole("button", { name: /发布风险审查员/ })).toBeInTheDocument();
  });

  it("自动模型角色设置持久化标题生成 Agent 与模型", () => {
    render(wrapper(<SubagentsPanel variant="settings" />));
    fireEvent.click(screen.getByRole("tab", { name: "自动模型角色" }));
    fireEvent.change(screen.getByLabelText("标题生成 Agent"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("标题生成模型"), { target: { value: "gpt-5.4-mini" } });

    expect(usePersonalStore.getState().generalSettings.subagents?.automaticRoles.title).toMatchObject({
      agent: "codex",
      model: "gpt-5.4-mini",
    });
  });
});
