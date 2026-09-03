// trajectory 布局折叠单测:轮/步划分、工具配对回填、usage 末条语义、失败轮与打断语义。
import { describe, expect, it } from "vitest";
import type { RunEvent, RunPromptRecord } from "@cortex-work/core";
import { buildTrajectoryLayout } from "./trajectory-layout";
import { trajectorySearchMatches } from "./trajectory-search";
import { deriveTrajectoryTimeline, trajectoryTimelineFocusIndexes } from "./trajectory-timeline-model";

const T0 = 1_700_000_000_000;

function ev(runId: string, at: number, e: RunEvent["ev"]): RunEvent {
  return { runId, ts: T0 + at, ev: e };
}

function prompt(runId: string, at: number, text: string): RunPromptRecord {
  return { runId, ts: T0 + at, text };
}

const build = (events: RunEvent[], prompts: RunPromptRecord[] = [], running = false) =>
  buildTrajectoryLayout({ events, prompts, running, fallbackToolName: "工具" });

describe("buildTrajectoryLayout", () => {
  it("一个 runId 一轮:USER 入 Message 组,正文与其后工具同步,工具后再有正文另起 Step", () => {
    const { turns, requests } = build(
      [
        ev("r1", 100, { type: "thinking", delta: "想一想" }),
        ev("r1", 200, { type: "text", delta: "先跑个命令" }),
        ev("r1", 300, { type: "tool", name: "Bash", detail: "ls", input: { command: "ls" }, phase: "start", toolCallId: "c1" }),
        ev("r1", 400, { type: "tool", name: "Bash", phase: "end", toolCallId: "c1", output: "a.txt" }),
        ev("r1", 500, { type: "text", delta: "结果是 a.txt" }),
      ],
      [prompt("r1", 0, "列一下文件")],
    );
    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    expect(turn.turn).toBe(1);
    expect(turn.groups.map((g) => g.title)).toEqual(["Message", "Step 1", "Step 2"]);
    const userCell = turn.groups[0]!.cells[0]!;
    expect(userCell.kind).toBe("user");
    expect(userCell.previewText).toBe("列一下文件");
    expect(userCell.opensTurn).toBe(true);
    const step1 = turn.groups[1]!.cells;
    expect(step1.map((c) => c.kind)).toEqual(["message", "tool"]);
    // thinking 与 text 合并进同一 assistant 行
    expect(step1[0]!.thinkingDetail).toBe("想一想");
    expect(step1[0]!.outputDetail).toBe("先跑个命令");
    const step2 = turn.groups[2]!.cells;
    expect(step2.map((c) => c.kind)).toEqual(["message"]);
    expect(step2[0]!.outputDetail).toBe("结果是 a.txt");
    // 全局序号连续
    expect(turn.groups.flatMap((g) => g.cells).map((c) => c.index)).toEqual([1, 2, 3, 4]);
    expect(requests.map((r) => [r.turn, r.step, r.number])).toEqual([
      [1, 1, 1],
      [1, 2, 2],
    ]);
  });

  it("工具 start/end 按 callId 配对:结果/错误/late detail 回填,耗时取两帧差", () => {
    const { turns } = build([
      ev("r1", 0, { type: "tool", name: "webSearch", phase: "start", toolCallId: "c1" }),
      ev("r1", 1_500, { type: "tool", name: "webSearch", detail: "查询词", phase: "end", toolCallId: "c1", output: "结果正文" }),
    ]);
    const tool = turns[0]!.groups[0]!.cells[0]!;
    expect(tool.kind).toBe("tool");
    expect(tool.running).toBe(false);
    expect(tool.previewText).toBe("查询词");
    expect(tool.resultPreviewText).toBe("结果正文");
    expect(tool.timeSeconds).toBeCloseTo(1.5);
  });

  it("丢配的 end 帧独立成行兜底;失败轮补红色 CONTEXT 行且 request 记 error", () => {
    const { turns, requests } = build([
      ev("r1", 0, { type: "tool", name: "Bash", phase: "end", toolCallId: "orphan", output: "boom", isError: true }),
      ev("r1", 100, { type: "result", ok: false, error: "exit 1" }),
    ]);
    const cells = turns[0]!.groups[0]!.cells;
    expect(cells[0]!.kind).toBe("tool");
    expect(cells[0]!.isError).toBe(true);
    const errorCell = cells[cells.length - 1]!;
    expect(errorCell.kind).toBe("context");
    expect(errorCell.isError).toBe(true);
    expect(errorCell.previewText).toBe("exit 1");
    expect(requests[0]!.status).toBe("error");
    expect(requests[0]!.error).toBe("exit 1");
  });

  it("usage 每轮取末条:挂到末个 assistant 行与末步 request,跨轮累计求和", () => {
    const { turns, requests } = build([
      ev("r1", 0, { type: "text", delta: "第一轮" }),
      ev("r1", 10, { type: "usage", inputTokens: 100, outputTokens: 10, cachedInputTokens: 60 }),
      ev("r1", 20, { type: "usage", inputTokens: 200, outputTokens: 30, cachedInputTokens: 150 }),
      ev("r2", 100, { type: "text", delta: "第二轮" }),
      ev("r2", 110, { type: "usage", inputTokens: 50, outputTokens: 5 }),
    ]);
    const assistant1 = turns[0]!.groups[0]!.cells[0]!;
    expect(assistant1.input).toBe(200);
    expect(assistant1.output).toBe(30);
    expect(assistant1.cacheRead).toBe(150);
    expect(requests[0]!.usage).toEqual({ input: 200, cacheRead: 150, output: 30 });
    expect(requests[1]!.cumulativeUsage).toEqual({ input: 250, cacheRead: 150, output: 35 });
  });

  it("running 语义:会话运行中末轮未配对工具转圈;停止后未配对工具按打断收尾", () => {
    const events = [ev("r1", 0, { type: "tool", name: "Bash", phase: "start", toolCallId: "c1" } as const)];
    const live = build(events, [], true);
    expect(live.turns[0]!.groups[0]!.cells[0]!.running).toBe(true);
    const dead = build(events, [], false);
    const cell = dead.turns[0]!.groups[0]!.cells[0]!;
    expect(cell.running).toBe(false);
    expect(cell.isError).toBe(true);
    expect(cell.result).toBe("interrupted");
  });

  it("recovered:同轮内失败的 Bash 之后有同名成功调用 → 标 recovered,request 不算 error", () => {
    const { turns, requests } = build([
      ev("r1", 0, { type: "tool", name: "Bash", phase: "start", toolCallId: "c1" }),
      ev("r1", 10, { type: "tool", name: "Bash", phase: "end", toolCallId: "c1", output: "ModuleNotFoundError", isError: true }),
      ev("r1", 20, { type: "tool", name: "Bash", phase: "start", toolCallId: "c2" }),
      ev("r1", 30, { type: "tool", name: "Bash", phase: "end", toolCallId: "c2", output: "ok" }),
      ev("r1", 40, { type: "result", ok: true }),
    ]);
    const cells = turns[0]!.groups[0]!.cells;
    expect(cells[0]!.isError).toBe(true);
    expect(cells[0]!.recovered).toBe(true);
    expect(cells[1]!.isError).toBe(false);
    expect(cells[1]!.recovered).toBeUndefined();
    expect(requests[0]!.status).toBe("complete");
  });

  it("recovered:跨 step 也算同轮;失败在成功之后则不算恢复", () => {
    const { turns, requests } = build([
      ev("r1", 0, { type: "tool", name: "Bash", phase: "start", toolCallId: "c1" }),
      ev("r1", 10, { type: "tool", name: "Bash", phase: "end", toolCallId: "c1", output: "boom", isError: true }),
      ev("r1", 20, { type: "text", delta: "换个方式" }),
      ev("r1", 30, { type: "tool", name: "Bash", phase: "start", toolCallId: "c2" }),
      ev("r1", 40, { type: "tool", name: "Bash", phase: "end", toolCallId: "c2", output: "ok" }),
      ev("r1", 50, { type: "tool", name: "Bash", phase: "start", toolCallId: "c3" }),
      ev("r1", 60, { type: "tool", name: "Bash", phase: "end", toolCallId: "c3", output: "boom again", isError: true }),
    ]);
    const step1 = turns[0]!.groups[0]!.cells;
    const step2 = turns[0]!.groups[1]!.cells;
    // 第一步的失败被第二步的同名成功覆盖
    expect(step1[0]!.recovered).toBe(true);
    expect(requests[0]!.status).toBe("complete");
    // 第二步末尾的失败之后再无同名成功:真失败
    expect(step2[2]!.isError).toBe(true);
    expect(step2[2]!.recovered).toBeFalsy();
    expect(requests[1]!.status).toBe("error");
  });

  it("recovered 反例:失败后没有同名成功(不同工具名成功不算)→ 仍是 error", () => {
    const { turns, requests } = build([
      ev("r1", 0, { type: "tool", name: "Bash", phase: "start", toolCallId: "c1" }),
      ev("r1", 10, { type: "tool", name: "Bash", phase: "end", toolCallId: "c1", output: "boom", isError: true }),
      ev("r1", 20, { type: "tool", name: "Read", phase: "start", toolCallId: "c2" }),
      ev("r1", 30, { type: "tool", name: "Read", phase: "end", toolCallId: "c2", output: "ok" }),
    ]);
    const cells = turns[0]!.groups[0]!.cells;
    expect(cells[0]!.isError).toBe(true);
    expect(cells[0]!.recovered).toBeFalsy();
    expect(requests[0]!.status).toBe("error");
  });

  it("recovered 不作用于轮末 result 失败补的 Error 行,也不作用于 interrupted 行", () => {
    const { turns, requests } = build([
      ev("r1", 0, { type: "tool", name: "Bash", phase: "start", toolCallId: "c1" }),
      ev("r1", 10, { type: "tool", name: "Bash", phase: "end", toolCallId: "c1", output: "boom", isError: true }),
      ev("r1", 20, { type: "tool", name: "Bash", phase: "start", toolCallId: "c2" }),
      ev("r1", 30, { type: "tool", name: "Bash", phase: "end", toolCallId: "c2", output: "ok" }),
      ev("r1", 40, { type: "result", ok: false, error: "exit 1" }),
    ]);
    const cells = turns[0]!.groups[0]!.cells;
    expect(cells[0]!.recovered).toBe(true);
    const errorCell = cells[cells.length - 1]!;
    expect(errorCell.kind).toBe("context");
    expect(errorCell.isError).toBe(true);
    expect(errorCell.recovered).toBeUndefined();
    // 轮末失败仍让整步为 error
    expect(requests[0]!.status).toBe("error");

    // interrupted:未配对的 Bash 在会话停止后被判打断,即便后面有同名成功也不算恢复
    const dead = build([
      ev("r2", 0, { type: "tool", name: "Bash", phase: "start", toolCallId: "d1" }),
      ev("r2", 10, { type: "tool", name: "Bash", phase: "start", toolCallId: "d2" }),
      ev("r2", 20, { type: "tool", name: "Bash", phase: "end", toolCallId: "d2", output: "ok" }),
    ]);
    const deadCells = dead.turns[0]!.groups[0]!.cells;
    expect(deadCells[0]!.result).toBe("interrupted");
    expect(deadCells[0]!.recovered).toBeUndefined();
    expect(dead.requests[0]!.status).toBe("error");
  });

  it("只有 prompt 没有事件的轮也出现(run 启动中)", () => {
    const { turns } = build([], [prompt("r1", 0, "你好")]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.groups[0]!.cells[0]!.kind).toBe("user");
  });
});

