// Trajectory 视图交互测试:台账行选中 → 详情检查器页签、请求边界圆点 → 请求检查器、
// 搜索过滤台账与时间线淡出、双击 assistant 折叠工具组、工具栏全折叠。
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent, RunPromptRecord } from "@cortex-work/core";
import { TrajectoryView } from "./TrajectoryView";

const T0 = 1_700_000_000_000;

function ev(runId: string, at: number, e: RunEvent["ev"]): RunEvent {
  return { runId, ts: T0 + at, ev: e };
}

const EVENTS: RunEvent[] = [
  ev("r1", 100, { type: "thinking", delta: "先想想" }),
  ev("r1", 200, { type: "text", delta: "我来跑个命令" }),
  ev("r1", 300, { type: "tool", name: "Bash", detail: "ls -la", input: { command: "ls -la" }, phase: "start", toolCallId: "c1" }),
  ev("r1", 900, { type: "tool", name: "Bash", phase: "end", toolCallId: "c1", output: "a.txt\nb.txt" }),
  ev("r1", 1_000, { type: "usage", inputTokens: 120, outputTokens: 40 }),
  ev("r1", 1_100, { type: "result", ok: true }),
];
const PROMPTS: RunPromptRecord[] = [{ runId: "r1", ts: T0, text: "列一下文件" }];

function renderView() {
  return render(
    <TrajectoryView events={EVENTS} prompts={PROMPTS} running={false} fallbackToolName="工具" />,
  );
}

describe("TrajectoryView", () => {
  afterEach(() => cleanup());

  it("台账渲染轮标签/类型徽章/工具行内联结果;点行打开详情检查器并可切页签", () => {
    const view = renderView();
    expect(view.getByText("Turn 1")).toBeInTheDocument();
    expect(view.getByText("USER")).toBeInTheDocument();
    // 工具行:名称 + 参数 + → 结果预览
    const toolRow = view.getByRole("row", { name: /TOOL, Bash/ });
    expect(toolRow).toHaveTextContent("ls -la");
    expect(toolRow).toHaveTextContent("a.txt b.txt");
    // 点工具行 → 详情检查器(Summary 态,Payload/Result/Timing 页签)
    fireEvent.click(toolRow);
    const details = view.getByRole("complementary", { name: "Event details" });
    expect(within(details).getByText("TOOL")).toBeInTheDocument();
    expect(within(details).getByRole("tab", { name: "Payload" })).toBeInTheDocument();
    fireEvent.click(within(details).getByRole("tab", { name: "Result" }));
    expect(within(details).getByText(/a\.txt/)).toBeInTheDocument();
    // 层级跳转:tool → Assistant Message
    fireEvent.click(within(details).getByRole("tab", { name: "Summary" }));
    fireEvent.click(within(details).getByRole("button", { name: /Assistant Message/ }));
    expect(within(view.getByRole("complementary", { name: "Event details" })).getByText("ASSISTANT")).toBeInTheDocument();
  });

  it("请求边界圆点打开请求检查器:Request #1 + Usage 页签展示 token", () => {
    const view = renderView();
    fireEvent.click(view.getByRole("button", { name: "Request #1" }));
    const details = view.getByRole("complementary", { name: "Event details" });
    expect(within(details).getByText("Request #1")).toBeInTheDocument();
    fireEvent.click(within(details).getByRole("tab", { name: "Usage" }));
    expect(within(details).getByText("Session cumulative")).toBeInTheDocument();
    expect(within(details).getAllByText("120 tok").length).toBeGreaterThan(0);
  });

  it("搜索过滤台账行;清空恢复", () => {
    const view = renderView();
    const input = view.getByRole("searchbox", { name: "Search trajectory" });
    fireEvent.change(input, { target: { value: "bash" } });
    expect(view.getAllByRole("row")).toHaveLength(1);
    fireEvent.change(input, { target: { value: "" } });
    expect(view.getAllByRole("row").length).toBeGreaterThan(2);
  });

  it("双击 assistant 行折叠其工具组为摘要行;工具栏 Turns 全折叠", () => {
    const view = renderView();
    // assistant 行预览优先回复正文(非思考),aria-label 形如 "Request 1, ASSISTANT, 我来跑个命令"
    const assistantRow = view.getByRole("row", { name: /ASSISTANT, 我来跑个命令/ });
    fireEvent.doubleClick(assistantRow);
    expect(view.getByText(/1 tool call · Bash/)).toBeInTheDocument();
    // 工具栏 Turns:全轮折叠 → 出现轮摘要
    fireEvent.click(view.getByRole("button", { name: "Collapse turns" }));
    expect(view.getByText("1 step · 1 tool call")).toBeInTheDocument();
  });
});
