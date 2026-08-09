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
});
