// 纯函数单测（node 环境）：core 既有约定「只测纯函数」,hook 的 DOM 级行为（订阅/卸载退订）
// 由 U4 的 views 组件测试覆盖（views 本就有 react-dom/jsdom）。此处不用 renderHook。
import { describe, expect, it } from "vitest";
import type { CliStreamEvent } from "../desktop/types";
import {
  FOLLOWUP_SEED_MAX,
  applyFollowupEvent,
  buildFollowupPrompt,
  buildFollowupSystemPrompt,
  markTurnCancelled,
  markTurnDone,
  markTurnError,
  type FollowupApplyCtx,
  type FollowupState,
  type Turn,
} from "./followup";

const ctx: FollowupApplyCtx = { agent: "claude", time: "10:00", newUid: (p) => `${p}-uid` };

// 给每个 uid 唯一后缀,避免 foldCliEvent 多块时 uid 撞车（真实 hook 用随机+seq）。
function ctxSeq(): FollowupApplyCtx {
  let n = 0;
  return { agent: "claude", time: "10:00", newUid: (p) => `${p}-${(n += 1)}` };
}

function streamingTurn(id: string, question: string): Turn {
  return { id, question, status: "streaming", messages: [] };
}

function initState(turns: Turn[]): FollowupState {
  return { turns, cursors: {} };
}

// ── buildFollowupSystemPrompt ───────────────────────────────────────────────

describe("buildFollowupSystemPrompt", () => {
  it("短正文原样放进标注块", () => {
    const out = buildFollowupSystemPrompt("一段简短的历史回复");
    expect(out).toContain("<followup_seed>");
    expect(out).toContain("</followup_seed>");
    expect(out).toContain("一段简短的历史回复");
  });

  it("超长正文按正文级上限截断(远大于 200 摘要级)", () => {
    const long = "字".repeat(FOLLOWUP_SEED_MAX + 500);
    const out = buildFollowupSystemPrompt(long);
    expect(out).toContain("正文过长已截断");
    expect(out.includes("字".repeat(FOLLOWUP_SEED_MAX + 500))).toBe(false);
    // 远大于 200 摘要级:保留量应明显超过 200。
    expect(out.length).toBeGreaterThan(1000);
  });

  it("特殊字符不破坏块结构", () => {
    const out = buildFollowupSystemPrompt("含 < > & \"引号\" 和\n换行\n的正文");
    expect(out).toContain("<followup_seed>");
    expect(out).toContain("</followup_seed>");
    expect(out).toContain("含 < > & \"引号\"");
  });
});

// ── buildFollowupPrompt ─────────────────────────────────────────────────────

describe("buildFollowupPrompt", () => {
  const doneTurn = (question: string, answer: string): Turn => ({
    id: question,
    question,
    status: "done",
    messages: [{ kind: "text", who: "claude", time: "10:00", text: answer, uid: question }],
  });

  it("无历史时只返回新问题", () => {
    expect(buildFollowupPrompt([], "新问题")).toBe("新问题");
  });

  it("多轮历史按顺序串入 + 角色标注 + 新问题在末尾", () => {
    const turns = [doneTurn("第一问", "第一答"), doneTurn("第二问", "第二答")];
    const out = buildFollowupPrompt(turns, "第三问");
    const i1 = out.indexOf("第一问");
    const i2 = out.indexOf("第二问");
    const i3 = out.indexOf("第三问");
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(out.trimEnd().endsWith("第三问")).toBe(true);
    expect(out).toContain("<assistant>第一答</assistant>");
    expect(out).toContain("<user>第一问</user>");
  });

  it("指代上轮自身输出的追问:历史被标注为「你先前的回答」", () => {
    const turns = [doneTurn("解释一下 X", "X 是这样这样")];
    const out = buildFollowupPrompt(turns, "你上一句为什么这么说?再展开第 2 点");
    expect(out).toContain("你在本次追问会话中先前的回答");
    expect(out).toContain("<assistant>X 是这样这样</assistant>");
    expect(out.trimEnd().endsWith("你上一句为什么这么说?再展开第 2 点")).toBe(true);
  });

  it("未完成的轮(streaming/error/cancelled)不入历史", () => {
    const turns: Turn[] = [
      streamingTurn("a", "进行中问"),
      { id: "b", question: "出错问", status: "error", messages: [], error: "boom" },
    ];
    expect(buildFollowupPrompt(turns, "新问")).toBe("新问");
  });
});

// ── applyFollowupEvent（事件 → turns 纯 reducer） ────────────────────────────

