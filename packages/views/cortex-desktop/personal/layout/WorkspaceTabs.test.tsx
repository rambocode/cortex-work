// 「团队工作区」入口的可见性门控。
//
// 这个开关的要害不是「少一个按钮」，而是**缺省必须关**：从前写死显示，每个个人用户都被迫
// 在侧栏第一行看到一个自己用不上的入口。缺省值一旦回归成显示，没人会立刻发现。
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useCortexUIStore, usePersonalStore } from "@cortex-work/core";

import { WorkspaceTabs } from "./WorkspaceTabs";

/// 只覆盖本组件读的那个字段，其余个人设置保持 store 默认值。
function setShowTeam(value: boolean | undefined): void {
  usePersonalStore.setState((s) => ({
    generalSettings: { ...s.generalSettings, showTeamWorkspace: value },
  }));
}

describe("WorkspaceTabs 可见性", () => {
  beforeEach(() => {
    useCortexUIStore.setState({ workspace: "personal" });
  });

  it("未设置时不渲染（缺省关闭）", () => {
    setShowTeam(undefined);
    const { container } = render(<WorkspaceTabs />);
    expect(container).toBeEmptyDOMElement();
  });

  it("显式关闭时不渲染", () => {
    setShowTeam(false);
    const { container } = render(<WorkspaceTabs />);
    expect(container).toBeEmptyDOMElement();
  });

  it("开启后渲染两个切换项", () => {
    setShowTeam(true);
    render(<WorkspaceTabs />);
    expect(screen.getByText("团队工作区")).toBeInTheDocument();
    expect(screen.getByText("个人工作区")).toBeInTheDocument();
  });

  it("开启后可切到团队工作区", () => {
    setShowTeam(true);
    render(<WorkspaceTabs />);
    screen.getByText("团队工作区").click();
    expect(useCortexUIStore.getState().workspace).toBe("team");
  });
});
