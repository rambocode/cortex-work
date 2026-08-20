// 过程时间线纯逻辑层单测：阶段分组、摘要统计、失败派生与耗时格式化（3a 规格 §3/§4/§8）。
import { describe, expect, it } from "vitest";
import type { RunEvent } from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";
import {
  buildCurrentRunToolInvocations,
  buildProcessEntries,
  buildProcessPresentation,
  formatClock,
  formatDuration,
  groupProcessStages,
} from "./processTimeline";

function toolEvent(
  partial: {
    runId?: string;
    ts: number;
    phase?: "start" | "end";
    name: string;
    toolCallId?: string;
    input?: unknown;
    output?: string;
    isError?: boolean;
    detail?: string;
  },
): RunEvent {
  const { runId = "run-1", ts, phase = "start", ...ev } = partial;
  return { runId, ts, ev: { type: "tool", phase, ...ev } as RunEvent["ev"] };
}

describe("buildCurrentRunToolInvocations · 时间戳", () => {
  it("按 toolCallId 配对 start/end，并记下起止时刻供渲染层算耗时", () => {
    const invocations = buildCurrentRunToolInvocations([
      toolEvent({ ts: 1_000, phase: "start", name: "Bash", toolCallId: "c1", input: { command: "ls" } }),
      toolEvent({ ts: 1_600, phase: "end", name: "Bash", toolCallId: "c1", output: "a\nb" }),
    ]);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ running: false, startedAt: 1_000, endedAt: 1_600 });
  });

  it("只收到 end 帧时不臆造 startedAt——耗时宁可不显示，也不能猜", () => {
    const invocations = buildCurrentRunToolInvocations([
      toolEvent({ ts: 2_000, phase: "end", name: "Grep", toolCallId: "c9", output: "hit" }),
    ]);
    expect(invocations[0]?.startedAt).toBeUndefined();
    expect(invocations[0]?.endedAt).toBe(2_000);
  });
});

describe("groupProcessStages", () => {
  const reasoning = (uid: string): Message => ({
    kind: "reasoning",
    who: "pi",
    time: "10:00",
    uid,
    text: "想一下",
  });
  const log = (uid: string, items: Array<{ text: string; toolName: string; ic: "check" | "running" }>): Message => ({
    kind: "agentLog",
    who: "pi",
    time: "10:00",
    uid,
    title: "工具",
    items,
  });

  it("没有段边界信号时聚成一个缺省阶段，并按「文件去重」统计读取数", () => {
    const events = [
      toolEvent({ ts: 100, phase: "start", name: "Read", toolCallId: "r1", input: { file_path: "a.ts" } }),
      toolEvent({ ts: 300, phase: "end", name: "Read", toolCallId: "r1", output: "x" }),
      toolEvent({ ts: 400, phase: "start", name: "Read", toolCallId: "r2", input: { file_path: "a.ts" } }),
      toolEvent({ ts: 500, phase: "end", name: "Read", toolCallId: "r2", output: "x" }),
      toolEvent({ ts: 600, phase: "start", name: "Bash", toolCallId: "b1", input: { command: "ls" } }),
      toolEvent({ ts: 1_300, phase: "end", name: "Bash", toolCallId: "b1", output: "ok" }),
    ];
    const messages = [
      reasoning("m1"),
      log("m2", [
        { text: "Read · a.ts", toolName: "Read", ic: "check" },
        { text: "Read · a.ts", toolName: "Read", ic: "check" },
        { text: "Bash · ls", toolName: "Bash", ic: "check" },
      ]),
    ];
    const stages = groupProcessStages(
      buildProcessEntries(messages, buildCurrentRunToolInvocations(events)),
    );
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      stepCount: 4,
      readCount: 1, // 同一个 a.ts 读两次仍是「1 个文件」
      toolCount: 1,
      running: false,
      failed: false,
      startedAt: 100,
      elapsedMs: 1_200,
    });
  });

  it("stageTitle 切出多个阶段，条目按出现顺序归属各自阶段", () => {
    const messages: Message[] = [
      { kind: "stageTitle", who: "pi", time: "10:00", uid: "s1", stage: "intent", label: "前期准备" },
      reasoning("m1"),
      { kind: "stageTitle", who: "pi", time: "10:01", uid: "s2", stage: "refine", label: "生成幻灯片" },
      reasoning("m2"),
      reasoning("m3"),
    ];
    const stages = groupProcessStages(buildProcessEntries(messages, []));
    expect(stages.map((stage) => [stage.label, stage.stepCount])).toEqual([
      ["前期准备", 1],
      ["生成幻灯片", 2],
    ]);
  });

  it("阶段内出现失败工具 → failed 置位（规格 §8：失败阶段不自动折叠）", () => {
    const events = [
      toolEvent({ ts: 100, phase: "start", name: "Bash", toolCallId: "b1", input: { command: "boom" } }),
      toolEvent({ ts: 200, phase: "end", name: "Bash", toolCallId: "b1", output: "err", isError: true }),
    ];
    const stages = groupProcessStages(
      buildProcessEntries(
        [log("m1", [{ text: "Bash · boom", toolName: "Bash", ic: "check" }])],
        buildCurrentRunToolInvocations(events),
      ),
    );
    expect(stages[0]?.failed).toBe(true);
  });

  it("运行中的条目让阶段保持 running；空阶段被丢弃，不留下只有标题的空壳", () => {
    const messages: Message[] = [
      { kind: "stageTitle", who: "pi", time: "10:00", uid: "s1", stage: "intent", label: "空阶段" },
      { kind: "stageTitle", who: "pi", time: "10:01", uid: "s2", stage: "subagent", label: "有内容" },
      log("m1", [{ text: "Bash · sleep", toolName: "Bash", ic: "running" }]),
    ];
    const stages = groupProcessStages(buildProcessEntries(messages, []));
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ label: "有内容", running: true });
  });
});

