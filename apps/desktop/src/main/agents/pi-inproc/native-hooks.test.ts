// 原生能力注入层单测。三条主线：
//   1. 审批 hook 与旧 `renderApprovalExtension()` 的行为逐条对齐 —— 尤其**无 UI 出口时放行且留痕**，
//      这是 in-process 后最容易翻车的一处（`ctx.hasUI` 恒为 true，照抄旧判据会翻转成全部 block）。
//   2. askquestion 发出的信封必须能被 host 侧的 `sanitizeAskQuestionEnvelope()` 接住 ——
//      那正是 `pi-inproc/ui-context.ts` 归一化时调用的函数，等于验证两层真的对得上。
//   3. 错误路径显式测（KTD5）：in-process 后没有进程退出码，契约不符只会被吞进事件流。

import { describe, expect, it, vi } from "vitest";

const logMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
  recordAgentTrace: vi.fn(),
}));
vi.mock("../../log", () => ({ createLogger: () => logMocks.logger, isDevEnv: () => true }));
vi.mock("../../ipc/agent-trace", () => ({
  recordAgentTrace: logMocks.recordAgentTrace,
  recordStreamDelta: vi.fn(),
}));
// pi-extensions.ts 顶层 import electron 的 app（仅 writeExtension 用得到）。
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/userData" } }));

import {
  APPROVAL_DETAIL_MAX_CHARS,
  ASK_QUESTION_MAX_GROUPS,
  ASK_QUESTION_TOOL_NAME,
  DEFAULT_APPROVAL_TOOLS,
  SAMPLE_COMMAND_NAME,
  SAMPLE_TOOL_NAME,
  TODO_TOOL_NAME,
  createApprovalExtension,
  createAskQuestionTool,
  createPiNativeHooks,
  createSampleCommandExtension,
  createSampleEchoTool,
  createTodoTool,
  type PiApprovalRecord,
  type PiNativeHooksOptions,
} from "./native-hooks";
import { sanitizeAskQuestionEnvelope } from "../pi-rpc";

// ── 测试替身 ──────────────────────────────────────────────────────────────────────────

type ToolCallHandler = (
  event: { type: "tool_call"; toolCallId: string; toolName: string; input: unknown },
  ctx: unknown,
) => Promise<{ block?: boolean; reason?: string } | void>;

/** 收集 InlineExtension 注册动作的假 ExtensionAPI。 */
function fakePi() {
  const toolCallHandlers: ToolCallHandler[] = [];
  const commands = new Map<string, { description?: string; handler: (a: string, c: unknown) => Promise<void> }>();
  const api = {
    on: (event: string, handler: unknown) => {
      if (event === "tool_call") toolCallHandlers.push(handler as ToolCallHandler);
    },
    registerTool: vi.fn(),
    registerCommand: (name: string, opts: never) => {
      commands.set(name, opts);
    },
  };
  return { api, toolCallHandlers, commands };
}

/** 把 InlineExtension 跑起来，返回它注册的 tool_call handler（审批 hook 只注册一个）。 */
function mountApproval(options: Parameters<typeof createApprovalExtension>[0]): ToolCallHandler {
  const ext = createApprovalExtension(options);
  const { api, toolCallHandlers } = fakePi();
  // 对象形态的 InlineExtension（{name, factory}）——本文件产出的都是这一种。
  (ext as { factory: (pi: unknown) => void }).factory(api);
  expect(toolCallHandlers).toHaveLength(1);
  return toolCallHandlers[0]!;
}

/** 假 ExtensionContext：只提供审批/提问用得到的成员。 */
function fakeCtx(opts: {
  hasUI?: boolean;
  confirm?: (title: string, message: string) => Promise<boolean>;
  input?: (title: string) => Promise<string | undefined>;
}) {
  return {
    hasUI: opts.hasUI ?? true,
    ui: {
      confirm: opts.confirm ?? (async () => true),
      input: opts.input ?? (async () => undefined),
      notify: vi.fn(),
    },
  };
}

function toolCall(toolName: string, input: unknown) {
  return { type: "tool_call" as const, toolCallId: "tc-1", toolName, input };
}

