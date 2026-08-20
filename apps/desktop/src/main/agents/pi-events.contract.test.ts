// mapPiEvent 的**事件契约锁**（迁移计划 U0 / R2 / KTD5）。
//
// 本文件守的是「AgentEvent → PiSessionEvent 的语义映射」（gateway 引擎的事件语义根基），
// 喂的是 pi 0.82.1 AgentEvent 的**完整形状**（含 partial / message / toolResults 等
// mapPiEvent 不消费但真实存在的字段）。
//
// 为什么需要这一道锁：事件的**来源**是「主进程/worker 内 AgentSession.subscribe() 直接拿对象」
// （历史上曾是 spawn 二进制 + 读 stdout JSONL 的 JSON.parse 产物），但 mapPiEvent 的**语义**
// 必须逐条不变，否则渲染端会静默丢事件（最典型：丢掉终态 → 永久卡「思考中」）。
// 所以这里刻意喂完整对象，断言映射只依赖已约定的字段、不因多出来的字段而改变行为。
//
// 覆盖面：AgentEvent 十类顶层事件各有一条基线断言（BASELINE_CASES，缺一即结构性失败），
// 外加 message_end 的 error|aborted 错误路径（KTD5：run 失败**只**体现在这里，
// in-process 下更没有进程退出码可依赖）与忽略清单（与 pi.ts 的 IGNORED_FRAME_TYPES 同源）。

import { describe, expect, it, vi } from "vitest";

// 这里只测纯函数 mapPiEvent，桩掉 log 避免加载真日志链路。
vi.mock("../log", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn(),
  }),
  isDevEnv: () => true,
}));

import { mapPiEvent } from "./pi-inproc/rpc-shared";
import type { PiSessionEvent } from "../ipc/types";

// AgentEvent 的十类顶层事件（pi 0.82.1）。BASELINE_CASES 必须逐类给出基线断言。
const AGENT_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
] as const;

/**
 * 一条完整的 assistant message 骨架（AgentEvent 里 message / partial 字段的真实形状）。
 * mapPiEvent 只读 stopReason / errorMessage / usage / diagnostics，其余字段存在也不得干扰映射——
 * 这正是本文件要证的东西，所以骨架刻意写满。
 */
function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    api: "anthropic",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "你好" }],
    usage: { input: 120, output: 30, cacheRead: 4000, cacheWrite: 0 },
    timestamp: 1_754_000_000_000,
    stopReason: "stop",
    ...overrides,
  };
}

/**
 * 十类事件的基线映射表：类型 → {完整事件, 期望输出}。
 * 用 Record 而非数组，是为了让「新增一类却忘了写断言」在下方 exhaustiveness 里结构性失败，
 * 而不是靠人肉数条目。
 */
const BASELINE_CASES: Record<
  (typeof AGENT_EVENT_TYPES)[number],
  { why: string; event: Record<string, unknown>; expected: PiSessionEvent | null }
