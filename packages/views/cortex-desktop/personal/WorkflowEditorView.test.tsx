import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDef, WorkflowRun } from "@cortex-work/core";

const h = vi.hoisted(() => ({
  runs: [] as WorkflowRun[],
  workflows: [] as WorkflowDef[],
  updateWorkflow: vi.fn().mockResolvedValue(null),
  runNow: vi.fn().mockResolvedValue(null),
  stopRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@cortex-work/core", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useWorkflowRuns: () => ({ data: h.runs }),
    useWorkflows: () => ({ data: h.workflows }),
    useUpdateWorkflow: () => ({ mutateAsync: h.updateWorkflow }),
    useRunWorkflowNow: () => ({ mutateAsync: h.runNow }),
    useStopWorkflowRun: () => ({ mutateAsync: h.stopRun }),
  };
});

vi.mock("./WorkflowCanvas", () => ({
  WorkflowCanvas: ({ runStatus }: { runStatus: Record<string, unknown> }) => (
    <div data-testid="workflow-canvas">
      <output data-testid="run-status">{JSON.stringify(runStatus)}</output>
    </div>
  ),
}));

vi.mock("./node-config/NodeConfigPanel", () => ({
  NodeConfigPanel: () => <div data-testid="node-config" />,
}));

vi.mock("./WorkflowRunLogPanel", () => ({
  WorkflowRunLogPanel: () => <div data-testid="run-log" />,
}));

const { WorkflowEditorView } = await import("./WorkflowEditorView");

function makeWorkflow(): WorkflowDef {
  return {
    id: "wf-1",
    name: "测试工作流",
    enabled: true,
    callableByAgent: false,
    env: [],
    nodes: [
      {
        id: "n1",
        type: "manual-trigger",
        name: "手动触发",
        position: { x: 0, y: 0 },
        disabled: false,
        config: {},
      },
      {
        id: "n2",
        type: "delay",
        name: "延迟",
        position: { x: 220, y: 0 },
        disabled: false,
        config: { delayMs: 1000 },
      },
    ],
    connections: [],
    createdAt: "",
    updatedAt: "",
    lastRunAt: "",
    nextRunAt: "",
    lastStatus: "idle",
    lastMessage: "",
    runs: [],
  };
}

function run(partial: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: partial.id ?? "run-1",
    trigger: "manual",
    status: partial.status ?? "running",
    startedAt: partial.startedAt ?? "2026-06-25T00:00:00.000Z",
    finishedAt: partial.finishedAt ?? "",
    message: partial.message ?? "",
    nodeResults: partial.nodeResults ?? [],
  };
}

function renderEditor() {
  return render(
    <WorkflowEditorView
      workflow={makeWorkflow()}
      onBack={vi.fn()}
      onToast={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.runs = [];
  h.workflows = [];
});

describe("WorkflowEditorView — 运行状态反馈", () => {
  it("初始进入即使历史最新 run 是 running，也先显示运行一次", () => {
    h.runs = [run({ id: "old-run", status: "running", nodeResults: [] })];

    renderEditor();

    expect(screen.getByRole("button", { name: /运行一次/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /停止/ })).toBeNull();
  });

  it("点击运行一次后显示停止，该 run 完成后恢复运行一次", async () => {
    const startedRun = run({ id: "new-run", status: "running", nodeResults: [] });
    h.runNow.mockResolvedValueOnce(startedRun);

    const { rerender } = renderEditor();

    fireEvent.click(screen.getByRole("button", { name: /运行一次/ }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /停止/ })).toBeTruthy();
    });

    h.runs = [run({ id: "new-run", status: "success", finishedAt: "2026-06-25T00:00:02.000Z" })];
    rerender(
      <WorkflowEditorView
        workflow={makeWorkflow()}
        onBack={vi.fn()}
        onToast={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /运行一次/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /停止/ })).toBeNull();
  });

  it("画布节点状态点使用最新 run 的节点结果，包括完成后的成功和失败", () => {
    h.runs = [
      run({
        id: "new-run",
        status: "error",
        nodeResults: [
          {
            nodeId: "n1",
            status: "success",
            startedAt: "2026-06-25T00:00:00.000Z",
            finishedAt: "2026-06-25T00:00:01.000Z",
            message: "",
            outputJson: "{}",
            threadId: "",
            error: "",
          },
          {
            nodeId: "n2",
            status: "error",
            startedAt: "2026-06-25T00:00:01.000Z",
            finishedAt: "2026-06-25T00:00:02.000Z",
            message: "",
            outputJson: "",
            threadId: "",
            error: "failed",
          },
        ],
      }),
    ];

    renderEditor();

    expect(screen.getByTestId("run-status").textContent).toBe(
      JSON.stringify({ n1: "success", n2: "error" }),
    );
  });
});
