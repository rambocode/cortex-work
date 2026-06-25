// WorkflowList 组件单测：
// - 列表渲染（失败 pill、最近结果、节点数）
// - 两个 toggle 调对应 mutation
// - 删除走行内菜单二次确认
// - bridge 无 workflowList → 入口不渲染（由 PersonalSidebar 门控，不在此测）

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { WorkflowDef, WorkflowRunStatus, DesktopBridge } from "@cortex-work/core";

// ── 受控 mock ────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  workflows: [] as WorkflowDef[],
  setEnabledMutate: vi.fn(),
  setCallableMutate: vi.fn(),
  deleteMutate: vi.fn(),
  runNowMutate: vi.fn(),
  createMutate: vi.fn(),
}));

vi.mock("@cortex-work/core", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useWorkflows: () => ({ data: h.workflows }),
    useSetWorkflowEnabled: () => ({ mutate: h.setEnabledMutate }),
    useSetWorkflowCallableByAgent: () => ({ mutate: h.setCallableMutate }),
    useDeleteWorkflow: () => ({ mutate: h.deleteMutate }),
    useRunWorkflowNow: () => ({ mutate: h.runNowMutate, isPending: false }),
    useCreateWorkflow: () => ({ mutate: h.createMutate }),
  };
});

const { WorkflowList } = await import("./WorkflowList");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.workflows = [];
});

// ── 测试辅助 ─────────────────────────────────────────────────────────────────

function makeBridge(): Partial<DesktopBridge> {
  return {
    workflowList: vi.fn().mockResolvedValue([]),
    workflowCreate: vi.fn(),
    workflowUpdate: vi.fn(),
    workflowDelete: vi.fn(),
    workflowSetEnabled: vi.fn(),
    workflowSetCallableByAgent: vi.fn(),
    workflowRunNow: vi.fn(),
    onWorkflowChanged: vi.fn(() => () => {}),
    onWorkflowRunEvent: vi.fn(() => () => {}),
  };
}

function wf(over: Partial<WorkflowDef> = {}): WorkflowDef {
  return {
    id: "wf-1",
    name: "测试 loop",
    enabled: true,
    callableByAgent: false,
    env: [],
    nodes: [{ id: "n1", type: "manual-trigger", name: "开始", position: { x: 0, y: 0 }, disabled: false, config: {} } as WorkflowDef["nodes"][number]],
    connections: [],
    createdAt: new Date(2026, 5, 24).toISOString(),
    updatedAt: new Date(2026, 5, 24).toISOString(),
    lastRunAt: new Date(2026, 5, 24, 9).toISOString(),
    nextRunAt: "",
    lastStatus: "idle" as WorkflowRunStatus,
    lastMessage: "",
    runs: [],
    ...over,
  };
}

function renderList(props: Partial<Parameters<typeof WorkflowList>[0]> = {}, bridge = makeBridge()) {
  const onEdit = vi.fn();
  const onCreate = vi.fn();
  const onExport = vi.fn();
  const onToast = vi.fn();
  render(
    <CoreProvider
      wsId="ws-test"
      identity={{ userId: "u1", name: "Test" }}
      desktopBridge={bridge as DesktopBridge}
    >
      <WorkflowList
        onEdit={props.onEdit ?? onEdit}
        onCreate={props.onCreate ?? onCreate}
        onExport={props.onExport ?? onExport}
        onToast={props.onToast ?? onToast}
      />
    </CoreProvider>,
  );
  return { onEdit, onCreate, onExport, onToast };
}

// ── 空态 ─────────────────────────────────────────────────────────────────────

describe("空态", () => {
  it("无工作流时展示引导文案", () => {
    h.workflows = [];
    renderList();
    expect(screen.getByText(/还没有 loop 工作流/)).toBeTruthy();
    expect(screen.getByText(/新建第一个 loop/i)).toBeTruthy();
  });

  it("点击空态「新建 loop」按钮调 onCreate", () => {
    h.workflows = [];
    const onCreate = vi.fn();
    renderList({ onCreate });
    // 点击第一个含「新建 loop」文本的按钮（空态有多个入口，均应触发 onCreate）
    const btns = screen.getAllByRole("button", { name: /新建 loop/i });
    expect(btns.length).toBeGreaterThan(0);
    fireEvent.click(btns[btns.length - 1]!);
    expect(onCreate).toHaveBeenCalled();
  });
});