> = {
  // ── 三类纯生命周期边界：Cortex 的 UI 状态机由 prompt 发起侧驱动，不消费它们。
  //    迁移后 AgentSession.subscribe 照样投递，映射必须继续返回 null，否则渲染端凭空多出事件。
  agent_start: {
    why: "run 开始的边界标记，不产事件",
    event: { type: "agent_start", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    expected: null,
  },
  turn_start: {
    why: "单次模型调用开始 → step-start，会话统计条的 TTFT / LLM 耗时以它为 0 点",
    event: { type: "turn_start", messages: [], model: { id: "claude-sonnet-4-5", provider: "anthropic" } },
    expected: { type: "step-start" },
  },
  message_start: {
    why: "assistant message 开始的边界标记，不产事件",
    event: { type: "message_start", partial: assistantMessage({ content: [] }) },
    expected: null,
  },
  // ── 增量与终态
  message_update: {
    why: "text_delta → text 增量（只取 delta，partial 不参与）",
    event: {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "第一段",
        partial: assistantMessage({ content: [{ type: "text", text: "第一段" }] }),
      },
      message: assistantMessage(),
    },
    expected: { type: "text", delta: "第一段" },
  },
  message_end: {
    why: "stopReason=stop 是最终边界，产 result 兜住 pi 偶发缺 agent_end；usage 刻意不带（紧随其后的 turn_end 携带同一份，带上会双计）",
    event: { type: "message_end", message: assistantMessage({ stopReason: "stop" }) },
    expected: { type: "result", willRetry: false, stopReason: "stop" },
  },
  turn_end: {
    why: "透出该次模型调用的 usage（含互斥的缓存读/写桶），供同一用户回合累加",
    event: {
      type: "turn_end",
      message: assistantMessage({ usage: { input: 13, output: 4, cacheRead: 9, cacheWrite: 1 } }),
      toolResults: [{ toolCallId: "call_0", content: [{ type: "text", text: "ok" }] }],
    },
    expected: {
      type: "turn-end",
      usage: { inputTokens: 13, outputTokens: 4, cacheReadTokens: 9, cacheWriteTokens: 1 },
    },
  },
  agent_end: {
    why: "一次 run 结束的权威终态，willRetry 透传给渲染端决定是否继续转圈",
    event: { type: "agent_end", messages: [assistantMessage()], willRetry: false },
    expected: { type: "result", willRetry: false },
  },
  // ── 工具执行三类
  tool_execution_start: {
    why: "工具行起点：name/toolCallId/detail/input 四件套",
    event: {
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "call_0",
      args: { command: "rg NEEDLE .", timeout: 30_000 },
    },
    expected: {
      type: "tool-start",
      name: "bash",
      toolCallId: "call_0",
      detail: "rg NEEDLE .",
      input: { command: "rg NEEDLE .", timeout: 30_000 },
    },
  },
  tool_execution_update: {
    why: "十类里唯一完全不消费的一类（bash 输出增量等中间态），必须保持 null",
    event: { type: "tool_execution_update", toolCallId: "call_0", toolName: "bash", delta: "partial stdout\n" },
    expected: null,
  },
  tool_execution_end: {
    why: "工具行终点：isError 归一为布尔，result 归一为 output 文本",
    event: {
      type: "tool_execution_end",
      toolName: "grep",
      toolCallId: "call_1",
      args: { pattern: "NEEDLE" },
      isError: false,
      result: { content: [{ type: "text", text: "hello.txt:2: NEEDLE" }] },
    },
    expected: { type: "tool-end", name: "grep", toolCallId: "call_1", isError: false, output: "hello.txt:2: NEEDLE" },
  },
};

describe("AgentEvent 十类基线映射（迁移后逐条不变）", () => {
  it("BASELINE_CASES 覆盖十类事件，无遗漏无多余", () => {
    expect(Object.keys(BASELINE_CASES).sort()).toEqual([...AGENT_EVENT_TYPES].sort());
  });

  it.each(AGENT_EVENT_TYPES)("%s", (type) => {
    const { event, expected, why } = BASELINE_CASES[type];
    // why 进断言消息：失败时直接看到「这条映射存在的理由」，不用回来翻表。
    expect(mapPiEvent(event), why).toEqual(expected);
  });
});

describe("message_update 增量", () => {
  it("thinking_delta → reasoning 增量（reasoning 模型的思考流，与正文分道）", () => {
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "先看一下文件",
          partial: assistantMessage({ content: [{ type: "thinking", thinking: "先看一下文件" }] }),
        },
      }),
    ).toEqual({ type: "reasoning", delta: "先看一下文件" });
  });

  it("空字符串 delta 仍产事件；非字符串 delta → null", () => {
    expect(mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } })).toEqual({
      type: "text",
      delta: "",
    });
    expect(mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: 42 } })).toBeNull();
    expect(
      mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: null } }),
    ).toBeNull();
  });

  it("message_update/error → error 事件（防御性分支：errorMessage 优先，回退 reason）", () => {
    // 实测 pi 0.79.2/0.82.1 的错误不走这里（走 message_end），保留分支以防协议变体。
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "error", reason: "error", error: { errorMessage: "provider failed" } },
      }),
    ).toEqual({ type: "error", error: "provider failed" });
    expect(mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "error", reason: "aborted" } })).toEqual({
      type: "error",
      error: "aborted",
    });
    expect(mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "error" } })).toEqual({
      type: "error",
      error: "error",
    });
  });

  it("生命周期与 toolcall 子事件 → null（与 pi.ts 的 IGNORED_MESSAGE_UPDATE_SUBTYPES 同源）", () => {
    // text/thinking 的 start-end 只是流边界；toolcall_* 增量已被顶层 tool_execution_start 覆盖，
    // 这里再产事件会导致工具行重复渲染。
    for (const sub of [
      "start",
      "text_start",
      "text_end",
      "thinking_start",
      "thinking_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]) {
      expect(mapPiEvent({ type: "message_update", assistantMessageEvent: { type: sub, contentIndex: 0 } })).toBeNull();
    }
  });

  it("assistantMessageEvent 缺失或非对象 → null（不抛）", () => {
    expect(mapPiEvent({ type: "message_update" })).toBeNull();
    expect(mapPiEvent({ type: "message_update", assistantMessageEvent: null })).toBeNull();
    expect(mapPiEvent({ type: "message_update", assistantMessageEvent: "text_delta" })).toBeNull();
  });
});