describe("trajectorySearchMatches", () => {
  it("空查询返回 null;多词 AND 命中正文与工具名", () => {
    const { turns } = build(
      [
        ev("r1", 0, { type: "tool", name: "Bash", detail: "ls -la", input: { command: "ls -la" }, phase: "start", toolCallId: "c1" }),
        ev("r1", 10, { type: "tool", name: "Bash", phase: "end", toolCallId: "c1", output: "a.txt" }),
        ev("r1", 20, { type: "text", delta: "完成了" }),
      ],
      [prompt("r1", 0, "列文件")],
    );
    expect(trajectorySearchMatches(turns, "")).toBeNull();
    const hits = trajectorySearchMatches(turns, "bash a.txt")!;
    expect(hits.size).toBe(1);
    const empty = trajectorySearchMatches(turns, "不存在的词")!;
    expect(empty.size).toBe(0);
  });
});

describe("timeline 投影", () => {
  it("sequence 一格一记录并携带轮边界;duration 压缩空闲并保留区段时长", () => {
    const { turns } = build(
      [
        ev("r1", 0, { type: "text", delta: "hi" }),
        ev("r1", 1_000, { type: "tool", name: "Bash", phase: "start", toolCallId: "c1" }),
        ev("r1", 3_000, { type: "tool", name: "Bash", phase: "end", toolCallId: "c1", output: "ok" }),
        ev("r2", 60_000, { type: "text", delta: "第二轮" }),
      ],
      [prompt("r1", 0, "开始"), prompt("r2", 59_000, "继续")],
    );
    const seq = deriveTrajectoryTimeline(turns, "sequence")!;
    expect(seq.end - seq.start).toBe(seq.spans.length);
    expect(seq.turnBoundaries.map((b) => b.turn)).toEqual([1, 2]);
    const timed = deriveTrajectoryTimeline(turns, "duration")!;
    // 两轮之间 ~56s 的空闲被压缩:全域宽度显著小于原始跨度
    expect(timed.end - timed.start).toBeLessThan(20_000);
    const focus = trajectoryTimelineFocusIndexes(turns, { start: seq.start, end: seq.end }, "sequence");
    expect(focus.size).toBe(seq.spans.length);
  });
});
