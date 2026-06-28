// 「自定义」下拉:合并原 ApprovalPill(执行模式)+ ModePill(工作区)两组。
// 覆盖:默认收起、两组档位、选择回调透传、ask 在非 pi 降级标记、running 禁用、opt-in 门控。

import { cleanup, render, fireEvent, screen } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { CustomizePill } from "./CustomizePill";

function renderPill(props: Partial<Parameters<typeof CustomizePill>[0]> = {}) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={{} as unknown as DesktopBridge}>
      <CustomizePill
        agent="pi"
        approvalPolicy="auto"
        onChangeApprovalPolicy={() => {}}
        permissionMode="accept-edits"
        onChangePermissionMode={() => {}}
        running={false}
        {...props}
      />
    </CoreProvider>,
  );
}

describe("CustomizePill(自定义:执行模式 + 工作区)", () => {
  afterEach(() => cleanup());

  it("默认收起,点击「自定义」上弹菜单含两组档位", () => {
    const { container } = renderPill();
    expect(container.querySelector(".pw-tb-menu")).toBeNull();
    fireEvent.click(screen.getByLabelText("自定义"));
    expect(container.querySelector(".pw-tb-menu.pw-tb-menu--up")).not.toBeNull();
    // 执行模式 2 档 + 工作区 4 档 = 6 个 radio。
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(6);
  });

  it("点执行模式「询问后执行」→ 透传 ask;菜单保持展开(可连改)", () => {
    const onChangeApprovalPolicy = vi.fn();
    const { container } = renderPill({ onChangeApprovalPolicy });
    fireEvent.click(screen.getByLabelText("自定义"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /询问后执行/ }));
    expect(onChangeApprovalPolicy).toHaveBeenCalledWith("ask");
    expect(container.querySelector(".pw-tb-menu")).not.toBeNull();
  });

  it("点工作区「外部沙箱」→ 透传 sandbox", () => {
    const onChangePermissionMode = vi.fn();
    renderPill({ onChangePermissionMode });
    fireEvent.click(screen.getByLabelText("自定义"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /外部沙箱/ }));
    expect(onChangePermissionMode).toHaveBeenCalledWith("sandbox");
  });

  it("非 pi 的「询问后执行」项标降级(data-warn)", () => {
    renderPill({ agent: "claude" });
    fireEvent.click(screen.getByLabelText("自定义"));
    const ask = screen.getByRole("menuitemradio", { name: /询问后执行/ });
    expect(ask.getAttribute("data-warn")).toBe("1");
  });

  it("pi 的「询问后执行」项不降级", () => {
    renderPill({ agent: "pi" });
    fireEvent.click(screen.getByLabelText("自定义"));
    const ask = screen.getByRole("menuitemradio", { name: /询问后执行/ });
    expect(ask.getAttribute("data-warn")).toBeNull();
  });

  it("running 时所有档位 disabled", () => {
    renderPill({ running: true });
    fireEvent.click(screen.getByLabelText("自定义"));
    for (const r of screen.getAllByRole("menuitemradio")) {
      expect((r as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("仅传执行模式 onChange:只渲染执行模式组(2 档,无工作区组)", () => {
    renderPill({ onChangePermissionMode: undefined });
    fireEvent.click(screen.getByLabelText("自定义"));
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(2);
    expect(screen.queryByRole("menuitemradio", { name: /外部沙箱/ })).toBeNull();
  });

  it("当前选中项标记(is-on + aria-checked)", () => {
    renderPill({ approvalPolicy: "auto" });
    fireEvent.click(screen.getByLabelText("自定义"));
    const auto = screen.getByRole("menuitemradio", { name: /自动执行/ });
    expect(auto.classList.contains("is-on")).toBe(true);
    expect(auto.getAttribute("aria-checked")).toBe("true");
  });

  it("pi 也渲染子 agent 编排开关", () => {
    const onToggleSubagentOrchestration = vi.fn();
    renderPill({ agent: "pi", subagentOrchestration: false, onToggleSubagentOrchestration });
    fireEvent.click(screen.getByLabelText("自定义"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /已关闭/ }));
    expect(onToggleSubagentOrchestration).toHaveBeenCalledTimes(1);
  });
});