/** 记录留痕的收集器。 */
function recorder() {
  const records: PiApprovalRecord[] = [];
  return { records, onDecision: (r: PiApprovalRecord) => records.push(r) };
}

// ── 1. 审批 hook ──────────────────────────────────────────────────────────────────────

describe("createApprovalExtension", () => {
  it("命中审批集 → 弹 confirm，用户允许则不 block", async () => {
    const confirm = vi.fn(async () => true);
    const rec = recorder();
    const handler = mountApproval({ tools: ["bash"], hasUiOutlet: () => true, onDecision: rec.onDecision });

    const result = await handler(toolCall("bash", { command: "ls" }), fakeCtx({ confirm }));

    expect(confirm).toHaveBeenCalledWith("允许执行工具 bash?", JSON.stringify({ command: "ls" }));
    expect(result).toBeUndefined();
    expect(rec.records).toEqual([
      { toolName: "bash", detail: JSON.stringify({ command: "ls" }), decision: "approved" },
    ]);
  });

  it("用户拒绝 → block + reason 与旧模板逐字一致", async () => {
    const rec = recorder();
    const handler = mountApproval({
      tools: ["write"],
      hasUiOutlet: () => true,
      onDecision: rec.onDecision,
    });

    const result = await handler(
      toolCall("write", { path: "/a" }),
      fakeCtx({ confirm: async () => false }),
    );

    expect(result).toEqual({ block: true, reason: "用户拒绝执行" });
    expect(rec.records[0]?.decision).toBe("denied");
  });

  it("不在审批集的工具 → 不弹窗、不 block、不留痕", async () => {
    const confirm = vi.fn(async () => false);
    const rec = recorder();
    const handler = mountApproval({ tools: ["bash"], hasUiOutlet: () => true, onDecision: rec.onDecision });

    const result = await handler(toolCall("read", { path: "/a" }), fakeCtx({ confirm }));

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(rec.records).toEqual([]);
  });

  it("tools 缺省 → 用 DEFAULT_APPROVAL_TOOLS；tools=[] → 空集放行全部", async () => {
    const confirmDefault = vi.fn(async () => true);
    const withDefault = mountApproval({ hasUiOutlet: () => true, onDecision: () => {} });
    for (const name of DEFAULT_APPROVAL_TOOLS) {
      await withDefault(toolCall(name, {}), fakeCtx({ confirm: confirmDefault }));
    }
    expect(confirmDefault).toHaveBeenCalledTimes(DEFAULT_APPROVAL_TOOLS.length);

    // 空集语义是 permissionMode.ts 的显式依赖（「空集会放行全部工具」），不能被"贴心地"回退成默认集。
    const confirmEmpty = vi.fn(async () => false);
    const withEmpty = mountApproval({ tools: [], hasUiOutlet: () => true, onDecision: () => {} });
    const result = await withEmpty(toolCall("bash", {}), fakeCtx({ confirm: confirmEmpty }));
    expect(confirmEmpty).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  // ── 安全红线：无 UI 出口 ──
  it("【红线】hasUiOutlet=false（但 ctx.hasUI=true）→ 放行、不弹窗，且必留痕 skipped", async () => {
    const confirm = vi.fn(async () => false); // 若真去问，会拿到 false → block（正是要避免的翻转）
    const rec = recorder();
    const handler = mountApproval({ tools: ["bash"], hasUiOutlet: () => false, onDecision: rec.onDecision });

    const result = await handler(toolCall("bash", { command: "rm -rf /tmp/x" }), fakeCtx({ confirm }));

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toBeUndefined(); // 与旧路径 `if (!ctx.hasUI) return;` 同义：放行
    expect(rec.records[0]).toMatchObject({ toolName: "bash", decision: "skipped" });
    expect(rec.records[0]?.reason).toContain("无 UI 出口");
  });

  it("【红线】ctx.hasUI=false → 同样放行 + 留痕（两个条件取与）", async () => {
    const confirm = vi.fn(async () => false);
    const rec = recorder();
    const handler = mountApproval({ tools: ["bash"], hasUiOutlet: () => true, onDecision: rec.onDecision });

    const result = await handler(toolCall("bash", {}), fakeCtx({ hasUI: false, confirm }));

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(rec.records[0]?.decision).toBe("skipped");
    expect(rec.records[0]?.reason).toContain("hasUI=false");
  });

  it("hasUiOutlet 抛错 → 按「无出口」处理（放行 + 留痕），不把用户操作 block 掉", async () => {
    const rec = recorder();
    const handler = mountApproval({
      tools: ["bash"],
      hasUiOutlet: () => {
        throw new Error("boom");
      },
      onDecision: rec.onDecision,
    });

    const result = await handler(toolCall("bash", {}), fakeCtx({}));

    expect(result).toBeUndefined();
    expect(rec.records[0]).toMatchObject({ decision: "skipped" });
    expect(rec.records[0]?.reason).toContain("boom");
  });

  it("confirm 抛错 → fail-closed：block 且留痕 failed（KTD5 错误路径）", async () => {
    const rec = recorder();
    const handler = mountApproval({
      tools: ["bash"],
      hasUiOutlet: () => true,
      onDecision: rec.onDecision,
    });

    const result = await handler(
      toolCall("bash", {}),
      fakeCtx({
        confirm: async () => {
          throw new Error("renderer 已销毁");
        },
      }),
    );

    expect(result).toEqual({ block: true, reason: "审批流程异常，已拒绝执行" });
    expect(rec.records[0]).toMatchObject({ decision: "failed", reason: "renderer 已销毁" });
  });

  it("detail 截断到 600 字；不可序列化入参退化为空串而不抛", async () => {
    const captured: string[] = [];
    const handler = mountApproval({
      tools: ["bash", "write"],
      hasUiOutlet: () => true,
      onDecision: () => {},
    });
    const confirm = async (_t: string, message: string) => {
      captured.push(message);
      return true;
    };

    await handler(toolCall("bash", { note: "x".repeat(2000) }), fakeCtx({ confirm }));
    expect(captured[0]).toHaveLength(APPROVAL_DETAIL_MAX_CHARS);
    expect(APPROVAL_DETAIL_MAX_CHARS).toBe(600);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await handler(toolCall("write", cyclic), fakeCtx({ confirm }));
    expect(captured[1]).toBe("");
  });

  it("【红线】gui_* 出现在审批集时照样逐次确认 —— 执行侧不做任何豁免", async () => {
    // 判定侧（core/personal/permissionMode.ts）在「自动执行」档也会把 gui_* 写工具塞进 approvalTools。
    // 本层只需忠实执行；这条用例守住「执行侧没有偷偷放行 gui_*」。
    const rec = recorder();
    const handler = mountApproval({
      tools: ["gui_click", "gui_type"],
      hasUiOutlet: () => true,
      onDecision: rec.onDecision,
    });

    const result = await handler(
      toolCall("gui_click", { x: 10, y: 20 }),
      fakeCtx({ confirm: async () => false }),
    );

    expect(result).toEqual({ block: true, reason: "用户拒绝执行" });
    expect(rec.records[0]?.decision).toBe("denied");
  });

  it("【红线】拦得到「不属于自家 customTools」的工具（磁盘 extension 注册的 gui_*）", async () => {
    // 这条守的是**挂法**而非文案：审批必须挂在 extension 的 `tool_call` 事件上，
    // 而不是包住自家 customTools 的 execute wrapper。
    //
    // gui_* 由 `~/.pi` 里的第三方包 pi-computer-use 以磁盘 extension 形态注册，
    // 经 PiInProcDeps.additionalExtensionPaths 加载 —— 与本文件产出的 customTools 无任何交集。
    // wrapper 方案会静默漏掉它们（无报错、无日志，只是审批闸消失）。
    const hooks = createPiNativeHooks({
      hasUiOutlet: () => true,
      enableToolApproval: true,
      approvalTools: ["gui_click"],
      askQuestionSentinel: SENTINEL,
    });
    // 前提断言：gui_click 确实不是我们注册的工具。
    expect(hooks.customTools.map((t) => t.name)).not.toContain("gui_click");
    // 而审批能力挂在 extensionFactories 的 tool_call 事件上（唯一正确挂法）。
    const { api, toolCallHandlers } = fakePi();
    (hooks.extensionFactories[0] as { factory: (pi: unknown) => void }).factory(api);
    expect(toolCallHandlers).toHaveLength(1);
    expect(api.registerTool).not.toHaveBeenCalled();

    const confirm = vi.fn(async () => false);
    const blocked = await toolCallHandlers[0]!(
      toolCall("gui_click", { x: 1, y: 2 }),
      fakeCtx({ confirm }),
    );
    expect(confirm).toHaveBeenCalledWith("允许执行工具 gui_click?", JSON.stringify({ x: 1, y: 2 }));
    expect(blocked).toEqual({ block: true, reason: "用户拒绝执行" });
  });

  it("缺省留痕出口写日志 + agent trace（保证「放行必留痕」不依赖调用方注入）", async () => {
    logMocks.recordAgentTrace.mockClear();
    logMocks.logger.warn.mockClear();
    const handler = mountApproval({ tools: ["bash"], hasUiOutlet: () => false, uiSessionId: "s-1" });

    await handler(toolCall("bash", { command: "ls" }), fakeCtx({}));

    expect(logMocks.logger.warn).toHaveBeenCalled();
    expect(logMocks.recordAgentTrace).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "pi", phase: "approval", sessionId: "s-1" }),
    );
  });
});

