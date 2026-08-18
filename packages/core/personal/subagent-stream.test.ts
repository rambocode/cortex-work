// 子会话过程流折叠的回归测试(从 messages.test.ts 拆出,与 subagent-stream.ts 模块对应)。
// 事件从 __handleCliEventForTest 全链路打入:覆盖路由(降噪/双写)、id 语义、收尾与归档锚点。
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePersonalStore } from "../store/personal";
import type { CliStreamEvent, SessionMeta } from "../desktop/types";
import type { DesktopBridge } from "../desktop/bridge";
import type { Message } from "../types";
import {
  __handleCliEventForTest,
  __resetPersonalMessageRunsForTest,
  __setBridgeForTest,
  personalChatKeys,
  personalProcessKeys,
  personalRunEventsKeys,
  type RunEvent,
} from "./messages";

const baseSession: SessionMeta = {
  id: "s1",
  projectId: "p1",
  title: "Session 1",
  agent: "claude",
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  __resetPersonalMessageRunsForTest();
  usePersonalStore.setState({
    sessions: [],
    projects: [],
    runningBySession: {},
    piRuntimeBySession: {},
  });
});

afterEach(() => {
  __resetPersonalMessageRunsForTest();
  __setBridgeForTest(undefined);
  vi.useRealTimers();
});