describe("applyFollowupEvent", () => {
  it("代际守卫:activeAskId !== askId → 原样返回（旧 askId 迟到事件被丢弃）", () => {
    const state = initState([streamingTurn("cur", "问")]);
    const ev: CliStreamEvent = { type: "text", delta: "迟到污染" };
    const next = applyFollowupEvent(state, "cur", "old", ev, ctx);
    expect(next).toBe(state); // 引用相等 = 未变更
    expect(next.turns[0]!.messages).toHaveLength(0);
  });

  it("折叠 text→tool→text 产出三段(不退化两块)", () => {
    const c = ctxSeq();
    let state = initState([streamingTurn("a", "问")]);
    state = applyFollowupEvent(state, "a", "a", { type: "text", delta: "前文 " }, c);
    state = applyFollowupEvent(state, "a", "a", { type: "tool", name: "Read", detail: "x.ts" }, c);
    state = applyFollowupEvent(state, "a", "a", { type: "text", delta: "后文" }, c);

    const msgs = state.turns[0]!.messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatchObject({ kind: "text", text: "前文 " });
    expect(msgs[1]!.kind).toBe("agentLog");
    expect(msgs[2]).toMatchObject({ kind: "text", text: "后文" });
  });

  it("连续 text 增量并入同一块（验证 cursor 按 askId 持续）", () => {
    const c = ctxSeq();
    let state = initState([streamingTurn("a", "问")]);
    state = applyFollowupEvent(state, "a", "a", { type: "text", delta: "Hello " }, c);
    state = applyFollowupEvent(state, "a", "a", { type: "text", delta: "World" }, c);
    expect(state.turns[0]!.messages).toHaveLength(1);
    expect(state.turns[0]!.messages[0]).toMatchObject({ kind: "text", text: "Hello World" });
  });

  it("result.ok=true → 该轮 done", () => {
    let state = initState([streamingTurn("a", "问")]);
    state = applyFollowupEvent(state, "a", "a", { type: "text", delta: "答" }, ctx);
    state = applyFollowupEvent(state, "a", "a", { type: "result", ok: true }, ctx);
    expect(state.turns[0]!.status).toBe("done");
  });

  it("result.ok=false → 该轮 error 带文案", () => {
    let state = initState([streamingTurn("a", "问")]);
    state = applyFollowupEvent(state, "a", "a", { type: "result", ok: false, error: "炸了" }, ctx);
    expect(state.turns[0]!.status).toBe("error");
    expect(state.turns[0]!.error).toBe("炸了");
  });

  it("result.ok=false 无 error → 默认错误文案", () => {
    let state = initState([streamingTurn("a", "问")]);
    state = applyFollowupEvent(state, "a", "a", { type: "result", ok: false }, ctx);
    expect(state.turns[0]!.error).toBe("执行出错");
  });

  it("result 收尾时把仍打开的 agentLog 翻完成（停 spinner）", () => {
    const c = ctxSeq();
    let state = initState([streamingTurn("a", "问")]);
    state = applyFollowupEvent(state, "a", "a", { type: "tool", name: "Bash", detail: "ls" }, c);
    // 收尾前 agentLog 处于 active。
    expect(state.turns[0]!.messages[0]).toMatchObject({ kind: "agentLog", active: true });
    state = applyFollowupEvent(state, "a", "a", { type: "result", ok: true }, c);
    expect(state.turns[0]!.messages[0]).toMatchObject({ kind: "agentLog", active: false, completed: true });
  });

  it("init 等事件不改 turns/cursors（原样返回）", () => {
    const state = initState([streamingTurn("a", "问")]);
    const next = applyFollowupEvent(state, "a", "a", { type: "init", sessionId: "s1" }, ctx);
    expect(next).toBe(state);
  });
});

// ── 状态迁移纯函数 ──────────────────────────────────────────────────────────

describe("markTurnDone / markTurnError / markTurnCancelled", () => {
  it("markTurnDone:目标轮 → done,其它轮不动", () => {
    const turns = [streamingTurn("a", "问1"), streamingTurn("b", "问2")];
    const out = markTurnDone(turns, {}, "b");
    expect(out[0]!.status).toBe("streaming");
    expect(out[1]!.status).toBe("done");
  });

  it("markTurnError:写 error 文案", () => {
    const out = markTurnError([streamingTurn("a", "问")], {}, "a", "boom");
    expect(out[0]!.status).toBe("error");
    expect(out[0]!.error).toBe("boom");
  });

  it("markTurnCancelled:目标轮 → cancelled", () => {
    const out = markTurnCancelled([streamingTurn("a", "问")], {}, "a");
    expect(out[0]!.status).toBe("cancelled");
  });
});
