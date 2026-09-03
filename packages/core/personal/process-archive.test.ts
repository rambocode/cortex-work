import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import {
  MAX_ARCHIVED_OUTPUT,
  MAX_ARCHIVED_REASONING,
  MAX_ARCHIVED_TURNS,
  appendTurnArchive,
  buildTurnArchive,
  collectRunInvocations,
  dropArchivesWithoutAnchor,
  normalizeLoadedArchives,
  runTimeSpan,
  type RunEventRecord,
  type TurnProcessArchive,
} from "./process-archive";

function toolStart(runId: string, ts: number, callId: string, name = "Bash"): RunEventRecord {
  return { runId, ts, ev: { type: "tool", name, phase: "start", toolCallId: callId, input: { command: "ls" } } };
}

function toolEnd(runId: string, ts: number, callId: string, output: string, name = "Bash"): RunEventRecord {
  return { runId, ts, ev: { type: "tool", name, phase: "end", toolCallId: callId, output } };
}

const processMessages: Message[] = [
  { kind: "reasoning", who: "claude", time: "10:00", text: "先看看目录", uid: "r1", active: true },
  {
    kind: "agentLog",
    who: "claude",
    time: "10:00",
    title: "执行中",
    uid: "l1",
    active: true,
    items: [{ ic: "running", text: "Bash", toolName: "Bash" }],
  },
];

describe("collectRunInvocations · 按 runId 配对工具调用", () => {
  it("按 toolCallId 配对 start/end，并记录起止时刻", () => {
    const invocations = collectRunInvocations(
      [toolStart("run-1", 1_000, "c1"), toolEnd("run-1", 3_200, "c1", "ok")],
      "run-1",
    );
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ name: "Bash", output: "ok", running: false, startedAt: 1_000, endedAt: 3_200 });
  });

  it("只取指定轮：其它轮的事件不串进来", () => {
    const events = [toolStart("run-1", 1_000, "c1"), toolStart("run-2", 2_000, "c2", "Read")];
    expect(collectRunInvocations(events, "run-2")).toHaveLength(1);
    expect(collectRunInvocations(events, "run-2")[0]!.name).toBe("Read");
  });

  it("子代理事件不进主会话（归它自己的卡片）", () => {
    const events: RunEventRecord[] = [
      { runId: "run-1", ts: 1, ev: { type: "tool", name: "Bash", phase: "start", toolCallId: "c1", subagentCallId: "s1" } },
    ];
    expect(collectRunInvocations(events, "run-1")).toEqual([]);
  });

  it("runId 为空（无事件）返回空列表", () => {
    expect(collectRunInvocations([], undefined)).toEqual([]);
  });
});

describe("runTimeSpan", () => {
  it("取该轮全部事件的首尾到达时刻", () => {
    const span = runTimeSpan([toolStart("run-1", 500, "c1"), toolEnd("run-1", 9_300, "c1", "ok")], "run-1");
    expect(span).toEqual({ startedAt: 500, endedAt: 9_300 });
  });
});

