// NodeConfigPanel.test.tsx — NodeConfigPanel 与 WorkflowRunLogPanel 单测。
//
// 覆盖：
//   1. node=null → 渲染「选择一个节点进行编辑」提示。
//   2. 切换节点 kind → 渲染对应 form 标识字段。
//   3. 编辑字段 → onNodeChange 被调用，config 更新。
//   4. WorkflowRunLogPanel：mock useWorkflowRuns，验证节点状态/错误展示。
//
// 注意：
//   - AiNodeForm 使用 usePersonalStore，需 mock。
//   - ScheduleEditor 使用 useDesktopBridge，需 mock。
//   - VariablePicker 使用 navigator.clipboard，需 mock。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowNode, WorkflowRun, DesktopBridge } from "@cortex-work/core";
import { CoreProvider } from "@cortex-work/core";
import type { WorkflowDef } from "@cortex-work/core";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  runs: [] as WorkflowRun[],
  workflows: [] as WorkflowDef[],
  providerSettings: { providers: [] as unknown[] },
  agentsAvailable: {} as Record<string, boolean>,
  onNodeChange: vi.fn(),
}));

vi.mock("@cortex-work/core", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useWorkflowRuns: () => ({ data: h.runs }),
    useWorkflows: () => ({ data: h.workflows }),
    usePersonalStore: (sel: (s: { providerSettings: typeof h.providerSettings; agentsAvailable: typeof h.agentsAvailable }) => unknown) =>
      sel({ providerSettings: h.providerSettings, agentsAvailable: h.agentsAvailable }),
  };
});

// ScheduleEditor 用到 useDesktopBridge（bridge.automationValidateCron）
// 直接 mock ScheduleEditor 为极简替代，避免 bridge 依赖
vi.mock("../../automation/ScheduleEditor", () => ({
  ScheduleEditor: ({ onChange }: { onChange: (spec: unknown) => void }) => (
    <button
      type="button"
      data-testid="schedule-editor"
      onClick={() => onChange({ kind: "daily", hour: 9, minute: 0 })}
    >
      ScheduleEditor
    </button>
  ),
}));

// clipboard mock
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

// 动态导入（在 mock 注册后）
const { NodeConfigPanel } = await import("./NodeConfigPanel");
const { WorkflowRunLogPanel } = await import("../WorkflowRunLogPanel");

// ── 测试辅助 ─────────────────────────────────────────────────────────────────

function makeBridge(): Partial<DesktopBridge> {
  return {
    workflowList: vi.fn().mockResolvedValue([]),
    workflowListRuns: vi.fn().mockResolvedValue([]),
    onWorkflowChanged: vi.fn(() => () => {}),
    onWorkflowRunEvent: vi.fn(() => () => {}),
  };
}

function wrap(ui: React.ReactNode) {
  return render(
    <CoreProvider
      wsId="test-ws"
      identity={{ userId: "u1", name: "Test" }}
      desktopBridge={makeBridge() as DesktopBridge}
    >
      {ui}
    </CoreProvider>,
  );
}

function makeNode<T extends WorkflowNode["type"]>(
  type: T,
  config: Extract<WorkflowNode, { type: T }>["config"],
): Extract<WorkflowNode, { type: T }> {
  return {
    id: `node-${type}`,
    type,
    name: "",
    position: { x: 0, y: 0 },
    disabled: false,
    config,
  } as Extract<WorkflowNode, { type: T }>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.runs = [];
  h.workflows = [];
  h.onNodeChange.mockReset();
});

// ── 1. node=null ──────────────────────────────────────────────────────────────

