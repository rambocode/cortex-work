import { describe, it, expect, vi } from "vitest";
import {
  applyTaskMessage,
  isStaleGeneration,
  mapTaskStateToOutcome,
  messagesToConversation,
  getAvatarSession,
  withAvatarSession,
  initAvatarSession,
  avatarOutcomeBanner,
  buildAvatarConversationFromTurns,
  hasVisibleAvatarReply,
  AvatarSessionClient,
  type AvatarTaskMessageFrame,
} from "./session-stream";
import type { AvatarSessionOutcome } from "../desktop/avatar-types";
import type { AvatarConversationTurn } from "../api/types";
import type { Conversation } from "../types";

// 构造一帧 task_message（仅填测试关心的字段，其余给出合法占位）。
function frame(seq: number, patch: Partial<AvatarTaskMessageFrame> = {}): AvatarTaskMessageFrame {
  return {
    id: `m-${seq}`,
    task_id: "t1",
    seq,
    type: "text",
    tool: null,
    content: `c${seq}`,
    input: null,
    output: null,
    created_at: "",
    ...patch,
  };
}

describe("applyTaskMessage（保序插入 + 去重）", () => {
  it("乱序到达按 seq 升序落位", () => {
    let rows: AvatarTaskMessageFrame[] = [];
    rows = applyTaskMessage(rows, frame(3));
    rows = applyTaskMessage(rows, frame(1));
    rows = applyTaskMessage(rows, frame(2));
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("重复 seq 幂等去重（保留首条，不重复插入）", () => {
    let rows: AvatarTaskMessageFrame[] = [];
    rows = applyTaskMessage(rows, frame(1, { content: "first" }));
    rows = applyTaskMessage(rows, frame(1, { content: "dup" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("first");
  });

  it("返回新数组，不原地改旧引用", () => {
    const rows: AvatarTaskMessageFrame[] = [];
    const next = applyTaskMessage(rows, frame(1));
    expect(next).not.toBe(rows);
    expect(rows).toHaveLength(0);
  });
});

describe("isStaleGeneration（代际丢弃）", () => {
  it("旧代际事件判为过期", () => {
    expect(isStaleGeneration(2, 1)).toBe(true);
  });
  it("同代际不丢弃", () => {
    expect(isStaleGeneration(2, 2)).toBe(false);
  });
  it("未来代际（理论不该发生）不丢弃", () => {
    expect(isStaleGeneration(1, 2)).toBe(false);
  });
});

describe("mapTaskStateToOutcome（终态归一，契约 §1）", () => {
  it("completed → done", () => {
    expect(mapTaskStateToOutcome("completed", undefined, null)).toBe("done");
  });
  it("completed 且 result.outcome=unanswerable → unanswerable", () => {
    expect(mapTaskStateToOutcome("completed", undefined, { outcome: "unanswerable" })).toBe("unanswerable");
  });
  it("cancelled → canceled", () => {
    expect(mapTaskStateToOutcome("cancelled", undefined, null)).toBe("canceled");
  });
  it("failed + runtime_offline/runtime_recovery/share_revoked → interrupted", () => {
    expect(mapTaskStateToOutcome("failed", "runtime_offline", null)).toBe("interrupted");
    expect(mapTaskStateToOutcome("failed", "runtime_recovery", null)).toBe("interrupted");
    expect(mapTaskStateToOutcome("failed", "share_revoked", null)).toBe("interrupted");
  });
  it("failed + approval_rejected → rejected_approval", () => {
    expect(mapTaskStateToOutcome("failed", "approval_rejected", null)).toBe("rejected_approval");
  });
  it("failed + approval_timeout → timeout_approval", () => {
    expect(mapTaskStateToOutcome("failed", "approval_timeout", null)).toBe("timeout_approval");
  });
  it("failed + 其它/无 reason → failed", () => {
    expect(mapTaskStateToOutcome("failed", "agent_error", null)).toBe("failed");
    expect(mapTaskStateToOutcome("failed", undefined, null)).toBe("failed");
  });
  it("非终态 status → null", () => {
    expect(mapTaskStateToOutcome("running", undefined, null)).toBeNull();
  });
});

describe("messagesToConversation（帧 → Message[]）", () => {
  it("text 增量按 seq 顺序拼成一条回答气泡", () => {
    let rows: AvatarTaskMessageFrame[] = [];
    rows = applyTaskMessage(rows, frame(2, { content: "世界" }));
    rows = applyTaskMessage(rows, frame(1, { content: "你好" }));
    const msgs = messagesToConversation(rows, { who: "avatar" });
    const text = msgs.find((m) => m.kind === "text");
    expect(text && text.kind === "text" && text.text).toBe("你好世界");
    expect(text && text.kind === "text" && text.who).toBe("avatar");
  });

  it("thinking 帧 → reasoning 消息，且排在正文前", () => {
    let rows: AvatarTaskMessageFrame[] = [];
    rows = applyTaskMessage(rows, frame(1, { type: "thinking", content: "让我想想" }));
    rows = applyTaskMessage(rows, frame(2, { type: "text", content: "答案" }));
    const msgs = messagesToConversation(rows, { who: "avatar" });
    expect(msgs[0]!.kind).toBe("reasoning");
    expect(msgs.some((m) => m.kind === "text")).toBe(true);
  });

  it("avatar_status.waiting_approval → 「等待拥有者确认」文案（复用 text kind）", () => {
    let rows: AvatarTaskMessageFrame[] = [];
    rows = applyTaskMessage(rows, frame(1, { type: "avatar_status", content: null, input: { state: "waiting_approval" } }));
    const msgs = messagesToConversation(rows, { who: "avatar" });
    expect(msgs.some((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("等待拥有者确认"))).toBe(true);
  });

  it("result 帧在无 text 增量时作为最终答案", () => {
    let rows: AvatarTaskMessageFrame[] = [];
    rows = applyTaskMessage(rows, frame(1, { type: "result", content: "最终答案" }));
    const msgs = messagesToConversation(rows, { who: "avatar" });
    const text = msgs.find((m) => m.kind === "text");
    expect(text && text.kind === "text" && text.text).toBe("最终答案");
  });

  it("tool 帧 → agentLog 步骤", () => {
    let rows: AvatarTaskMessageFrame[] = [];
    rows = applyTaskMessage(rows, frame(1, { type: "tool", tool: "read_file", content: null }));
    const msgs = messagesToConversation(rows, { who: "avatar" });
    expect(msgs.some((m) => m.kind === "agentLog")).toBe(true);
  });

  it("tool_use 帧兼容服务端真实消息类型并渲染为 agentLog 步骤", () => {
    let rows: AvatarTaskMessageFrame[] = [];
    rows = applyTaskMessage(rows, frame(1, { type: "tool_use", tool: "bash", content: null }));
    const msgs = messagesToConversation(rows, { who: "avatar" });
    const log = msgs.find((m) => m.kind === "agentLog");
    expect(log && log.kind === "agentLog" && log.items[0]?.text).toBe("bash");
  });
});

describe("hasVisibleAvatarReply", () => {
  it("text/result/error 正文视为可见回复", () => {
    expect(hasVisibleAvatarReply([frame(1, { type: "text", content: "答案" })])).toBe(true);
    expect(hasVisibleAvatarReply([frame(1, { type: "result", content: "最终答案" })])).toBe(true);
    expect(hasVisibleAvatarReply([frame(1, { type: "error", content: "执行失败" })])).toBe(true);
  });

  it("thinking/tool_use/tool_result 不视为可见回复", () => {
    expect(hasVisibleAvatarReply([frame(1, { type: "thinking", content: "分析中" })])).toBe(false);
    expect(hasVisibleAvatarReply([frame(1, { type: "tool_use", tool: "bash", content: null })])).toBe(false);
    expect(hasVisibleAvatarReply([frame(1, { type: "tool_result", tool: "bash", output: "ok", content: null })])).toBe(false);
  });
});

describe("AvatarSessionState 读写（挂在 Conversation 上）", () => {
  const base: Conversation = { headerStatus: { dot: "online", text: "" }, metaRow: [], messages: [] };

  it("initAvatarSession 给出全新非终态会话态", () => {
    const s = initAvatarSession(5);
    expect(s.generation).toBe(5);
    expect(s.outcome).toBeNull();
    expect(s.phase).toBe("accepted");
  });

  it("withAvatarSession 写入后 getAvatarSession 读回", () => {
    const s = initAvatarSession(1);
    const convo = withAvatarSession(base, s);
    expect(getAvatarSession(convo)).toEqual(s);
    // 不改原对象引用
    expect(convo).not.toBe(base);
  });

  it("无 avatarSession 的普通会话读回 null", () => {
    expect(getAvatarSession(base)).toBeNull();
  });
});

describe("avatarOutcomeBanner（8 终态文案映射）", () => {
  it("done → null（无横幅）", () => {
    expect(avatarOutcomeBanner("done")).toBeNull();
    expect(avatarOutcomeBanner(null)).toBeNull();
  });

  it("其余 7 终态各有文案，且互不雷同", () => {
    const outcomes: AvatarSessionOutcome[] = [
      "unanswerable",
      "rejected_quota",
      "rejected_approval",
      "timeout_approval",
      "canceled",
      "interrupted",
      "failed",
    ];
    const texts = outcomes.map((o) => avatarOutcomeBanner(o));
    // 全部非空
    expect(texts.every((t) => typeof t === "string" && t!.length > 0)).toBe(true);
    // 互不雷同（去重后条数不变）
    expect(new Set(texts).size).toBe(outcomes.length);
  });
});

// ── AvatarSessionClient：用注入的 fake WebSocket 验证握手/订阅/分发 ──
class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  readyState = 0;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // 测试驱动：模拟服务端下发一帧
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

describe("buildAvatarConversationFromTurns（多轮会话历史组装）", () => {
  // 构造一轮（prompt + 若干 text 帧 + 终态）。
  function turn(taskId: string, prompt: string, answer: string, outcome: AvatarSessionOutcome | null): AvatarConversationTurn {
    return {
      turn_id: taskId,
      task_id: taskId,
      prompt,
      phase: "running",
      outcome,
      created_at: "",
      messages: [{ turn_id: taskId, task_id: taskId, seq: 0, type: "text", content: answer }],
    };
  }

  it("两轮 → messages 依次 [问1,答1,问2,答2]，终态会话 taskId 置空", () => {
    const convo = buildAvatarConversationFromTurns(
      [turn("ta", "问1", "答1", "done"), turn("tb", "问2", "答2", "done")],
      { who: "设计师" },
    );
    // 用户提问在 me 侧;分身回复正文在 avatar 侧。仅取 text kind 的正文(排除 day 分隔等)。
    const texts = convo.messages
      .map((m) => (m.kind === "text" && typeof m.text === "string" ? m.text : ""))
      .filter(Boolean);
    expect(texts).toEqual(["问1", "答1", "问2", "答2"]);
    const st = getAvatarSession(convo);
    expect(st?.taskId).toBeNull(); // 最后一轮终态 → 无在途
    expect(st?.outcome).toBe("done");
  });

  it("最后一轮在途 → 保留其 taskId/phase，replyAnchor 落在最后一轮提问后", () => {
    const convo = buildAvatarConversationFromTurns([
      turn("ta", "问1", "答1", "done"),
      turn("tb", "问2", "进行中…", null),
    ]);
    const st = getAvatarSession(convo);
    expect(st?.taskId).toBe("tb");
    expect(st?.phase).toBe("running");
    expect(st?.outcome).toBeNull();
    // messages: [问1, 答1, 问2, 进行中…] → 最后一轮提问「问2」下标为 2,回复起点 anchor=3。
    expect(st?.replyAnchor).toBe(3);
  });

  it("空 turns → 空会话（无在途、outcome null）", () => {
    const convo = buildAvatarConversationFromTurns([]);
    const st = getAvatarSession(convo);
    expect(convo.messages).toEqual([]);
    expect(st?.taskId).toBeNull();
    expect(st?.outcome).toBeNull();
  });
});

describe("AvatarSessionClient", () => {
  it("连接后先发 auth 首帧；auth_ack 后 subscribe 已登记的 task", () => {
    const sock = new FakeSocket();
    const client = new AvatarSessionClient({
      url: "wss://x/ws?workspace_id=w1",
      token: "mul_abc",
      socketFactory: () => sock as unknown as WebSocket,
    });
    client.connect();
    client.subscribeTask("task-1");
    sock.open();
    // 首帧必须是 auth
    const first = JSON.parse(sock.sent[0]!);
    expect(first).toEqual({ type: "auth", payload: { token: "mul_abc" } });
    // auth 前不应发 subscribe
    expect(sock.sent.some((s) => s.includes("subscribe"))).toBe(false);
    sock.emit({ type: "auth_ack" });
    // auth_ack 后补发 subscribe
    const sub = sock.sent.map((s) => JSON.parse(s)).find((m) => m.type === "subscribe");
    expect(sub).toEqual({ type: "subscribe", payload: { scope: "task", id: "task-1" } });
  });

  it("avatar:task_message 分发到 onTaskMessage 回调", () => {
    const sock = new FakeSocket();
    const onMsg = vi.fn();
    const client = new AvatarSessionClient({
      url: "wss://x/ws",
      token: "t",
      socketFactory: () => sock as unknown as WebSocket,
      onTaskMessage: onMsg,
    });
    client.connect();
    sock.open();
    sock.emit({ type: "auth_ack" });
    sock.emit({
      type: "avatar:task_message",
      actor_id: "",
      actor_type: "system",
      payload: { task_id: "t1", seq: 1, type: "text", content: "hi", caller_id: "c1" },
    });
    expect(onMsg).toHaveBeenCalledTimes(1);
    expect(onMsg.mock.calls[0]![0]).toMatchObject({ task_id: "t1", seq: 1, type: "text" });
  });

  it("avatar:task_state 分发到 onTaskState 回调", () => {
    const sock = new FakeSocket();
    const onState = vi.fn();
    const client = new AvatarSessionClient({
      url: "wss://x/ws",
      token: "t",
      socketFactory: () => sock as unknown as WebSocket,
      onTaskState: onState,
    });
    client.connect();
    sock.open();
    sock.emit({ type: "auth_ack" });
    sock.emit({
      type: "avatar:task_state",
      actor_id: "",
      actor_type: "system",
      payload: { task_id: "t1", caller_id: "c1", status: "completed", outcome: "done" },
    });
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ task_id: "t1", status: "completed" }));
  });

  it("unsubscribeTask 发送 unsubscribe 帧", () => {
    const sock = new FakeSocket();
    const client = new AvatarSessionClient({
      url: "wss://x/ws",
      token: "t",
      socketFactory: () => sock as unknown as WebSocket,
    });
    client.connect();
    sock.open();
    sock.emit({ type: "auth_ack" });
    client.subscribeTask("t1");
    client.unsubscribeTask("t1");
    const unsub = sock.sent.map((s) => JSON.parse(s)).find((m) => m.type === "unsubscribe");
    expect(unsub).toEqual({ type: "unsubscribe", payload: { scope: "task", id: "t1" } });
  });
});