describe("耗时格式化", () => {
  it("阶段级一律 m:ss", () => {
    expect(formatClock(72_000)).toBe("1:12");
    expect(formatClock(41_000)).toBe("0:41");
    expect(formatClock(0)).toBe("0:00");
  });

  it("工具级不足一分钟用秒，10s 起取整，超过一分钟退回 m:ss", () => {
    expect(formatDuration(600)).toBe("0.6s");
    expect(formatDuration(1_800)).toBe("1.8s");
    expect(formatDuration(23_400)).toBe("23s");
    expect(formatDuration(61_000)).toBe("1:01");
  });
});

describe("buildProcessPresentation", () => {
  const log = (items: Array<{ text: string; toolName: string; ic: "check" | "running" }>): Message => ({
    kind: "agentLog",
    who: "pi",
    time: "10:00",
    title: "工具",
    items,
  });

  it("连续成功读取按相对路径聚合、同一路径去重，失败读取独立保留", () => {
    const entries = buildProcessEntries(
      [
        log([
          { text: "Read a", toolName: "Read", ic: "check" },
          { text: "Read a again", toolName: "Read", ic: "check" },
          { text: "Read b", toolName: "Read", ic: "check" },
          { text: "Read missing", toolName: "Read", ic: "check" },
        ]),
      ],
      buildCurrentRunToolInvocations([
        toolEvent({ ts: 1, name: "Read", toolCallId: "a1", input: { file_path: "/repo/a.ts" } }),
        toolEvent({ ts: 2, phase: "end", name: "Read", toolCallId: "a1" }),
        toolEvent({ ts: 3, name: "Read", toolCallId: "a2", input: { file_path: "/repo/a.ts" } }),
        toolEvent({ ts: 4, phase: "end", name: "Read", toolCallId: "a2" }),
        toolEvent({ ts: 5, name: "Read", toolCallId: "b1", input: { file_path: "/repo/b.ts" } }),
        toolEvent({ ts: 6, phase: "end", name: "Read", toolCallId: "b1" }),
        toolEvent({ ts: 7, name: "Read", toolCallId: "missing", input: { file_path: "/outside/missing.ts" } }),
        toolEvent({ ts: 8, phase: "end", name: "Read", toolCallId: "missing", isError: true }),
      ]),
    );
    const presentation = buildProcessPresentation(groupProcessStages(entries), { cwd: "/repo" });
    expect(presentation.stages[0]?.rows).toMatchObject([
      { kind: "read-group", labels: ["a.ts", "b.ts"], count: 2, callIds: ["a1", "a2", "b1"] },
      { kind: "tool", status: "failed" },
    ]);
    expect(presentation.summary).toMatchObject({ files: 2, failed: 1 });
  });

  it("reasoning 流式增量只形成一个稳定活动行，tool_search 不进入聊天流", () => {
    const messages: Message[] = [
      { kind: "reasoning", who: "pi", time: "10:00", uid: "r1", text: "first", active: false },
      { kind: "reasoning", who: "pi", time: "10:00", uid: "r2", text: "second", active: true },
      log([{ text: "discover", toolName: "tool_search", ic: "check" }]),
    ];
    const rows = buildProcessPresentation(groupProcessStages(buildProcessEntries(messages, []))).stages[0]?.rows;
    expect(rows).toEqual([{ kind: "reasoning", key: "r1", label: "thinking", status: "running" }]);
  });

  it("命令保持顺序、将多行正文压成单行，且不重建既有 key", () => {
    const entries = buildProcessEntries(
      [log([{ text: "first", toolName: "Bash", ic: "check" }, { text: "second", toolName: "Bash", ic: "check" }])],
      buildCurrentRunToolInvocations([
        toolEvent({ ts: 1, name: "Bash", toolCallId: "one", input: { command: "git\nstatus" } }),
        toolEvent({ ts: 2, phase: "end", name: "Bash", toolCallId: "one" }),
        toolEvent({ ts: 3, name: "Bash", toolCallId: "two", input: { command: "pnpm typecheck" } }),
        toolEvent({ ts: 4, phase: "end", name: "Bash", toolCallId: "two" }),
      ]),
    );
    const rows = buildProcessPresentation(groupProcessStages(entries)).stages[0]?.rows;
    expect(rows).toMatchObject([
      { kind: "command", key: "tool-one", label: "git status", callId: "one" },
      { kind: "command", key: "tool-two", label: "pnpm typecheck", callId: "two" },
    ]);
  });
});