describe("message_end 的错误路径（KTD5 红线）", () => {
  // ⚠️ 迁移中最容易丢的一段语义。in-process 后没有进程退出码可依赖，坏 key / 限流 /
  // provider 挂 / 用户 abort **全部**只体现在这里的 stopReason 上，且不抛异常
  // （spike 实测：streamFn 契约不符 → "response.result is not a function" 被吞进这里）。
  // 这几条断言若被删掉或放宽，表现是「点了发送、转圈、永远没有下文，也没有报错」。
  it("stopReason=error 且有 errorMessage → error（优先取 errorMessage）", () => {
    expect(
      mapPiEvent({
        type: "message_end",
        message: assistantMessage({
          stopReason: "error",
          errorMessage: "401 invalid x-api-key",
          content: [],
          diagnostics: [{ type: "provider_transport_failure", error: { message: "WebSocket error" } }],
        }),
      }),
    ).toEqual({ type: "error", error: "401 invalid x-api-key" });
  });

  it("stopReason=error 且无 errorMessage → 回退 diagnostics **末项**的 error.message", () => {
    expect(
      mapPiEvent({
        type: "message_end",
        message: assistantMessage({
          stopReason: "error",
          content: [],
          diagnostics: [
            { type: "provider_transport_failure", error: { message: "第一次失败" } },
            { type: "provider_transport_failure", error: { message: "最后一次失败" } },
          ],
        }),
      }),
    ).toEqual({ type: "error", error: "最后一次失败" });
  });

  it("stopReason=error 且两者皆无 → 回退 stopReason 文本（绝不返回 null）", () => {
    expect(mapPiEvent({ type: "message_end", message: assistantMessage({ stopReason: "error", content: [] }) })).toEqual(
      { type: "error", error: "error" },
    );
  });

  it("stopReason=aborted → error 事件（用户中断也走错误通道，渲染端据此收尾）", () => {
    expect(
      mapPiEvent({ type: "message_end", message: assistantMessage({ stopReason: "aborted", content: [] }) }),
    ).toEqual({ type: "error", error: "aborted" });
    expect(mapPiEvent({ type: "message_end", message: { stopReason: "aborted", errorMessage: "用户取消" } })).toEqual({
      type: "error",
      error: "用户取消",
    });
  });

  it("diagnostics 形状异常时不抛，退回 stopReason 文本", () => {
    for (const diagnostics of [[], "boom", [{}], [{ error: {} }], [{ error: { message: 42 } }]]) {
      expect(mapPiEvent({ type: "message_end", message: { stopReason: "error", diagnostics } })).toEqual({
        type: "error",
        error: "error",
      });
    }
  });
});