describe("buildTurnArchive", () => {
  it("打包过程流 + 工具快照，并把流式中间态归一为完成态", () => {
    const archive = buildTurnArchive({
      runId: "run-1",
      anchorUid: "u1",
      processMessages,
      events: [toolStart("run-1", 1_000, "c1"), toolEnd("run-1", 9_800, "c1", "done")],
      fallbackTs: 42,
    });
    expect(archive).not.toBeNull();
    expect(archive!.anchorUid).toBe("u1");
    expect(archive!.startedAt).toBe(1_000);
    expect(archive!.endedAt).toBe(9_800);
    // 快照语义：历史轮不该有转圈的思考行/工具行。
    const reasoning = archive!.messages.find((m) => m.kind === "reasoning")!;
    expect(reasoning.kind === "reasoning" && reasoning.active).toBe(false);
    const log = archive!.messages.find((m) => m.kind === "agentLog")!;
    expect(log.kind === "agentLog" && log.items[0]!.ic).toBe("check");
    expect(archive!.invocations[0]).toMatchObject({ output: "done", running: false });
  });

  it("纯文本轮（无过程内容）不产生归档", () => {
    expect(buildTurnArchive({ runId: "run-1", processMessages: [], events: [], fallbackTs: 1 })).toBeNull();
  });

  it("事件已被环形裁剪时用兜底时刻，不给出假的时间跨度", () => {
    const archive = buildTurnArchive({ runId: "run-1", processMessages, events: [], fallbackTs: 777 })!;
    expect(archive.startedAt).toBe(777);
    expect(archive.endedAt).toBe(777);
  });

  it("retrieval 终态消息被归档保留并归一 active=false", () => {
    const archive = buildTurnArchive({
      runId: "run-1",
      processMessages: [
        {
          kind: "retrieval",
          who: "pi",
          time: "10:00",
          uid: "rt-1",
          phase: "done",
          resultCount: 3,
          active: false,
        } as Message,
        ...processMessages,
      ],
      events: [],
      fallbackTs: 1,
    })!;
    const retrieval = archive.messages[0]!;
    expect(retrieval).toMatchObject({ kind: "retrieval", phase: "done", resultCount: 3, active: false });
  });

  it("retrieval 非终态（轮已结束仍在 understanding/searching）被 coerce 为 failed/interrupted，不臆造成功", () => {
    const archive = buildTurnArchive({
      runId: "run-1",
      processMessages: [
        { kind: "retrieval", who: "pi", time: "10:00", uid: "rt-1", phase: "searching", active: true } as Message,
        ...processMessages,
      ],
      events: [],
      fallbackTs: 1,
    })!;
    expect(archive.messages[0]).toMatchObject({
      kind: "retrieval",
      phase: "failed",
      error: "interrupted",
      active: false,
    });
  });

  it("超长工具输出与思考正文按上限截断（归档是可丢数据，不能撑爆文件）", () => {
    const longOutput = "x".repeat(MAX_ARCHIVED_OUTPUT + 500);
    const longReasoning = "思".repeat(MAX_ARCHIVED_REASONING + 500);
    const archive = buildTurnArchive({
      runId: "run-1",
      processMessages: [{ kind: "reasoning", who: "claude", time: "10:00", text: longReasoning, uid: "r1" }, processMessages[1]!],
      events: [toolStart("run-1", 1, "c1"), toolEnd("run-1", 2, "c1", longOutput)],
      fallbackTs: 1,
    })!;
    expect(archive.invocations[0]!.output!.length).toBe(MAX_ARCHIVED_OUTPUT + 1); // 截断 + 省略号
    const reasoning = archive.messages[0]!;
    expect(reasoning.kind === "reasoning" && typeof reasoning.text === "string" && reasoning.text.length).toBe(
      MAX_ARCHIVED_REASONING + 1,
    );
  });
});

describe("appendTurnArchive", () => {
  const make = (runId: string): TurnProcessArchive => ({
    runId,
    startedAt: 0,
    endedAt: 1,
    messages: processMessages,
    invocations: [],
  });

  it("同 runId 视为重写，不产生重复条", () => {
    const next = appendTurnArchive([make("run-1")], { ...make("run-1"), endedAt: 99 });
    expect(next).toHaveLength(1);
    expect(next[0]!.endedAt).toBe(99);
  });

  it("超过轮数上限丢最旧", () => {
    let list: TurnProcessArchive[] = [];
    for (let i = 0; i < MAX_ARCHIVED_TURNS + 5; i += 1) list = appendTurnArchive(list, make(`run-${i}`));
    expect(list).toHaveLength(MAX_ARCHIVED_TURNS);
    expect(list[0]!.runId).toBe("run-5");
  });
});

describe("normalizeLoadedArchives", () => {
  it("非数组 / 脏条一律丢弃，不让坏归档挡住会话加载", () => {
    expect(normalizeLoadedArchives(null)).toEqual([]);
    expect(normalizeLoadedArchives([{ runId: 1 }, { messages: [] }, "x"])).toEqual([]);
  });

  it("合法条保留并补齐缺省字段", () => {
    const out = normalizeLoadedArchives([{ runId: "run-1", messages: [], invocations: undefined }]);
    expect(out).toEqual([{ runId: "run-1", anchorUid: undefined, startedAt: 0, endedAt: 0, messages: [], invocations: [] }]);
  });
});

describe("dropArchivesWithoutAnchor", () => {
  it("锚点消息已被截断的轮丢弃；无锚点的自动轮保留", () => {
    const list: TurnProcessArchive[] = [
      { runId: "a", anchorUid: "u1", startedAt: 0, endedAt: 1, messages: [], invocations: [] },
      { runId: "b", anchorUid: "gone", startedAt: 0, endedAt: 1, messages: [], invocations: [] },
      { runId: "c", startedAt: 0, endedAt: 1, messages: [], invocations: [] },
    ];
    expect(dropArchivesWithoutAnchor(list, new Set(["u1"])).map((x) => x.runId)).toEqual(["a", "c"]);
  });
});