// ── 2. todo_write ─────────────────────────────────────────────────────────────────────

describe("createTodoTool", () => {
  it("工具名与 host 侧特判同源，且计数复用 normalizePiTodos（跳过非法项）", async () => {
    const tool = createTodoTool();
    expect(tool.name).toBe(TODO_TOOL_NAME);
    expect(tool.promptSnippet).toContain("todo_write");

    const result = await tool.execute(
      "tc",
      {
        todos: [
          { text: "a", status: "completed" },
          { text: "b", status: "in_progress" },
          { text: "", status: "completed" }, // 非法：空 text → normalizePiTodos 跳过
          null,
        ],
      } as never,
      undefined,
      undefined,
      fakeCtx({}) as never,
    );

    expect(result.content).toEqual([{ type: "text", text: "任务清单已更新(1/2 项完成)" }]);
  });

  it("todos 缺失/非数组 → 0/0，不抛", async () => {
    const tool = createTodoTool();
    const result = await tool.execute("tc", {} as never, undefined, undefined, fakeCtx({}) as never);
    expect(result.content).toEqual([{ type: "text", text: "任务清单已更新(0/0 项完成)" }]);
  });
});

// ── 3. askquestion ────────────────────────────────────────────────────────────────────

const SENTINEL = "@@CORTEX_ASKQ:test@@";

