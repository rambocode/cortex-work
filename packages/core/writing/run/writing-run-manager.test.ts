// writing-run-manager 的单元测试:回合派发、事件折叠、多轮续接、per-space 停止隔离、
// 组件卸载后事件仍被模块级 manager 收取(覆盖 U7 场景)。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesktopBridge } from "../../desktop/bridge";
import type { CliExitEvent, CliStartRequest, CliStreamEvent } from "../../desktop/types";
import {
  __resetWritingRunManagerForTest,
  cancelRunsForSpace,
  installWritingRuntime,
  isWritingRunId,
  sendWritingMessage,
  useWritingRunStore,
  writingSpaceBusy,
} from "./writing-run-manager";

// 可控 mock bridge:捕获 onCliEvent/onCliExit 回调,记录 startCli/killCli 调用,支持手动派发事件。
function makeMockBridge() {
  const eventCbs: Array<(runId: string, ev: CliStreamEvent, sid?: string) => void> = [];
  const exitCbs: Array<(exit: CliExitEvent) => void> = [];
  const startCalls: CliStartRequest[] = [];
  const killCalls: string[] = [];
  const bridge = {
    onCliEvent: (cb: (runId: string, ev: CliStreamEvent, sid?: string) => void) => {
      eventCbs.push(cb);
      return () => {};
    },
    onCliExit: (cb: (exit: CliExitEvent) => void) => {
      exitCbs.push(cb);
      return () => {};
    },
    startCli: async (req: CliStartRequest) => {
      startCalls.push(req);
    },
    killCli: async (id: string) => {
      killCalls.push(id);
    },
  } as unknown as DesktopBridge;
  return {
    bridge,
    startCalls,
    killCalls,
    emitEvent: (runId: string, ev: CliStreamEvent) => eventCbs.forEach((cb) => cb(runId, ev)),
    emitExit: (exit: CliExitEvent) => exitCbs.forEach((cb) => cb(exit)),
  };
}

beforeEach(() => {
  __resetWritingRunManagerForTest();
});

afterEach(() => {
  __resetWritingRunManagerForTest();
});

