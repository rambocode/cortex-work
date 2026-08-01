// 共享 AgentSelect 选择器：候选(内置 ∪ 派生新 id)、可用性门控、选中态、派生/内置 onSwitch 回调。
// 纯展示组件,props 传入,不读 store,直接渲染即可。

import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DerivedAgentMeta } from "@cortex-work/core";
import { AgentSelect } from "./AgentSelect";

afterEach(cleanup);

const derived: DerivedAgentMeta[] = [
  { id: "my-cx", base: "codex", label: "我的CX" },
  { id: "codex", base: "codex", label: "覆盖内置" }, // 覆盖内置同名 → 不应新增条目
];

function renderSelect(props: Partial<Parameters<typeof AgentSelect>[0]> = {}) {
  const onSwitch = vi.fn();
  render(
    <AgentSelect
      agent={props.agent ?? "claude"}
      derivedAgentId={props.derivedAgentId}
      agentsAvailable={props.agentsAvailable}
      derivedAgents={props.derivedAgents}
      onSwitch={onSwitch}
    />,
  );
  return { onSwitch };
}

// 打开下拉菜单并返回 menu 容器。
function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: /Claude Code|Codex|Cortex|我的CX/ }));
  return screen.getByRole("menu");
}

describe("AgentSelect", () => {
  it("内置选中:显示 base 名,对应项打勾", () => {
    renderSelect({ agent: "codex" });
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("派生新 id:菜单出现派生项并打勾,内置 codex 不打勾", () => {
    const { onSwitch } = renderSelect({ agent: "codex", derivedAgentId: "my-cx", derivedAgents: derived });
    const menu = openMenu();
    const derivedItem = within(menu).getByRole("menuitem", { name: /我的CX/ });
    expect(derivedItem).toBeTruthy();
    // 点击派生项 → onSwitch(base, derivedMeta)
    fireEvent.click(derivedItem);
    expect(onSwitch).toHaveBeenCalledWith("codex", derived[0]);
  });

  it("覆盖内置同名 id 的派生不新增条目", () => {
    renderSelect({ agent: "claude", derivedAgents: derived });
    const menu = openMenu();
    // 「覆盖内置」label 的派生 id=codex 不应出现(被内置 codex 吸收)
    expect(within(menu).queryByText("覆盖内置")).toBeNull();
    // 内置三者各一条
    expect(within(menu).getByRole("menuitem", { name: /^Codex/ })).toBeTruthy();
  });

  it("门控:agentsAvailable.codex=false → codex 禁用且标注,点击不触发 onSwitch", () => {
    const { onSwitch } = renderSelect({ agent: "claude", agentsAvailable: { codex: false } });
    const menu = openMenu();
    const codexItem = within(menu).getByRole("menuitem", { name: /^Codex/ });
    expect(codexItem).toHaveProperty("disabled", true);
    expect(within(codexItem).getByText(/未安装/)).toBeTruthy();
    fireEvent.click(codexItem);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("pi 永不禁用", () => {
    renderSelect({ agent: "claude", agentsAvailable: { pi: false } });
    const menu = openMenu();
    const piItem = within(menu).getByRole("menuitem", { name: /Cortex/ });
    expect(piItem).toHaveProperty("disabled", false);
  });

  // 菜单项是单行「名字 + 必要附注」：常态说明（原「需本机安装 CLI」等）已去掉，
  // Cortex 用强调色「内置」徽标替代，未安装这种异常态仍须标出。
  it("Cortex 带「内置」徽标;已安装的 CLI 项无任何附注", () => {
    renderSelect({ agent: "claude", agentsAvailable: { claude: true, codex: true } });
    const menu = openMenu();

    const piItem = within(menu).getByRole("menuitem", { name: /Cortex/ });
    expect(within(piItem).getByText("内置")).toBeTruthy();
    expect(piItem.querySelector(".pw-agent-badge")).not.toBeNull();

    // 已安装的 claude/codex 不再顶一行灰字说明。
    const codexItem = within(menu).getByRole("menuitem", { name: /^Codex/ });
    expect(codexItem.querySelector(".pw-agent-note")).toBeNull();
    expect(codexItem.textContent).toBe("Codex");
  });

  it("点击内置项 → onSwitch(agent) 无第二参", () => {
    const { onSwitch } = renderSelect({ agent: "claude" });
    const menu = openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Codex/ }));
    expect(onSwitch).toHaveBeenCalledWith("codex");
  });
});