// ── 列表渲染 ─────────────────────────────────────────────────────────────────

describe("列表渲染", () => {
  it("显示工作流名称", () => {
    h.workflows = [wf({ name: "我的工作流" })];
    renderList();
    expect(screen.getByText("我的工作流")).toBeTruthy();
  });

  it("显示节点数摘要", () => {
    h.workflows = [wf()];
    renderList();
    expect(screen.getByText("1 个节点")).toBeTruthy();
  });

  it("失败状态显示失败 pill", () => {
    h.workflows = [wf({ lastStatus: "error" })];
    renderList();
    // 「失败」标签应出现
    expect(screen.getByText("失败")).toBeTruthy();
  });

  it("success 状态显示成功 pill", () => {
    h.workflows = [wf({ lastStatus: "success" })];
    renderList();
    expect(screen.getByText("成功")).toBeTruthy();
  });

  it("已暂停（enabled=false）显示已暂停 pill", () => {
    h.workflows = [wf({ enabled: false })];
    renderList();
    expect(screen.getByText("已暂停")).toBeTruthy();
  });

  it("有 lastMessage 时显示结果摘要", () => {
    h.workflows = [wf({ lastMessage: "执行完成，共处理 10 条记录" })];
    renderList();
    expect(screen.getByText(/执行完成/)).toBeTruthy();
  });

  it("lastMessage 超 240 字符时截断", () => {
    const long = "A".repeat(300);
    h.workflows = [wf({ lastMessage: long })];
    renderList();
    const el = screen.getByText(/A+…/);
    expect(el.textContent?.length).toBeLessThanOrEqual(242); // 240 + "…" = 241, but textContent may trim
  });
});

// ── toggle 开关 ──────────────────────────────────────────────────────────────

describe("toggle 开关", () => {
  it("点击启用 toggle 调 setEnabled mutation", () => {
    h.workflows = [wf({ enabled: true })];
    renderList();
    // 「启用」toggle
    const btn = screen.getByRole("switch", { name: "启用" });
    fireEvent.click(btn);
    expect(h.setEnabledMutate).toHaveBeenCalledWith(
      { id: "wf-1", enabled: false },
      expect.any(Object),
    );
  });

  it("点击 AI 可调用 toggle 调 setCallableByAgent mutation", () => {
    h.workflows = [wf({ enabled: true, callableByAgent: false })];
    renderList();
    const btn = screen.getByRole("switch", { name: "AI 可调用" });
    fireEvent.click(btn);
    expect(h.setCallableMutate).toHaveBeenCalledWith(
      { id: "wf-1", callableByAgent: true },
      expect.any(Object),
    );
  });

  it("未启用时 AI 可调用 toggle 被禁用", () => {
    h.workflows = [wf({ enabled: false, callableByAgent: false })];
    renderList();
    const btn = screen.getByRole("switch", { name: "AI 可调用" });
    expect(btn).toBeDisabled();
  });
});

// ── 删除二次确认 ─────────────────────────────────────────────────────────────

describe("删除二次确认", () => {
  it("初次点击「删除」显示二次确认，再次点击真正删除", () => {
    h.workflows = [wf()];
    renderList();

    // 打开更多操作菜单
    const moreBtn = screen.getByTitle("更多操作");
    fireEvent.click(moreBtn);

    // 初次点「删除」→ 变为「确认删除？」
    const delBtn = screen.getByRole("menuitem", { name: /删除/ });
    fireEvent.click(delBtn);
    expect(h.deleteMutate).not.toHaveBeenCalled();

    // 再次点「确认删除？」→ 真正删除
    const confirmBtn = screen.getByRole("menuitem", { name: /确认删除/ });
    fireEvent.click(confirmBtn);
    expect(h.deleteMutate).toHaveBeenCalledWith("wf-1", expect.any(Object));
  });
});

// ── 点击行体进入编辑器 ───────────────────────────────────────────────────────

describe("点击行体进入编辑器", () => {
  it("点击工作流行调 onEdit", () => {
    h.workflows = [wf({ name: "点我进编辑器" })];
    const onEdit = vi.fn();
    renderList({ onEdit });
    const row = screen.getByRole("button", { name: /点我进编辑器/ });
    fireEvent.click(row);
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "wf-1" }));
  });
});
