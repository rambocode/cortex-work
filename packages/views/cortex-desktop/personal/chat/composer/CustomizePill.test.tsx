// 执行权限选择 pill:pill 显示当前档位(完全访问=橙色警示),菜单为标题问句 + 两行式三档
//(标题 + 副标题 + 选中勾)。覆盖:默认收起、三档渲染与副标题、选择回调透传、ask 在非 pi 降级、
// running 禁用、警示态类名、目录执行权限组已删除(反向断言)、子 agent 编排开关。

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
        running={false}
        {...props}
      />
    </CoreProvider>,
  );
}

describe("CustomizePill(执行权限选择器)", () => {
  afterEach(() => cleanup());

  it("pill 显示当前档位文案;auto 档为「完全访问」且带警示类", () => {
    renderPill({ execPermission: "auto" });
    const pill = screen.getByLabelText("执行权限");
    expect(pill.textContent).toContain("完全访问");
    expect(pill.classList.contains("is-warn")).toBe(true);
  });

  it("plan 档 pill 显示「计划」,无警示类", () => {
    renderPill({ execPermission: "plan" });
    const pill = screen.getByLabelText("执行权限");
    expect(pill.textContent).toContain("计划");
    expect(pill.classList.contains("is-warn")).toBe(false);
  });

  it("默认收起,点击 pill 下弹菜单:标题问句(含 agent 名)+ 三档", () => {
    const { container } = renderPill();
    expect(container.querySelector(".pw-tb-menu")).toBeNull();
    fireEvent.click(screen.getByLabelText("执行权限"));
    expect(container.querySelector(".pw-tb-menu.pw-perm-menu")).not.toBeNull();
    expect(screen.getByText(/应如何批准 Cortex 操作/)).toBeInTheDocument();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
  });

  it("三档均渲染标题 + 副标题;点「计划」→ 透传 plan", () => {
    const onChangeExecPermission = vi.fn();
    renderPill({ onChangeExecPermission });
    fireEvent.click(screen.getByLabelText("执行权限"));
    expect(screen.getByRole("menuitemradio", { name: /计划/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /请求批准/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /完全访问/ })).toBeInTheDocument();
    // 副标题说明可见。
    expect(screen.getByText("只读分析,不修改文件、不执行命令")).toBeInTheDocument();
    expect(screen.getByText("可不受限制地访问互联网和您电脑上的任何文件")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /计划/ }));
    expect(onChangeExecPermission).toHaveBeenCalledWith("plan");
  });

  it("点「请求批准」→ 透传 ask;菜单保持展开(可连改)", () => {
    const onChangeExecPermission = vi.fn();
    const { container } = renderPill({ onChangeExecPermission });
    fireEvent.click(screen.getByLabelText("执行权限"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /请求批准/ }));
    expect(onChangeExecPermission).toHaveBeenCalledWith("ask");
    expect(container.querySelector(".pw-tb-menu")).not.toBeNull();
  });

  it("「完全访问」项带警示类;当前选中项带勾(is-on + aria-checked)", () => {
    renderPill({ execPermission: "auto" });
    fireEvent.click(screen.getByLabelText("执行权限"));
    const auto = screen.getByRole("menuitemradio", { name: /完全访问/ });
    expect(auto.classList.contains("is-warn")).toBe(true);
    expect(auto.classList.contains("is-on")).toBe(true);
    expect(auto.getAttribute("aria-checked")).toBe("true");
  });

  it("目录执行权限组已删除:菜单中不出现目录档位", () => {
    renderPill();
    fireEvent.click(screen.getByLabelText("执行权限"));
    expect(screen.queryByRole("menuitemradio", { name: /仅工作目录|所有文件|外部沙箱/ })).toBeNull();
    expect(screen.queryByText("目录执行权限")).toBeNull();
  });

  it("非 pi 的「请求批准」项标降级(data-warn)", () => {
    renderPill({ agent: "claude" });
    fireEvent.click(screen.getByLabelText("执行权限"));
    const ask = screen.getByRole("menuitemradio", { name: /请求批准/ });
    expect(ask.getAttribute("data-warn")).toBe("1");
  });

  it("pi 的「请求批准」项不降级", () => {
    renderPill({ agent: "pi" });
    fireEvent.click(screen.getByLabelText("执行权限"));
    const ask = screen.getByRole("menuitemradio", { name: /请求批准/ });
    expect(ask.getAttribute("data-warn")).toBeNull();
  });

  it("running 时所有档位 disabled", () => {
    renderPill({ running: true });
    fireEvent.click(screen.getByLabelText("执行权限"));
    for (const r of screen.getAllByRole("menuitemradio")) {
      expect((r as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("子 agent 编排开关已移出菜单(升为全局设置)", () => {
    renderPill();
    fireEvent.click(screen.getByLabelText("执行权限"));
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
  });

  it("菜单为下弹(无 --up 上弹类)", () => {
    const { container } = renderPill();
    fireEvent.click(screen.getByLabelText("执行权限"));
    expect(container.querySelector(".pw-tb-menu--up")).toBeNull();
    expect(container.querySelector(".pw-perm-menu")).not.toBeNull();
  });

  it("底部空间不足(历史会话页贴底)菜单自动翻上", () => {
    // jsdom innerHeight 默认 768;让菜单底缘超出视口 → 应翻上。
    const rect = {
      right: 100, left: 0, top: 700, bottom: 2000, width: 260, height: 1300, x: 0, y: 700,
      toJSON: () => ({}),
    } as DOMRect;
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);
    try {
      const { container } = renderPill();
      fireEvent.click(screen.getByLabelText("执行权限"));
      expect(container.querySelector(".pw-perm-menu.pw-tb-menu--up")).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
