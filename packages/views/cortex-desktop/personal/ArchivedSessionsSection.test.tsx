import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CoreProvider, useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, ProjectMeta, SessionMeta } from "@cortex-work/core";

import { ArchivedSessionsSection } from "./ArchivedSessionsSection";

function sess(p: Partial<SessionMeta> & { id: string }): SessionMeta {
  return { title: p.id, agent: "claude", createdAt: 0, updatedAt: 1000, ...p };
}

const PROJECTS: ProjectMeta[] = [
  { id: "p1", name: "Software-publications", path: "/p1", addedAt: 0 },
  { id: "p2", name: "天气项目", path: "/p2", addedAt: 0 },
];

function seed(sessions: SessionMeta[]) {
  usePersonalStore.setState({
    projects: PROJECTS,
    sessions,
    activeSessionId: undefined,
    settingsOpen: true,
  });
  useCortexUIStore.setState({ toasts: [] });
}

const fakeBridge = (deleteChat?: (id: string) => Promise<void>) =>
  ({ deleteChat: deleteChat ?? (() => Promise.resolve()) }) as unknown as DesktopBridge;

function renderUI(ui: ReactElement, bridge: DesktopBridge | null = fakeBridge()) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      {ui}
    </CoreProvider>,
  );
}

const ARCHIVED = [
  sess({ id: "a", title: "创建一个软件著作管理系统", projectId: "p1", model: "deepseek-v4-pro", archivedAt: 300 }),
  sess({ id: "b", title: "天气助手", projectId: "p2", archivedAt: 200 }),
  sess({ id: "c", title: "随手记", archivedAt: 100 }), // 无项目
  sess({ id: "live", title: "进行中的会话", projectId: "p1" }), // 未归档,不应出现
];

describe("ArchivedSessionsSection", () => {
  beforeEach(() => seed(ARCHIVED));

  it("按项目分组渲染组头(文件夹名 + 组内计数),未归档不出现 (R2/R5)", () => {
    renderUI(<ArchivedSessionsSection />);
    expect(screen.getByText("Software-publications")).toBeInTheDocument();
    expect(screen.getByText("天气项目")).toBeInTheDocument();
    expect(screen.getByText("无项目")).toBeInTheDocument();
    expect(screen.getByText("创建一个软件著作管理系统")).toBeInTheDocument();
    expect(screen.queryByText("进行中的会话")).not.toBeInTheDocument();
  });

  it("orphan projectId(项目已删)→ 组头回退「已删除项目」 (R5)", () => {
    seed([sess({ id: "x", title: "孤儿会话", projectId: "ghost", archivedAt: 100 })]);
    renderUI(<ArchivedSessionsSection />);
    expect(screen.getByText("已删除项目")).toBeInTheDocument();
  });

  it("计数 chip 显示 archivedTotal;搜索过滤后 chip 不变 (R4)", () => {
    renderUI(<ArchivedSessionsSection />);
    expect(screen.getByText("3 个已归档")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("搜索已归档对话"), { target: { value: "软件" } });
    expect(screen.getByText("3 个已归档")).toBeInTheDocument(); // 仍为过滤前总数
    expect(screen.queryByText("天气助手")).not.toBeInTheDocument();
    expect(screen.getByText("创建一个软件著作管理系统")).toBeInTheDocument();
  });

  it("会话条目显示模型名 (R6)", () => {
    renderUI(<ArchivedSessionsSection />);
    expect(screen.getByText(/deepseek-v4-pro/)).toBeInTheDocument();
  });

  it("点击「取消归档」→ unarchiveSession(清 archivedAt),不动 activeSession (R7)", () => {
    renderUI(<ArchivedSessionsSection />);
    const row = screen.getByText("创建一个软件著作管理系统").closest(".pw-arch-row")!;
    fireEvent.click(within(row).getByText("取消归档"));
    const s = usePersonalStore.getState().sessions.find((x) => x.id === "a")!;
    expect(s.archivedAt).toBeUndefined();
    expect(usePersonalStore.getState().activeSessionId).toBeUndefined();
  });

  it("点击标题 → setActiveSession(关设置页跳转),归档态不变 (R9)", () => {
    renderUI(<ArchivedSessionsSection />);
    fireEvent.click(screen.getByText("创建一个软件著作管理系统"));
    expect(usePersonalStore.getState().activeSessionId).toBe("a");
    expect(usePersonalStore.getState().settingsOpen).toBe(false);
    // 打开不改归档态
    expect(usePersonalStore.getState().sessions.find((x) => x.id === "a")!.archivedAt).toBe(300);
  });

  it("删除:首点仅确认,再点 removeSession + bridge.deleteChat (R8)", () => {
    const deleteChat = vi.fn(() => Promise.resolve());
    renderUI(<ArchivedSessionsSection />, fakeBridge(deleteChat));
    const row = screen.getByText("创建一个软件著作管理系统").closest(".pw-arch-row")!;
    const delBtn = within(row).getByTitle("删除");
    fireEvent.click(delBtn);
    expect(usePersonalStore.getState().sessions.some((x) => x.id === "a")).toBe(true); // 仅确认态
    fireEvent.click(within(row).getByTitle("再点确认删除"));
    expect(usePersonalStore.getState().sessions.some((x) => x.id === "a")).toBe(false);
    expect(deleteChat).toHaveBeenCalledWith("a");
  });

  it("无归档会话 → 整体空态,不渲染分组 (R10)", () => {
    seed([sess({ id: "live", title: "进行中", projectId: "p1" })]);
    renderUI(<ArchivedSessionsSection />);
    expect(screen.getByText("暂无已归档对话")).toBeInTheDocument();
    expect(screen.queryByText("Software-publications")).not.toBeInTheDocument();
  });

  it("搜索无命中 → 搜索空态(区别于整体空态)", () => {
    renderUI(<ArchivedSessionsSection />);
    fireEvent.change(screen.getByPlaceholderText("搜索已归档对话"), { target: { value: "绝不匹配xyz" } });
    expect(screen.getByText("未找到匹配的对话")).toBeInTheDocument();
    expect(screen.queryByText("暂无已归档对话")).not.toBeInTheDocument();
  });
});