describe("writing-run-manager", () => {
  it("isWritingRunId 只认 writing: 前缀", () => {
    expect(isWritingRunId("writing:ws-a:r_1")).toBe(true);
    expect(isWritingRunId("design:doc:r_1")).toBe(false);
    expect(isWritingRunId("run-1")).toBe(false);
  });

  it("runId/sessionId 形状正确,首轮不带 resumeSessionId", async () => {
    const m = makeMockBridge();
    installWritingRuntime(m.bridge);
    const ok = await sendWritingMessage({
      spaceId: "ws-a",
      threadId: "t1",
      cwd: "/root/a",
      prompt: "润色第一段",
      agent: "claude",
    });
    expect(ok).toBe(true);
    const req = m.startCalls[0]!;
    expect(req.runId).toMatch(/^writing:ws-a:r_/);
    expect(req.sessionId).toBe("writing-t1");
    expect(req.cwd).toBe("/root/a");
    expect(req.permissionMode).toBe("accept-edits");
    expect(req.approvalPolicy).toBe("auto");
    expect(req.resumeSessionId).toBeUndefined();
  });

  it("第二轮起传递 resumeSessionId(从 init 事件捕获)", async () => {
    const m = makeMockBridge();
    installWritingRuntime(m.bridge);
    await sendWritingMessage({
      spaceId: "ws-a",
      threadId: "t1",
      cwd: "/root/a",
      prompt: "第一轮",
      agent: "claude",
    });
    const runId1 = m.startCalls[0]!.runId;
    // agent 回显真实 sessionId → 捕获供续接。
    m.emitEvent(runId1, { type: "init", sessionId: "agent-sess-1" });
    m.emitExit({ runId: runId1, code: 0 });

    await sendWritingMessage({
      spaceId: "ws-a",
      threadId: "t1",
      cwd: "/root/a",
      prompt: "第二轮",
      agent: "claude",
    });
    expect(m.startCalls[1]!.resumeSessionId).toBe("agent-sess-1");
  });

  it("停止只 kill 当前空间的 run,其它空间与 design run 存活", async () => {
    const m = makeMockBridge();
    installWritingRuntime(m.bridge);
    await sendWritingMessage({ spaceId: "ws-a", threadId: "ta", cwd: "/a", prompt: "x", agent: "claude" });
    await sendWritingMessage({ spaceId: "ws-b", threadId: "tb", cwd: "/b", prompt: "y", agent: "claude" });
    const runIdA = m.startCalls[0]!.runId;
    const runIdB = m.startCalls[1]!.runId;
    expect(writingSpaceBusy("ws-a")).toBe(true);
    expect(writingSpaceBusy("ws-b")).toBe(true);

    await cancelRunsForSpace("ws-a");
    // 只 kill 了 A 的 runId;B 未被 kill(design run 更不在 activeRuns,天然不受影响)。
    expect(m.killCalls).toEqual([runIdA]);
    expect(m.killCalls).not.toContain(runIdB);
    expect(writingSpaceBusy("ws-a")).toBe(false);
    expect(writingSpaceBusy("ws-b")).toBe(true);
  });

  it("事件折叠:用户/流式 assistant/工具消息进入镜像", async () => {
    const m = makeMockBridge();
    installWritingRuntime(m.bridge);
    await sendWritingMessage({ spaceId: "ws-a", threadId: "t1", cwd: "/a", prompt: "帮我改", agent: "claude" });
    const runId = m.startCalls[0]!.runId;
    m.emitEvent(runId, { type: "init", sessionId: "s" });
    m.emitEvent(runId, { type: "text", delta: "好的" });
    m.emitEvent(runId, { type: "text", delta: ",已改" });
    m.emitEvent(runId, {
      type: "tool",
      name: "Edit",
      phase: "start",
      toolCallId: "tc1",
      input: { file_path: "/a/x.md" },
    });
    m.emitEvent(runId, { type: "tool", name: "Edit", phase: "end", toolCallId: "tc1" });

    const msgs = useWritingRunStore.getState().messagesByThread.t1!;
    expect(msgs[0]).toMatchObject({ role: "user", text: "帮我改" });
    const assistant = msgs.find((x) => x.role === "assistant");
    expect(assistant).toMatchObject({ role: "assistant", text: "好的,已改" });
    const tool = msgs.find((x) => x.role === "tool");
    expect(tool).toMatchObject({ role: "tool", name: "Edit", status: "success" });
  });

  it("result 无流式文本时把 result.text 补成 assistant 块", async () => {
    const m = makeMockBridge();
    installWritingRuntime(m.bridge);
    await sendWritingMessage({ spaceId: "ws-a", threadId: "t1", cwd: "/a", prompt: "q", agent: "pi" });
    const runId = m.startCalls[0]!.runId;
    m.emitEvent(runId, { type: "result", ok: true, text: "最终回复" });
    const msgs = useWritingRunStore.getState().messagesByThread.t1!;
    expect(msgs.some((x) => x.role === "assistant" && x.text === "最终回复")).toBe(true);
  });

  it("组件卸载(不再持有引用)后事件仍被模块级 manager 收取,镜像完整", async () => {
    const m = makeMockBridge();
    installWritingRuntime(m.bridge);
    await sendWritingMessage({ spaceId: "ws-a", threadId: "t1", cwd: "/a", prompt: "hi", agent: "claude" });
    const runId = m.startCalls[0]!.runId;
    // 模拟覆盖层已关闭:没有任何组件订阅,但订阅在模块级仍活着,事件继续折叠进 store。
    m.emitEvent(runId, { type: "text", delta: "回复内容" });
    m.emitExit({ runId, code: 0 });
    const msgs = useWritingRunStore.getState().messagesByThread.t1!;
    expect(msgs.some((x) => x.role === "assistant" && x.text === "回复内容")).toBe(true);
    // exit 后该空间不再忙碌。
    expect(writingSpaceBusy("ws-a")).toBe(false);
  });

  it("异常退出(code≠0)追加系统错误消息", async () => {
    const m = makeMockBridge();
    installWritingRuntime(m.bridge);
    await sendWritingMessage({ spaceId: "ws-a", threadId: "t1", cwd: "/a", prompt: "hi", agent: "claude" });
    const runId = m.startCalls[0]!.runId;
    m.emitExit({ runId, code: 1, error: "boom" });
    const msgs = useWritingRunStore.getState().messagesByThread.t1!;
    expect(msgs.some((x) => x.role === "system" && "severity" in x && x.severity === "error")).toBe(true);
  });
});