describe("message_end 的正常收尾", () => {
  it("stopReason=length → 带 truncated 的 result（无 usage 时省略 usage 字段而非给 undefined）", () => {
    expect(mapPiEvent({ type: "message_end", message: { stopReason: "length" } })).toEqual({
      type: "result",
      willRetry: false,
      stopReason: "length",
      truncated: true,
    });
  });

  it("length 且 assistant 带 toolCall 不提前收尾，等待 agent_end 判断续跑", () => {
    expect(
      mapPiEvent({
        type: "message_end",
        message: assistantMessage({ stopReason: "length", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] }),
      }),
    ).toBeNull();
  });

  it("stopReason=toolUse → null（工具调用中间边界，收尾会让渲染端提前结束回合）", () => {
    expect(
      mapPiEvent({ type: "message_end", message: assistantMessage({ stopReason: "toolUse", content: [] }) }),
    ).toBeNull();
  });

  it("agent_end context-checkpoint → willRetry result，renderer 保留同一 user run", () => {
    expect(mapPiEvent({ type: "agent_end", messages: [], reason: "context-checkpoint", willRetry: true })).toEqual({
      type: "result",
      willRetry: true,
      stopReason: "context-checkpoint",
    });
  });

  it("未知 stopReason / 缺 message → null（盲区，由 pi-rpc 的 warn 埋点观测）", () => {
    expect(mapPiEvent({ type: "message_end", message: { stopReason: "mystery" } })).toBeNull();
    expect(mapPiEvent({ type: "message_end" })).toBeNull();
  });
});

describe("turn_end / agent_end 终态补充", () => {
  it("turn_end 无 usage → turn-end 不带 usage 字段", () => {
    expect(mapPiEvent({ type: "turn_end", message: {}, toolResults: [] })).toEqual({ type: "turn-end" });
  });

  it("agent_end 的 willRetry 透传；缺省按 false", () => {
    expect(mapPiEvent({ type: "agent_end", messages: [], willRetry: true })).toEqual({
      type: "result",
      willRetry: true,
    });
    expect(mapPiEvent({ type: "agent_end", messages: [] })).toEqual({ type: "result", willRetry: false });
  });

  it("agent_settled → settled（pi 漏发 agent_end 时的终态兜底）", () => {
    expect(mapPiEvent({ type: "agent_settled" })).toEqual({ type: "settled" });
  });
});

