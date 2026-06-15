import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { CoreProvider, useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { PersonalCenterHeader } from "./PersonalTopBar";

const bridge = {} as unknown as DesktopBridge;

function renderHeader() {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <PersonalCenterHeader />
    </CoreProvider>,
  );
}

describe("PersonalCenterHeader 面板下拉(光标移出自动收起)", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    useCortexUIStore.setState({ rightOpen: false });
    usePersonalStore.setState({ terminalOpen: false, rightView: "files" });
  });

  it("点击展开,光标移出菜单区域后短延迟自动收起", async () => {
    renderHeader();
    const btn = screen.getByTitle("右侧面板");
    const wrap = btn.closest(".pw-tb-menu-wrap") as HTMLElement;

    fireEvent.click(btn);
    expect(screen.getByText("展开右侧面板")).toBeInTheDocument();

    fireEvent.mouseLeave(wrap);
    await waitFor(() => expect(screen.queryByText("展开右侧面板")).toBeNull());
  });

  it("移出后立即移入 → 取消收起,菜单保持打开", async () => {
    renderHeader();
    const btn = screen.getByTitle("右侧面板");
    const wrap = btn.closest(".pw-tb-menu-wrap") as HTMLElement;

    fireEvent.click(btn);
    fireEvent.mouseLeave(wrap);
    fireEvent.mouseEnter(wrap);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByText("展开右侧面板")).toBeInTheDocument();
  });
});