describe("子会话过程流(subagent-stream)", () => {
  it("子代理 thinking/tool 流式折进子会话过程流，主会话过程流保持降噪", () => {
    usePersonalStore.setState({ sessions: [baseSession], runningBySession: {} });
    const qc = new QueryClient();
    const runId = "delegate-child-stream";
    const emit = (event: CliStreamEvent) => __handleCliEventForTest(qc, runId, event, "s1");

    emit({
      type: "init",
      sessionId: "s1",
      roleId: "explore",
      stage: "subagent",
      stageLabel: "探索",
      subagentCallId: "call-s",
      childSessionId: "child-s",
      subagentTask: "梳理模块结构",
      subagentAgentId: "pi",
    });
    // 子代理的思考与工具应实时折进 child-s 自己的过程流（side 页 Trajectory 数据源）。
    emit({ type: "thinking", delta: "先看目录结构", roleId: "explore", subagentCallId: "call-s" });
    emit({ type: "tool", name: "Read", detail: "pkg/a.ts", phase: "start", roleId: "explore", subagentCallId: "call-s", toolCallId: "t1" });
    emit({ type: "tool", name: "Read", phase: "end", roleId: "explore", subagentCallId: "call-s", toolCallId: "t1" });
    emit({ type: "text", delta: "结论：分三层。", roleId: "explore", subagentCallId: "call-s" });

    const childProcess = qc.getQueryData<Message[]>(personalProcessKeys.detail("child-s")) ?? [];
    const childReasoning = childProcess.filter(
      (message): message is Extract<Message, { kind: "reasoning" }> => message.kind === "reasoning",
    );
    expect(childReasoning.map((message) => message.text)).toEqual(["先看目录结构"]);
    const childLogs = childProcess.filter(
      (message): message is Extract<Message, { kind: "agentLog" }> => message.kind === "agentLog",
    );
    expect(childLogs).toHaveLength(1);
    const logItems = childLogs[0]!.items;
    expect(String(logItems[logItems.length - 1]!.text)).toContain("pkg/a.ts");
    // tool-end 帧把 running 项翻 check。
    expect(logItems[logItems.length - 1]!.ic).toBe("check");

    // 主会话过程流不复制子代理的思考/正文（降噪：并行多子代理不再灌爆主时间线）。
    const mainProcess = qc.getQueryData<Message[]>(personalProcessKeys.detail("s1")) ?? [];
    expect(mainProcess.some((message) => message.kind === "reasoning")).toBe(false);
    expect(mainProcess.some((message) => message.kind === "agentLog")).toBe(false);

    // 子会话 chat 仍旧流式收到正文；父卡片摘要同步更新。
    expect(qc.getQueryData<Message[]>(personalChatKeys.detail("child-s"))).toEqual([
      expect.objectContaining({ kind: "text", who: "me", text: "梳理模块结构" }),
      expect.objectContaining({ kind: "text", text: "结论：分三层。" }),
    ]);

    // 审阅修复:子命名空间的事件以 callId 为 run 标识、且不带父会话过滤标记——
    // 否则 collectRunInvocations/runTimeSpan 永远配不到子会话的工具输入/输出与耗时。
    const childEvents = qc.getQueryData<RunEvent[]>(personalRunEventsKeys.detail("child-s")) ?? [];
    expect(childEvents.length).toBeGreaterThan(0);
    for (const record of childEvents) {
      expect(record.runId).toBe("call-s");
      expect(record.ev.roleId).toBeUndefined();
      expect(record.ev.subagentCallId).toBeUndefined();
    }

    // 审阅修复:side 页未打开时子会话 process/run-events 不得按全局 10min gcTime 被回收
    //（前缀级 defaults,partial key 匹配到 detail(id)）。
    expect(qc.getQueryDefaults(personalProcessKeys.detail("child-s")).gcTime).toBe(Infinity);
    expect(qc.getQueryDefaults(personalRunEventsKeys.detail("child-s")).gcTime).toBe(Infinity);

    // 审阅修复:收尾时子会话 todo 卡关活跃态,不能让已结束的 side 会话一直转圈。
    emit({
      type: "todo",
      todos: [{ text: "扫目录", status: "completed" }, { text: "写结论", status: "in_progress" }],
      roleId: "explore",
      subagentCallId: "call-s",
    });
    emit({ type: "result", ok: true, roleId: "explore", subagentCallId: "call-s" });

    // result 收尾后子会话过程流与 todo 全部翻完成态（无 active 残留）。
    const settled = qc.getQueryData<Message[]>(personalProcessKeys.detail("child-s")) ?? [];
    expect(settled.some((message) => message.kind === "reasoning" && message.active)).toBe(false);
    const settledChat = qc.getQueryData<Message[]>(personalChatKeys.detail("child-s")) ?? [];
    const todoCard = settledChat.find(
      (message): message is Extract<Message, { kind: "todoList" }> => message.kind === "todoList",
    );
    expect(todoCard).toBeDefined();
    expect(todoCard?.active).toBe(false);
  });

  it("子代理并行工具:失败帧按 toolCallId 精确落到自己的项上,不错标他人也不被吞掉", () => {
    usePersonalStore.setState({ sessions: [baseSession], runningBySession: {} });
    const qc = new QueryClient();
    const runId = "delegate-parallel-tools";
    const emit = (event: CliStreamEvent) => __handleCliEventForTest(qc, runId, event, "s1");

    emit({
      type: "init",
      sessionId: "s1",
      roleId: "explore",
      stage: "subagent",
      stageLabel: "探索",
      subagentCallId: "call-p",
      childSessionId: "child-p",
      subagentTask: "并行探索",
      subagentAgentId: "pi",
    });
    emit({ type: "tool", name: "Read", detail: "a.ts", phase: "start", roleId: "explore", subagentCallId: "call-p", toolCallId: "tool-a" });
    // B 开始时折叠会把 A 自动翻 check(同卡单 running 模型)——A 之后的失败标记不能因此被吞。
    emit({ type: "tool", name: "Bash", detail: "long-job", phase: "start", roleId: "explore", subagentCallId: "call-p", toolCallId: "tool-b" });
    emit({ type: "tool", name: "Read", phase: "end", isError: true, roleId: "explore", subagentCallId: "call-p", toolCallId: "tool-a" });

    const items = () =>
      ((qc.getQueryData<Message[]>(personalProcessKeys.detail("child-p")) ?? []).find(
        (message): message is Extract<Message, { kind: "agentLog" }> => message.kind === "agentLog",
      )?.items ?? []).map((item) => String(item.text));

    // 审阅修复:A 必须显示失败(即使已被 B 的开始帧自动翻 check),且 ⚠️ 不落到 B 上。
    expect(items().find((text) => text.includes("a.ts"))).toContain("⚠️");
    expect(items().find((text) => text.includes("long-job"))).not.toContain("⚠️");

    // B 正常结束:自己的项收尾,不新增 ⚠️。
    emit({ type: "tool", name: "Bash", phase: "end", roleId: "explore", subagentCallId: "call-p", toolCallId: "tool-b" });
    expect(items().filter((text) => text.includes("⚠️"))).toHaveLength(1);
  });

  it("chat 缓存被 GC 后收尾归档仍带确定性锚点,重启回看不丢过程", async () => {
    usePersonalStore.setState({ sessions: [baseSession], runningBySession: {} });
    const qc = new QueryClient();
    const runId = "delegate-archive-anchor";
    const emit = (event: CliStreamEvent) => __handleCliEventForTest(qc, runId, event, "s1");
    const saveProcessArchive = vi.fn(async () => {});
    __setBridgeForTest({
      saveProcessArchive,
      loadProcessArchive: async () => [],
      loadChat: async () => [],
      saveChat: async () => {},
    } as unknown as DesktopBridge);

    emit({
      type: "init",
      sessionId: "s1",
      roleId: "explore",
      stage: "subagent",
      stageLabel: "探索",
      subagentCallId: "call-arch",
      childSessionId: "child-arch",
      subagentTask: "长任务",
      subagentAgentId: "pi",
    });
    emit({ type: "tool", name: "Read", detail: "big.ts", phase: "start", roleId: "explore", subagentCallId: "call-arch", toolCallId: "ta" });
    emit({ type: "tool", name: "Read", phase: "end", output: "ok", roleId: "explore", subagentCallId: "call-arch", toolCallId: "ta" });
    // 模拟 side 页未打开、chat query 被全局 gcTime 回收:此刻收尾,归档不得因读空缓存而失锚。
    qc.removeQueries({ queryKey: personalChatKeys.detail("child-arch"), exact: true });
    emit({ type: "result", ok: true, text: "done", roleId: "explore", subagentCallId: "call-arch" });

    await vi.waitFor(() => expect(saveProcessArchive).toHaveBeenCalled());
    const [sessionId, archives] = saveProcessArchive.mock.calls[0]! as unknown as [
      string,
      Array<{ runId: string; anchorUid?: string; invocations: Array<{ name: string; output?: string }> }>,
    ];
    expect(sessionId).toBe("child-arch");
    expect(archives[0]).toMatchObject({ runId: "call-arch", anchorUid: "subagent-task-call-arch" });
    // 子命名空间 runId ≡ callId + 剥标记后,归档能配对到工具输入/输出(不再恒为空)。
    expect(archives[0]!.invocations.some((inv) => inv.output === "ok")).toBe(true);
  });
});
