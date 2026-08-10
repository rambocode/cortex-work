// 会话搜索弹窗：关闭态不渲染、默认最近 10 条（降序/不含归档）、输入过滤、点击进入会话并关闭。

import { cleanup, render, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { CoreProvider, useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, SessionMeta } from "@cortex-work/core";
import { SessionSearchDialog } from "./SessionSearchDialog";

const bridge = {} as unknown as DesktopBridge;

function sess(id: string, title: string, updatedAt: number, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { id, projectId: "p1", title, agent: "claude", createdAt: 0, updatedAt, ...extra };
}

function renderDialog(sessions: SessionMeta[]) {
  useCortexUIStore.setState({ sessionSearchOpen: true });
  usePersonalStore.setState({
    projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: 0 }],
    sessions,
    activeSessionId: undefined,
  });
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <SessionSearchDialog />
    </CoreProvider>,
  );
}

describe("SessionSearchDialog", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    useCortexUIStore.setState({ sessionSearchOpen: false });
    usePersonalStore.setState({ activeSessionId: undefined });
  });

  it("关闭态不渲染", () => {
    useCortexUIStore.setState({ sessionSearchOpen: false });
    usePersonalStore.setState({ projects: [], sessions: [] });
    const { container } = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <SessionSearchDialog />
      </CoreProvider>,
    );
    expect(container.querySelector(".pw-search-dlg")).toBeNull();
  });

  it("默认显示最近 10 条（降序、不含归档）", () => {
    const list = Array.from({ length: 12 }, (_, i) => sess(`s${i}`, `会话 ${i}`, i * 1000));
    list.push(sess("arch", "已归档会话", 999999, { archivedAt: 1 }));
    const { container } = renderDialog(list);
    const rows = container.querySelectorAll(".pw-search-row");
    expect(rows.length).toBe(10);
    // 降序：第一行是最新的「会话 11」，最旧的「会话 0」「会话 1」被截掉。
    expect((rows[0] as HTMLElement).textContent).toContain("会话 11");
    expect(container.textContent).not.toContain("会话 0");
    expect(container.textContent).not.toContain("已归档会话");
  });

  it("输入按标题过滤", () => {
    const { container } = renderDialog([
      sess("a", "修复登录 bug", 3000),
      sess("b", "重构样式", 2000),
      sess("c", "登录页优化", 1000),
    ]);
    fireEvent.change(container.querySelector(".pw-search-input input") as HTMLInputElement, {
      target: { value: "登录" },
    });
    const rows = container.querySelectorAll(".pw-search-row");
    expect(rows.length).toBe(2);
    expect(container.textContent).toContain("修复登录 bug");
    expect(container.textContent).toContain("登录页优化");
    expect(container.textContent).not.toContain("重构样式");
  });

  it("side 子会话不进入默认列表或搜索结果", () => {
    const { container } = renderDialog([
      sess("parent", "父会话", 1000),
      sess("child", "Reviewer 子会话", 2000, { relation: "side", parentSessionId: "parent" }),
    ]);
    expect(container.textContent).toContain("父会话");
    expect(container.textContent).not.toContain("Reviewer 子会话");
    fireEvent.change(container.querySelector(".pw-search-input input") as HTMLInputElement, {
      target: { value: "Reviewer" },
    });
    expect(container.querySelectorAll(".pw-search-row")).toHaveLength(0);
  });

  it("点击结果切到该会话并关闭弹窗", () => {
    const { container } = renderDialog([sess("a", "会话甲", 2000), sess("b", "会话乙", 1000)]);
    const rows = container.querySelectorAll(".pw-search-row");
    fireEvent.click(within(rows[1] as HTMLElement).getByText("会话乙"));
    expect(usePersonalStore.getState().activeSessionId).toBe("b");
    expect(useCortexUIStore.getState().sessionSearchOpen).toBe(false);
  });

  it("Enter 进入当前高亮（默认首条）会话", () => {
    const { container } = renderDialog([sess("a", "会话甲", 2000), sess("b", "会话乙", 1000)]);
    const dlg = container.querySelector(".pw-search-dlg") as HTMLElement;
    fireEvent.keyDown(dlg, { key: "Enter" });
    expect(usePersonalStore.getState().activeSessionId).toBe("a");
    expect(useCortexUIStore.getState().sessionSearchOpen).toBe(false);
  });
});