describe("工具执行事件的细节契约", () => {
  it("detail 取值优先级：command → file_path → path → pattern → url，超长截断", () => {
    // ⚠️ KTD4：pi-agent-core 的 read 工具用 path，CLI 版用 file_path。detail 两者都取，
    // 所以 in-process 迁移后这一格不会退化——但这是唯一被兼容住的消费点，别把它改窄。
    const detail = (args: Record<string, unknown>) =>
      (mapPiEvent({ type: "tool_execution_start", toolName: "t", toolCallId: "c", args }) as { detail?: string })
        ?.detail;
    expect(detail({ command: "ls", file_path: "/a", path: "/b" })).toBe("ls");
    expect(detail({ file_path: "/a", path: "/b" })).toBe("/a");
    expect(detail({ path: "/b", pattern: "p" })).toBe("/b");
    expect(detail({ pattern: "p", url: "u" })).toBe("p");
    expect(detail({ url: "https://example.com" })).toBe("https://example.com");
    const long = detail({ command: "x".repeat(200) })!;
    expect(long.length).toBe(81); // 80 + 省略号
    expect(long.endsWith("…")).toBe(true);
  });

  it("无可读 args → 省略 detail，但 input 仍完整透传（运行过程详情视图需要）", () => {
    expect(mapPiEvent({ type: "tool_execution_start", toolName: "t", toolCallId: "c", args: {} })).toEqual({
      type: "tool-start",
      name: "t",
      toolCallId: "c",
      input: {},
    });
  });

  it("tool_execution_update 的其它形状同样 → null（未来做实时输出的接入点）", () => {
    // 在接实时输出之前必须保持 null，否则每个 delta 都会变成一条 IPC 事件。
    expect(mapPiEvent({ type: "tool_execution_update", toolCallId: "call_0", update: { kind: "progress" } })).toBeNull();
    expect(mapPiEvent({ type: "tool_execution_update" })).toBeNull();
  });

  it("result 归一化：string 原样 / 多 text 块换行拼接 / 非 text 块跳过 / 空对象无 output / 超长截断", () => {
    const end = (result: unknown) =>
      mapPiEvent({ type: "tool_execution_end", toolName: "bash", toolCallId: "c", isError: false, result }) as {
        output?: string;
      };
    expect(end("raw out").output).toBe("raw out");
    expect(
      end({ content: [{ type: "text", text: "l1" }, { type: "image", data: "..." }, { type: "text", text: "l2" }] })
        .output,
    ).toBe("l1\nl2");
    expect(end({}).output).toBeUndefined();
    expect(end(null).output).toBeUndefined();
    const truncated = end("z".repeat(20_000)).output!;
    expect(truncated.length).toBe(8_001); // 8000 + 省略号
    expect(truncated.endsWith("…")).toBe(true);
  });

  it("isError 归一为布尔（真值/假值均不透传原始类型）", () => {
    expect(mapPiEvent({ type: "tool_execution_end", toolName: "edit", toolCallId: "c", isError: true })).toEqual({
      type: "tool-end",
      name: "edit",
      toolCallId: "c",
      isError: true,
    });
    expect(mapPiEvent({ type: "tool_execution_end", toolName: "edit", toolCallId: "c" })).toEqual({
      type: "tool-end",
      name: "edit",
      toolCallId: "c",
      isError: false,
    });
  });

  it("缺 toolName 或 toolCallId → null（不产半截工具行）", () => {
    expect(mapPiEvent({ type: "tool_execution_start", toolCallId: "c", args: {} })).toBeNull();
    expect(mapPiEvent({ type: "tool_execution_start", toolName: "bash", args: {} })).toBeNull();
    expect(mapPiEvent({ type: "tool_execution_end", toolCallId: "c", isError: false })).toBeNull();
    expect(mapPiEvent({ type: "tool_execution_end", toolName: "bash", isError: false })).toBeNull();
  });

  it("todo_write 特判：start → todo 整表快照；end 被吞掉；空清单不产事件", () => {
    // 任务清单工具走独立展示通道，不进过程流。迁移到 customTools 注册后工具名必须仍是 todo_write，
    // 否则这条特判失效，用户会看到一堆 todo_write 工具行而任务清单不更新。
    expect(
      mapPiEvent({
        type: "tool_execution_start",
        toolName: "todo_write",
        toolCallId: "call_t",
        args: {
          todos: [
            { text: "分析", status: "completed" },
            { text: "实现", status: "in_progress" },
          ],
        },
      }),
    ).toEqual({
      type: "todo",
      todos: [
        { text: "分析", status: "completed" },
        { text: "实现", status: "in_progress" },
      ],
    });
    expect(
      mapPiEvent({ type: "tool_execution_end", toolName: "todo_write", toolCallId: "call_t", isError: false, result: {} }),
    ).toBeNull();
    expect(
      mapPiEvent({ type: "tool_execution_start", toolName: "todo_write", toolCallId: "call_t", args: { todos: [] } }),
    ).toBeNull();
  });

  it("artifacts 特判：start 被吞；end 成功从 result.details 派生 artifact 事件（全量快照）", () => {
    // 这条同时把「pi 0.82.1 emitToolExecutionEnd 原样透传 AgentToolResult.details」的依赖
    // 锁进结构性测试——pi 升级若剥离 details，这里会先红（兜底方案见 artifacts-tool.ts 文件头）。
    expect(
      mapPiEvent({
        type: "tool_execution_start",
        toolName: "artifacts",
        toolCallId: "call_a",
        args: { command: "create", filename: "a.html", content: "<h1>hi</h1>" },
      }),
    ).toBeNull();
    expect(
      mapPiEvent({
        type: "tool_execution_end",
        toolName: "artifacts",
        toolCallId: "call_a",
        isError: false,
        result: {
          content: [{ type: "text", text: "Created a.html" }],
          details: { artifact: { action: "create", filename: "a.html", content: "<h1>hi</h1>" } },
        },
      }),
    ).toEqual({ type: "artifact", action: "create", filename: "a.html", content: "<h1>hi</h1>" });
  });

  it("artifacts 的 end 失败（isError）或无 details.artifact（get / 形状漂移）→ null，不产事件", () => {
    expect(
      mapPiEvent({
        type: "tool_execution_end",
        toolName: "artifacts",
        toolCallId: "call_a",
        isError: true,
        result: { content: [{ type: "text", text: "Error: File a.html already exists" }] },
      }),
    ).toBeNull();
    // get：状态未变更，details 为 undefined。
    expect(
      mapPiEvent({
        type: "tool_execution_end",
        toolName: "artifacts",
        toolCallId: "call_a",
        isError: false,
        result: { content: [{ type: "text", text: "<h1>hi</h1>" }], details: undefined },
      }),
    ).toBeNull();
    // 形状漂移（action 非法）同样吞掉。
    expect(
      mapPiEvent({
        type: "tool_execution_end",
        toolName: "artifacts",
        toolCallId: "call_a",
        isError: false,
        result: { details: { artifact: { action: "rename", filename: "a.html" } } },
      }),
    ).toBeNull();
  });

  it("artifacts 的 delete 事件无 content 字段", () => {
    expect(
      mapPiEvent({
        type: "tool_execution_end",
        toolName: "artifacts",
        toolCallId: "call_a",
        isError: false,
        result: { details: { artifact: { action: "delete", filename: "a.html" } } },
      }),
    ).toEqual({ type: "artifact", action: "delete", filename: "a.html" });
  });
});