describe("createAskQuestionTool", () => {
  it("信封走 ctx.ui.input 的 title 夹带，且能被 host 的 sanitizeAskQuestionEnvelope 接住", async () => {
    let title = "";
    const tool = createAskQuestionTool(SENTINEL);
    await tool.execute(
      "tc",
      {
        groups: [
          {
            header: "H",
            question: "选哪个?",
            options: [{ label: "A" }, { label: "B", description: "描述" }, { label: "C" }, { label: "D" }],
            recommended: 1,
            allowCustom: 1,
          },
        ],
      } as never,
      undefined,
      undefined,
      fakeCtx({
        input: async (t) => {
          title = t;
          return undefined;
        },
      }) as never,
    );

    expect(title.startsWith(SENTINEL)).toBe(true);
    const payload = JSON.parse(title.slice(SENTINEL.length)) as {
      groups: Array<{ id: string; options: unknown[]; recommended?: number; allowCustom: boolean }>;
    };
    expect(payload.groups[0]?.id).toBe("g0");
    expect(payload.groups[0]?.options).toHaveLength(3); // 截到 ASK_QUESTION_MAX_OPTIONS
    expect(payload.groups[0]?.recommended).toBe(1);
    expect(payload.groups[0]?.allowCustom).toBe(true); // 布尔化

    // 与 pi-inproc/ui-context.ts 的归一化对接：它就是拿这段 JSON 喂给 sanitizeAskQuestionEnvelope。
    const envelope = sanitizeAskQuestionEnvelope(JSON.parse(title.slice(SENTINEL.length)));
    expect(envelope).not.toBeNull();
    expect(envelope?.groups[0]?.header).toBe("H");
    // host 会把推荐项重排到首位并归一为 0（本层不做，避免两层重复重排）。
    expect(envelope?.groups[0]?.recommended).toBe(0);
    expect(envelope?.groups[0]?.options[0]?.label).toBe("B");
  });

  it("recommended 越界被丢弃", async () => {
    let title = "";
    const tool = createAskQuestionTool(SENTINEL);
    await tool.execute(
      "tc",
      { groups: [{ question: "q", options: [{ label: "A" }], recommended: 5 }] } as never,
      undefined,
      undefined,
      fakeCtx({
        input: async (t) => {
          title = t;
          return undefined;
        },
      }) as never,
    );
    const payload = JSON.parse(title.slice(SENTINEL.length)) as { groups: Array<{ recommended?: number }> };
    expect(payload.groups[0]?.recommended).toBeUndefined();
  });

  it("用户取消 → 正常结果（不是错误），文案与旧模板一致", async () => {
    const tool = createAskQuestionTool(SENTINEL);
    const result = await tool.execute(
      "tc",
      { groups: [{ question: "q", options: [{ label: "A" }] }] } as never,
      undefined,
      undefined,
      fakeCtx({ input: async () => undefined }) as never,
    );
    expect(result.content).toEqual([{ type: "text", text: "用户取消了提问,未作选择。" }]);
  });

  it("回答被格式化成逐组「问/答」文本", async () => {
    const tool = createAskQuestionTool(SENTINEL);
    const result = await tool.execute(
      "tc",
      {
        groups: [
          { question: "第一问", options: [{ label: "A" }] },
          { question: "第二问", options: [{ label: "B" }] },
        ],
      } as never,
      undefined,
      undefined,
      fakeCtx({
        input: async () =>
          JSON.stringify({
            answers: [
              { groupId: "g0", value: "A" },
              { groupId: "g1", value: "自填", isCustom: true },
            ],
          }),
      }) as never,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("问: 第一问\n答: A");
    expect(text).toContain("问: 第二问\n答: 自填（自定义）");
  });

  it("answers 为空 → 「用户未提供有效回答。」", async () => {
    const tool = createAskQuestionTool(SENTINEL);
    const result = await tool.execute(
      "tc",
      { groups: [{ question: "q", options: [{ label: "A" }] }] } as never,
      undefined,
      undefined,
      fakeCtx({ input: async () => JSON.stringify({ answers: [] }) }) as never,
    );
    expect(result.content).toEqual([{ type: "text", text: "用户未提供有效回答。" }]);
  });

  // ── 错误路径（KTD5：in-process 后没有退出码，必须显式测）──
  it.each([
    ["无问题组", { groups: [] }, "askquestion 调用未提供任何问题组。"],
    [
      "问题组超限",
      { groups: Array.from({ length: ASK_QUESTION_MAX_GROUPS + 1 }, () => ({ question: "q", options: [] })) },
      `问题组过多(最多 ${ASK_QUESTION_MAX_GROUPS} 组),请精简后重试。`,
    ],
  ])("%s → 抛错（0.82.1 只有抛异常才会被标成 error tool result）", async (_name, params, message) => {
    const tool = createAskQuestionTool(SENTINEL);
    await expect(
      tool.execute("tc", params as never, undefined, undefined, fakeCtx({}) as never),
    ).rejects.toThrow(message);
  });

  it("ctx.ui.input 抛错 → 抛「提问过程出错」", async () => {
    const tool = createAskQuestionTool(SENTINEL);
    await expect(
      tool.execute(
        "tc",
        { groups: [{ question: "q", options: [{ label: "A" }] }] } as never,
        undefined,
        undefined,
        fakeCtx({
          input: async () => {
            throw new Error("桥已关闭");
          },
        }) as never,
      ),
    ).rejects.toThrow("提问过程出错: 桥已关闭");
  });

  it("回答不是合法 JSON → 抛「无法解析用户的回答。」", async () => {
    const tool = createAskQuestionTool(SENTINEL);
    await expect(
      tool.execute(
        "tc",
        { groups: [{ question: "q", options: [{ label: "A" }] }] } as never,
        undefined,
        undefined,
        fakeCtx({ input: async () => "not-json" }) as never,
      ),
    ).rejects.toThrow("无法解析用户的回答。");
  });
});

// ── 4. 样例工具 / 命令 ────────────────────────────────────────────────────────────────

describe("样例工具与斜杠命令", () => {
  it("echo_upper 转大写；非字符串入参退化为空串", async () => {
    const tool = createSampleEchoTool();
    expect(tool.name).toBe(SAMPLE_TOOL_NAME);
    const ok = await tool.execute("tc", { text: "abc" } as never, undefined, undefined, fakeCtx({}) as never);
    expect(ok.content).toEqual([{ type: "text", text: "ABC" }]);
    const bad = await tool.execute("tc", { text: 1 } as never, undefined, undefined, fakeCtx({}) as never);
    expect(bad.content).toEqual([{ type: "text", text: "" }]);
  });

  it("/greet 经 registerCommand 注册，handler 调 ctx.ui.notify", async () => {
    const ext = createSampleCommandExtension();
    const { api, commands } = fakePi();
    (ext as { factory: (pi: unknown) => void }).factory(api);

    const cmd = commands.get(SAMPLE_COMMAND_NAME);
    expect(cmd?.description).toContain("样例");
    const ctx = fakeCtx({});
    await cmd!.handler("world", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("hello world", "info");
  });
});

// ── 5. 聚合入口 ───────────────────────────────────────────────────────────────────────

describe("createPiNativeHooks", () => {
  const base: PiNativeHooksOptions = { hasUiOutlet: () => true };

  it("缺省只注册 todo_write，无扩展", () => {
    const hooks = createPiNativeHooks(base);
    expect(hooks.customTools.map((t) => t.name)).toEqual([TODO_TOOL_NAME]);
    expect(hooks.extensionFactories).toEqual([]);
  });

  it("全开时的工具与扩展集合，顺序与旧 pi-session.ts 的 push 顺序一致", () => {
    const hooks = createPiNativeHooks({
      ...base,
      enableToolApproval: true,
      approvalTools: ["bash"],
      enableSampleTools: true,
      enableSampleCommands: true,
      askQuestionSentinel: SENTINEL,
    });
    expect(hooks.customTools.map((t) => t.name)).toEqual([
      SAMPLE_TOOL_NAME,
      ASK_QUESTION_TOOL_NAME,
      TODO_TOOL_NAME,
    ]);
    expect(hooks.extensionFactories.map((e) => (e as { name: string }).name)).toEqual([
      "cortex-approval",
      "cortex-sample-commands",
    ]);
  });

  it("无 sentinel 则不注册 askquestion（没有防伪 token 等于任何 input 都能冒充富信封）", () => {
    const hooks = createPiNativeHooks(base);
    expect(hooks.customTools.some((t) => t.name === ASK_QUESTION_TOOL_NAME)).toBe(false);
  });

  it("enableTodoTool=false 可显式关掉 todo（单发路径若不需要）", () => {
    const hooks = createPiNativeHooks({ ...base, enableTodoTool: false });
    expect(hooks.customTools).toEqual([]);
  });

  it("审批开关关闭时不产出审批扩展", () => {
    const hooks = createPiNativeHooks({ ...base, approvalTools: ["bash"] });
    expect(hooks.extensionFactories).toEqual([]);
  });

  it("hasUiOutlet 被透传给审批 hook（集成阶段接线的关键路径）", async () => {
    const rec = recorder();
    const hooks = createPiNativeHooks({
      hasUiOutlet: () => false,
      enableToolApproval: true,
      approvalTools: ["bash"],
      onApprovalDecision: rec.onDecision,
    });
    const { api, toolCallHandlers } = fakePi();
    (hooks.extensionFactories[0] as { factory: (pi: unknown) => void }).factory(api);

    const confirm = vi.fn(async () => false);
    const result = await toolCallHandlers[0]!(toolCall("bash", {}), fakeCtx({ confirm }));

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(rec.records[0]?.decision).toBe("skipped");
  });
});