describe("NodeConfigPanel — null node", () => {
  it("渲染「选择一个节点进行编辑」提示", () => {
    wrap(
      <NodeConfigPanel
        node={null}
        allNodes={[]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    expect(screen.getByText(/选择一个节点进行编辑/)).toBeTruthy();
  });
});

// ── 2. kind → form 分发 ───────────────────────────────────────────────────────

describe("NodeConfigPanel — kind dispatch", () => {
  it("manual-trigger 显示 ScheduleEditor-not，而是「启动输入字段」", () => {
    const node = makeNode("manual-trigger", {
      inputSchema: [],
      workspaceRoot: undefined,
    });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    // 手动触发表单有「启动输入字段」标题
    expect(screen.getByText(/启动输入字段/)).toBeTruthy();
  });

  it("schedule-trigger 渲染 ScheduleEditor mock", () => {
    const node = makeNode("schedule-trigger", {
      schedule: { kind: "daily", hour: 8, minute: 0 },
    });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    expect(screen.getByTestId("schedule-editor")).toBeTruthy();
  });

  it("webhook-trigger 渲染触发 URL 预览", () => {
    const node = makeNode("webhook-trigger", {
      path: "/my-hook",
      method: "POST",
    });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        workflowId="wf-1"
        onNodeChange={h.onNodeChange}
      />,
    );
    expect(screen.getByText(/触发 URL/)).toBeTruthy();
    // 路径出现在 URL 预览中
    expect(screen.getByText(/my-hook/)).toBeTruthy();
  });

  it("condition 渲染条件表达式区域", () => {
    const node = makeNode("condition", {
      leftExpr: "{{$input.text}}",
      operator: "equals",
      rightValue: "hello",
      caseSensitive: false,
    });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    // 渲染了运算符 select
    expect(screen.getByDisplayValue("等于")).toBeTruthy();
  });

  it("delay 渲染延迟时长输入", () => {
    const node = makeNode("delay", { delayMs: 2000 });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    expect(screen.getByText(/延迟时长/)).toBeTruthy();
  });

  it("http-request 渲染方法 select 和 URL 输入", () => {
    const node = makeNode("http-request", {
      method: "GET",
      url: "https://api.example.com",
      headers: [],
      body: "",
      timeoutMs: 30000,
      parseJson: true,
    });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    expect(screen.getByDisplayValue("GET")).toBeTruthy();
    expect(screen.getByDisplayValue("https://api.example.com")).toBeTruthy();
  });

  it("code 渲染语言选择和代码区", () => {
    const node = makeNode("code", { language: "javascript", code: "return {}" });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    expect(screen.getByDisplayValue("JavaScript")).toBeTruthy();
    expect(screen.getByDisplayValue("return {}")).toBeTruthy();
  });

  it("human-approval 渲染审批标题输入", () => {
    const node = makeNode("human-approval", {
      title: "请审批",
      instruction: "检查以下内容",
      timeoutMs: 300000,
      onTimeout: "rejected",
    });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    expect(screen.getByDisplayValue("请审批")).toBeTruthy();
  });

  it("template 渲染模板内容 textarea", () => {
    const node = makeNode("template", {
      template: "Hello {{$input.name}}",
      outputMode: "text",
    });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    expect(screen.getByDisplayValue("Hello {{$input.name}}")).toBeTruthy();
  });

  it("loop foreach 的数组来源提示使用运行时可解析的裸表达式", () => {
    const node = makeNode("loop", {
      workflowId: "body",
      mode: "foreach",
      arraySource: undefined,
      execution: "sequential",
      concurrency: 1,
      continueOnError: false,
      maxIterations: 10,
      leftExpr: "",
      operator: "equals",
      rightValue: "",
      caseSensitive: true,
    });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    expect(screen.getByPlaceholderText("json.items（留空 = payload.json）")).toBeTruthy();
    expect(screen.queryByPlaceholderText("{{$input.items}}（留空 = payload.json）")).toBeNull();
  });

  it("VariablePicker 只展示 runtime 已实现的 loop 变量", () => {
    const node = makeNode("template", {
      template: "",
      outputMode: "text",
    });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /插入变量/ }));

    expect(screen.getByText("{{$loop.total}}")).toBeTruthy();
    expect(screen.queryByText("{{$loop.iteration}}")).toBeNull();
  });
});

// ── 3. 编辑字段 → onNodeChange ──────────────────────────────────────────────