describe("忽略清单（与 pi.ts IGNORED_FRAME_TYPES 同源，改动须两边同步）", () => {
  // 这些是 pi 0.82.1 明确评审过、**有意不映射**的事件。必须映射为 null 而非「未识别」——
  // 区别在于：未识别会被 agents/index.ts 的盲区补点告警刷屏，把真正的协议漂移信号淹掉。
  it("pi 0.82.1 新增但不消费的事件 → null", () => {
    for (const type of [
      "entry_appended", // pi 侧 session JSONL 逐条追加；Cortex 自持消息流，不据此重建
      "bash_execution_update", // bash 输出增量；实时输出功能的未来接入点
      "summarization_retry_scheduled",
      "summarization_retry_attempt_start",
      "summarization_retry_finished",
    ]) {
      expect(mapPiEvent({ type, payload: { anything: true } })).toBeNull();
    }
  });

  it("RPC 传输层帧与已知边界帧 → null（response / auto_retry_end）", () => {
    // response 是命令应答，由 PiRpcSession 按 id 结算；in-process 后这类帧不再存在，
    // 但映射仍须容忍——灰度期（R3）二进制路径与引擎层共用同一个 mapPiEvent。
    expect(mapPiEvent({ type: "response", id: "1", command: "get_state", success: true })).toBeNull();
    expect(mapPiEvent({ type: "auto_retry_end", attempt: 1 })).toBeNull();
  });

  it("完全未知的事件类型 / 非对象入参 → null 且不抛（前向兼容 pi 升级）", () => {
    expect(mapPiEvent({ type: "brand_new_event_from_future", data: 1 })).toBeNull();
    expect(mapPiEvent(null)).toBeNull();
    expect(mapPiEvent(undefined)).toBeNull();
    expect(mapPiEvent("agent_end")).toBeNull();
    expect(mapPiEvent(42)).toBeNull();
    expect(mapPiEvent([])).toBeNull();
    expect(mapPiEvent({})).toBeNull();
  });
});

describe("其余已消费事件（非 AgentEvent 十类，但同经 mapPiEvent，灰度期不得漂移）", () => {
  it("compaction_start / compaction_end → compaction（phase + reason）", () => {
    expect(mapPiEvent({ type: "compaction_start", reason: "threshold" })).toEqual({
      type: "compaction",
      phase: "start",
      reason: "threshold",
    });
    expect(mapPiEvent({ type: "compaction_end", reason: "manual", aborted: false })).toEqual({
      type: "compaction",
      phase: "end",
      reason: "manual",
    });
    expect(mapPiEvent({ type: "compaction_start" })).toEqual({ type: "compaction", phase: "start" });
  });

  it("auto_retry_start → retry；queue_update → queue（只统计数量）", () => {
    expect(
      mapPiEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: "429" }),
    ).toEqual({ type: "retry", attempt: 2, maxAttempts: 5, error: "429" });
    expect(mapPiEvent({ type: "queue_update", steering: ["a", "b"], followUp: ["c"] })).toEqual({
      type: "queue",
      steering: 2,
      followUp: 1,
    });
  });

  it("session_info_changed / thinking_level_changed → 状态事件", () => {
    expect(mapPiEvent({ type: "session_info_changed", name: "调试会话" })).toEqual({
      type: "session-info",
      name: "调试会话",
    });
    expect(mapPiEvent({ type: "thinking_level_changed", level: "high" })).toEqual({
      type: "thinking-level",
      level: "high",
    });
    expect(mapPiEvent({ type: "thinking_level_changed" })).toBeNull();
  });
});
