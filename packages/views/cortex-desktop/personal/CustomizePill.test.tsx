// 「自定义」下拉:执行权限(计划/询问后执行/自动执行)+ 目录执行权限(仅工作目录/所有文件/外部沙箱)两组。
// 覆盖:默认收起、两组档位、选择回调透传、ask 在非 pi 降级、sandbox 在非 codex 降级、plan 隐藏目录组、
// running 禁用、opt-in 门控。

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
        execPermission="auto"
        onChangeExecPermission={() => {}}
        dirPermission="workspace"
        onChangeDirPermission={() => {}}
        running={false}
        {...props}
      />
    </CoreProvider>,
  );
}

describe("CustomizePill(自定义:执行权限 + 目录执行权限)", () => {
  afterEach(() => cleanup());

  it("默认收起,点击「自定义」上弹菜单含两组档位", () => {
    const { container } = renderPill();
    expect(container.querySelector(".pw-tb-menu")).toBeNull();
    fireEvent.click(screen.getByLabelText("自定义"));
    expect(container.querySelector(".pw-tb-menu.pw-tb-menu--up")).not.toBeNull();
    // 执行权限 3 档 + 目录执行权限 3 档 = 6 个 radio(exec=auto 时目录组可见)。
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(6);
  });

  it("执行权限三档(计划/询问后执行/自动执行)均渲染;点「计划」→ 透传 plan", () => {
    const onChangeExecPermission = vi.fn();
    renderPill({ onChangeExecPermission });
    fireEvent.click(screen.getByLabelText("自定义"));
    expect(screen.getByRole("menuitemradio", { name: /计划/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /询问后执行/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /自动执行/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /计划/ }));
    expect(onChangeExecPermission).toHaveBeenCalledWith("plan");
  });

  it("点执行权限「询问后执行」→ 透传 ask;菜单保持展开(可连改)", () => {
    const onChangeExecPermission = vi.fn();
    const { container } = renderPill({ onChangeExecPermission });
    fireEvent.click(screen.getByLabelText("自定义"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /询问后执行/ }));
    expect(onChangeExecPermission).toHaveBeenCalledWith("ask");
    expect(container.querySelector(".pw-tb-menu")).not.toBeNull();
  });

  it("目录执行权限三档切换:点「所有文件」→ all、「仅工作目录」→ workspace、「外部沙箱」→ sandbox", () => {
    const onChangeDirPermission = vi.fn();
    renderPill({ onChangeDirPermission });
    fireEvent.click(screen.getByLabelText("自定义"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /所有文件/ }));
    expect(onChangeDirPermission).toHaveBeenCalledWith("all");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /仅工作目录/ }));
    expect(onChangeDirPermission).toHaveBeenCalledWith("workspace");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /外部沙箱/ }));
    expect(onChangeDirPermission).toHaveBeenCalledWith("sandbox");
  });

  it("执行权限选「计划」(只读)时隐藏整个目录执行权限组", () => {
    renderPill({ execPermission: "plan" });
    fireEvent.click(screen.getByLabelText("自定义"));
    // 仅剩执行权限 3 档;目录三项均不在。
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    expect(screen.queryByRole("menuitemradio", { name: /仅工作目录|所有文件|外部沙箱/ })).toBeNull();
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

  it("非 codex 的「外部沙箱」项标降级(data-warn);codex 不降级", () => {
    renderPill({ agent: "claude", execPermission: "auto" });
    fireEvent.click(screen.getByLabelText("自定义"));
    expect(screen.getByRole("menuitemradio", { name: /外部沙箱/ }).getAttribute("data-warn")).toBe("1");
    cleanup();
    renderPill({ agent: "codex", execPermission: "auto" });
    fireEvent.click(screen.getByLabelText("自定义"));
    expect(screen.getByRole("menuitemradio", { name: /外部沙箱/ }).getAttribute("data-warn")).toBeNull();
  });

  it("running 时所有档位 disabled", () => {
    renderPill({ running: true });
    fireEvent.click(screen.getByLabelText("自定义"));
    for (const r of screen.getAllByRole("menuitemradio")) {
      expect((r as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("仅传执行权限 onChange:只渲染执行权限组(3 档,无目录组)", () => {
    renderPill({ onChangeDirPermission: undefined });
    fireEvent.click(screen.getByLabelText("自定义"));
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(3);
    expect(screen.queryByRole("menuitemradio", { name: /外部沙箱/ })).toBeNull();
  });

  it("当前选中项标记(is-on + aria-checked)", () => {
    renderPill({ execPermission: "auto" });
    fireEvent.click(screen.getByLabelText("自定义"));
    const auto = screen.getByRole("menuitemradio", { name: /自动执行/ });
    expect(auto.classList.contains("is-on")).toBe(true);
    expect(auto.getAttribute("aria-checked")).toBe("true");
  });
});