describe("NodeConfigPanel — 编辑字段触发 onNodeChange", () => {
  it("修改节点名称 → onNodeChange 被调用，name 更新", () => {
    const node = makeNode("delay", { delayMs: 1000 });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    const nameInput = screen.getByPlaceholderText("延迟");
    fireEvent.change(nameInput, { target: { value: "我的延迟节点" } });
    expect(h.onNodeChange).toHaveBeenCalledTimes(1);
    const updated = h.onNodeChange.mock.calls[0]![0] as WorkflowNode;
    expect(updated.name).toBe("我的延迟节点");
  });

  it("修改 delay config → delayMs 更新", () => {
    const node = makeNode("delay", { delayMs: 1000 });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    // 延迟时长 number input（有两个 number input：名称区和时长区，但名称区是 text）
    const numInput = screen.getByDisplayValue("1000");
    fireEvent.change(numInput, { target: { value: "5000" } });
    expect(h.onNodeChange).toHaveBeenCalled();
    const updated = h.onNodeChange.mock.calls[0]![0] as WorkflowNode & { type: "delay" };
    expect(updated.config.delayMs).toBe(5000);
  });

  it("condition: 修改 leftExpr → config 更新", () => {
    const node = makeNode("condition", {
      leftExpr: "{{$input.text}}",
      operator: "equals",
      rightValue: "",
      caseSensitive: false,
    });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    const leftInput = screen.getByDisplayValue("{{$input.text}}");
    fireEvent.change(leftInput, { target: { value: "{{$input.score}}" } });
    expect(h.onNodeChange).toHaveBeenCalled();
    const updated = h.onNodeChange.mock.calls[0]![0] as WorkflowNode & { type: "condition" };
    expect(updated.config.leftExpr).toBe("{{$input.score}}");
  });

  it("http-request: 修改 URL → config 更新", () => {
    const node = makeNode("http-request", {
      method: "POST",
      url: "https://old.com",
      headers: [],
      body: "",
      timeoutMs: 30000,
      parseJson: false,
    });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    const urlInput = screen.getByDisplayValue("https://old.com");
    fireEvent.change(urlInput, { target: { value: "https://new.com/api" } });
    expect(h.onNodeChange).toHaveBeenCalled();
    const updated = h.onNodeChange.mock.calls[0]![0] as WorkflowNode & { type: "http-request" };
    expect(updated.config.url).toBe("https://new.com/api");
  });

  it("高级设置：切换 disabled → node.disabled 更新", () => {
    const node = makeNode("delay", { delayMs: 1000 });
    wrap(
      <NodeConfigPanel
        node={node}
        allNodes={[node]}
        envVars={[]}
        onNodeChange={h.onNodeChange}
      />,
    );
    // 展开高级设置
    fireEvent.click(screen.getByText("高级设置"));
    const disabledCheck = screen.getByLabelText(/禁用此节点/);
    fireEvent.click(disabledCheck);
    expect(h.onNodeChange).toHaveBeenCalled();
    const updated = h.onNodeChange.mock.calls[0]![0] as WorkflowNode;
    expect(updated.disabled).toBe(true);
  });
});

// ── 4. WorkflowRunLogPanel ────────────────────────────────────────────────────

describe("WorkflowRunLogPanel", () => {
  function makeRun(overRun: Partial<WorkflowRun> = {}): WorkflowRun {
    return {
      id: "run-1",
      trigger: "manual",
      status: "success",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      message: "",
      nodeResults: [],
      ...overRun,
    };
  }

  it("无 runs 时显示「暂无运行记录」", () => {
    h.runs = [];
    wrap(<WorkflowRunLogPanel workflowId="wf-1" allNodes={[]} />);
    expect(screen.getByText(/暂无运行记录/)).toBeTruthy();
  });

  it("有 runs → 渲染运行状态 badge", () => {
    h.runs = [makeRun({ status: "success" })];
    wrap(<WorkflowRunLogPanel workflowId="wf-1" allNodes={[]} />);
    expect(screen.getByText("成功")).toBeTruthy();
  });

  it("失败 run 显示失败 badge", () => {
    h.runs = [makeRun({ status: "error", message: "节点出错" })];
    wrap(<WorkflowRunLogPanel workflowId="wf-1" allNodes={[]} />);
    expect(screen.getByText("失败")).toBeTruthy();
  });

  it("run 展开后显示节点错误信息", async () => {
    const nodeId = "node-abc";
    const allNodes: WorkflowNode[] = [
      makeNode("delay", { delayMs: 1000 }) as WorkflowNode & { id: typeof nodeId },
    ];
    // 手动设 id
    (allNodes[0] as WorkflowNode).id = nodeId;
    (allNodes[0] as WorkflowNode).name = "延迟节点";

    h.runs = [
      makeRun({
        status: "error",
        nodeResults: [
          {
            nodeId,
            status: "error",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            message: "",
            outputJson: "{}",
            threadId: "",
            error: "超时了",
            retries: 1,
          },
        ],
      }),
    ];

    wrap(<WorkflowRunLogPanel workflowId="wf-1" allNodes={allNodes} />);
    // 最新 run 默认展开（idx=0），节点 RunLogRow 默认展开（error 状态）
    expect(screen.getByText("延迟节点")).toBeTruthy();
    expect(screen.getByText("超时了")).toBeTruthy();
  });
});
