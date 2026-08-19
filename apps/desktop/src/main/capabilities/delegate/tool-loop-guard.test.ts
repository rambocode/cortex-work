import { describe, expect, it } from "vitest";

import {
  CHILD_TOOL_CYCLE_WINDOW,
  CHILD_TOOL_FAILURE_LIMIT,
  ChildToolLoopGuard,
} from "./tool-loop-guard";

function complete(
  guard: ChildToolLoopGuard,
  id: string,
  input: unknown,
  output: string,
  isError: boolean,
  name = "ls",
) {
  expect(guard.observe({ type: "tool", name, phase: "start", toolCallId: id, input })).toBeUndefined();
  return guard.observe({ type: "tool", name, phase: "end", toolCallId: id, output, isError });
}

describe("ChildToolLoopGuard", () => {
  it("其他成功调用不会清除同一失败调用的计数，第 3 次相同失败后熔断", () => {
    const guard = new ChildToolLoopGuard();
    const badInput = { path: "/tmp/dxtun 代理" };
    const goodInput = { path: "/tmp/dxtun代理" };

    expect(complete(guard, "bad-1", badInput, "Path not found", true)).toBeUndefined();
    expect(complete(guard, "good-1", goodInput, "需求文档/", false)).toBeUndefined();
    expect(complete(guard, "bad-2", badInput, "Path not found", true)).toBeUndefined();
    expect(complete(guard, "good-2", goodInput, "需求文档/", false)).toBeUndefined();
    expect(complete(guard, "bad-3", badInput, "Path not found", true)).toMatchObject({
      kind: "repeated-failure",
      toolName: "ls",
      repeatCount: CHILD_TOOL_FAILURE_LIMIT,
    });
  });

  it("对象键顺序不影响同一工具参数的指纹", () => {
    const guard = new ChildToolLoopGuard();
    expect(complete(guard, "a-1", { path: "/tmp/a", depth: 1 }, "missing", true)).toBeUndefined();
    expect(complete(guard, "a-2", { depth: 1, path: "/tmp/a" }, "missing", true)).toBeUndefined();
    expect(complete(guard, "a-3", { path: "/tmp/a", depth: 1 }, "missing", true)).toMatchObject({
      kind: "repeated-failure",
      repeatCount: CHILD_TOOL_FAILURE_LIMIT,
    });
  });

  it("路径中的空格按真实语义参与指纹，不合并两个不同路径", () => {
    const guard = new ChildToolLoopGuard();
    expect(complete(guard, "a-1", { path: "/tmp/dxtun 代理", depth: 1 }, "missing", true)).toBeUndefined();
    expect(complete(guard, "b-1", { depth: 1, path: "/tmp/dxtun代理" }, "missing", true)).toBeUndefined();
    expect(complete(guard, "a-2", { depth: 1, path: "/tmp/dxtun 代理" }, "missing", true)).toBeUndefined();
    expect(complete(guard, "b-2", { path: "/tmp/dxtun代理", depth: 1 }, "missing", true)).toBeUndefined();
  });

  it("同一调用成功后重置此前失败计数", () => {
    const guard = new ChildToolLoopGuard();
    const input = { path: "/tmp/eventual" };
    expect(complete(guard, "fail-1", input, "busy", true)).toBeUndefined();
    expect(complete(guard, "fail-2", input, "busy", true)).toBeUndefined();
    expect(complete(guard, "ok", input, "ready", false)).toBeUndefined();
    expect(complete(guard, "fail-3", input, "busy", true)).toBeUndefined();
    expect(complete(guard, "fail-4", input, "busy", true)).toBeUndefined();
  });

  it("前后两组四次调用完全重复且包含错误时判定无进展循环", () => {
    const guard = new ChildToolLoopGuard();
    const sequence = [
      [{ path: "/tmp/a" }, "missing", true],
      [{ path: "/tmp/b" }, "b", false],
      [{ path: "/tmp/c" }, "c", false],
      [{ path: "/tmp/d" }, "d", false],
    ] as const;
    let trip;
    for (let index = 0; index < CHILD_TOOL_CYCLE_WINDOW; index += 1) {
      const [input, output, isError] = sequence[index % sequence.length]!;
      trip = complete(guard, `cycle-${index}`, input, output, isError);
    }
    expect(trip).toMatchObject({ kind: "repeating-cycle", repeatCount: CHILD_TOOL_CYCLE_WINDOW });
  });

  it("纯成功的重复轮询不判为失败循环", () => {
    const guard = new ChildToolLoopGuard();
    for (let index = 0; index < CHILD_TOOL_CYCLE_WINDOW; index += 1) {
      expect(complete(guard, `poll-${index}`, { status: "job" }, "running", false, "status")).toBeUndefined();
    }
  });

  it("缺少 toolCallId 或无法配对的结束事件不参与熔断", () => {
    const guard = new ChildToolLoopGuard();
    for (let index = 0; index < CHILD_TOOL_FAILURE_LIMIT + 1; index += 1) {
      expect(guard.observe({ type: "tool", name: "ls", phase: "end", output: "missing", isError: true }))
        .toBeUndefined();
      expect(guard.observe({
        type: "tool",
        name: "ls",
        phase: "end",
        toolCallId: `orphan-${index}`,
        output: "missing",
        isError: true,
      })).toBeUndefined();
    }
  });
});
