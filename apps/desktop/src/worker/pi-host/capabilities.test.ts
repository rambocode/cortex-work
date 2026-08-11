// worker 侧能力组装的单测。
//
// 断言重点全是「漏了不会报错、只会静默少一块能力」的那些接缝：
//   · 审批 hook 必须以 extension 形态交付（wrapper 形态拦不到磁盘 extension 的 gui_*）
//   · approvalTools 原样透传（`gui_*` 强制审批那条红线在判定侧，本层一个字都不能过滤）
//   · Computer Use 的 grounding env 必须写进 **worker** 的 process.env
//   · 磁盘 extension 两个来源的合并与顺序

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PiOpenRequest } from "../../main/ipc/types";

const mcpMocks = vi.hoisted(() => ({
  createMcpInProcTools: vi.fn(),
}));

vi.mock("../../main/agents/pi-mcp-inproc", () => ({
  createMcpInProcTools: mcpMocks.createMcpInProcTools,
}));

const { buildWorkerDeps } = await import("./capabilities");

/** 与 `capabilities/computer-use/inject.ts` 的 `GROUNDING_MODEL_ENV` 同值（那个模块会拖进 electron，故不 import）。 */
const GROUNDING_ENV = "PI_COMPUSE_GROUNDING_MODEL";

const BASE: PiOpenRequest = { uiSessionId: "ui-1", cwd: "/tmp" };

/**
 * 【临时】剔掉 `native-hooks.ts` 里无条件注入的调试扩展 `cortex-payload-debug`
 *（DeepSeek「关闭思考仍思考」的 before_provider_request 抓包，见该文件注释）。
 * 它必须无条件注入才能覆盖关审批的会话，于是恒占 `extensionFactories[0]`——本层断言的是
 * **业务扩展**的注册与顺序，不该被它带偏。`native-hooks.test.ts` 用的是同一条判据；
 * 那个调试扩展定案删除时，这个 helper 连同两处 filter 一起删。
 */
function businessExtensions(deps: { extensionFactories?: unknown[] }): Array<{ name: string }> {
  return ((deps.extensionFactories ?? []) as Array<{ name: string }>).filter(
    (extension) => extension.name !== "cortex-payload-debug",
  );
}

function ctx(overrides: Partial<Parameters<typeof buildWorkerDeps>[1]> = {}) {
  return {
    hasUiOutlet: () => true,
    credentials: {} as never,
    resolveModel: undefined,
    ...overrides,
  } as Parameters<typeof buildWorkerDeps>[1];
}

beforeEach(() => {
  mcpMocks.createMcpInProcTools.mockReset();
  mcpMocks.createMcpInProcTools.mockResolvedValue({
    tools: [],
    connected: [],
    failed: [],
    dispose: async () => {},
  });
});

afterEach(() => {
  delete process.env[GROUNDING_ENV];
});

describe("buildWorkerDeps · 原生能力", () => {
  it("todo_write 常驻；askquestion 只在有 sentinel 时注册", async () => {
    const without = await buildWorkerDeps(BASE, ctx());
    expect(without.customTools?.map((t) => t.name)).toEqual(["todo_write"]);

    const withSentinel = await buildWorkerDeps({ ...BASE, askQuestionSentinel: "@@S@@" }, ctx());
    expect(withSentinel.customTools?.map((t) => t.name)).toEqual(["askquestion", "todo_write"]);
  });

  it("审批 hook 走 extensionFactories（extension 级 tool_call，不是 customTools wrapper）", async () => {
    const deps = await buildWorkerDeps({ ...BASE, enableToolApproval: true }, ctx());
    expect(businessExtensions(deps)).toHaveLength(1);
    expect(businessExtensions(deps)[0]?.name).toBe("cortex-approval");
    // wrapper 形态会把 hook 混进 customTools —— 那样拦不到磁盘 extension 注册的 gui_*。
    expect(deps.customTools?.some((t) => t.name === "cortex-approval")).toBe(false);
  });

  it("关闭审批时不注册 hook", async () => {
    const deps = await buildWorkerDeps({ ...BASE, enableToolApproval: false }, ctx());
    expect(businessExtensions(deps)).toHaveLength(0);
  });

  it("样例工具/命令按开关注册", async () => {
    const deps = await buildWorkerDeps(
      { ...BASE, enableSampleTools: true, enableSampleCommands: true },
      ctx(),
    );
    expect(deps.customTools?.map((t) => t.name)).toContain("echo_upper");
    expect(businessExtensions(deps)[0]?.name).toBe("cortex-sample-commands");
  });

  it("artifacts / javascript_repl 按 flag 注册;缺省一个都不进（oneshot/编排子会话路径）", async () => {
    const off = await buildWorkerDeps(BASE, ctx());
    expect(off.customTools?.map((t) => t.name)).not.toContain("artifacts");
    expect(off.customTools?.map((t) => t.name)).not.toContain("javascript_repl");

    const on = await buildWorkerDeps(
      { ...BASE, enableArtifactsTool: true, enableJsReplTool: true, jsReplSentinel: "@@R@@" },
      ctx(),
    );
    expect(on.customTools?.map((t) => t.name)).toContain("artifacts");
    expect(on.customTools?.map((t) => t.name)).toContain("javascript_repl");
  });

  it("jsrepl 双保险:无 UI 出口或缺 sentinel 都不注册（必然失败的工具比不给更糟）", async () => {
    const noOutlet = await buildWorkerDeps(
      { ...BASE, enableJsReplTool: true, jsReplSentinel: "@@R@@" },
      ctx({ hasUiOutlet: () => false }),
    );
    expect(noOutlet.customTools?.map((t) => t.name)).not.toContain("javascript_repl");

    const noSentinel = await buildWorkerDeps({ ...BASE, enableJsReplTool: true }, ctx());
    expect(noSentinel.customTools?.map((t) => t.name)).not.toContain("javascript_repl");
  });
});

describe("buildWorkerDeps · Computer Use 的 grounding env", () => {
  it("有值 → 写进 worker 自己的 process.env（主进程写的那份对 worker 无效）", async () => {
    await buildWorkerDeps({ ...BASE, computerUseEnv: { [GROUNDING_ENV]: "qwen-vl" } }, ctx());
    expect(process.env[GROUNDING_ENV]).toBe("qwen-vl");
  });

  it("空值 → 显式删除（否则上一轮的模型名会永久粘住）", async () => {
    process.env[GROUNDING_ENV] = "旧值";
    await buildWorkerDeps({ ...BASE, computerUseEnv: { [GROUNDING_ENV]: "" } }, ctx());
    expect(process.env[GROUNDING_ENV]).toBeUndefined();
  });

  it("字段缺省（门控未过）→ 一个字节都不碰", async () => {
    process.env[GROUNDING_ENV] = "别的会话设的值";
    await buildWorkerDeps(BASE, ctx());
    expect(process.env[GROUNDING_ENV]).toBe("别的会话设的值");
  });
});

describe("buildWorkerDeps · 磁盘 extension 与 MCP", () => {
  it("Computer Use 与市场扩展合并成一个槽，顺序不变", async () => {
    const deps = await buildWorkerDeps(
      { ...BASE, inProcExtensionPaths: ["/pi/computer-use"], extensionPaths: ["/pi/market-a"] },
      ctx(),
    );
    expect(deps.additionalExtensionPaths).toEqual(["/pi/computer-use", "/pi/market-a"]);
  });

  it("两个来源都空时不下发该字段（避免给 SDK 一个空数组）", async () => {
    const deps = await buildWorkerDeps(BASE, ctx());
    expect(deps.additionalExtensionPaths).toBeUndefined();
  });

  it("MCP 工具追加在原生工具之后；dispose 接到 onDispose 上", async () => {
    const dispose = vi.fn(async () => {});
    mcpMocks.createMcpInProcTools.mockResolvedValue({
      tools: [{ name: "mcp_tool" }],
      connected: ["srv"],
      failed: [],
      dispose,
    });
    const deps = await buildWorkerDeps(
      { ...BASE, bridgeServers: [{ id: "srv" } as never] },
      ctx(),
    );
    expect(deps.customTools?.map((t) => t.name)).toEqual(["todo_write", "mcp_tool"]);
    await deps.onDispose?.();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("MCP 桥整体失败 → 降级为无 MCP 工具，会话照常建（绝不阻断）", async () => {
    mcpMocks.createMcpInProcTools.mockRejectedValue(new Error("连不上"));
    const deps = await buildWorkerDeps({ ...BASE, bridgeServers: [{ id: "srv" } as never] }, ctx());
    expect(deps.customTools?.map((t) => t.name)).toEqual(["todo_write"]);
    await expect(deps.onDispose?.()).resolves.toBeUndefined();
  });

  it("没有 server 时压根不建桥", async () => {
    await buildWorkerDeps(BASE, ctx());
    expect(mcpMocks.createMcpInProcTools).not.toHaveBeenCalled();
  });
});

describe("buildWorkerDeps · 安全红线", () => {
  it("approvalTools 原样透传，gui_* 一个都不过滤（判定在 permissionMode.ts，本层只执行）", async () => {
    const tools = ["bash", "write", "edit", "gui_click", "gui_type"];
    const deps = await buildWorkerDeps({ ...BASE, enableToolApproval: true, approvalTools: tools }, ctx());
    // 审批集不在返回值上，只能从 hook 行为反推：构造一个 tool_call 事件看它会不会去问 UI。
    const asked: string[] = [];
    const factory = businessExtensions(deps)[0] as unknown as {
      factory: (pi: { on: (ev: string, h: unknown) => void }) => void;
    };
    let handler!: (event: { toolName: string; input: unknown }, c: unknown) => Promise<unknown>;
    factory.factory({ on: (_ev, h) => (handler = h as typeof handler) });

    for (const name of [...tools, "read"]) {
      await handler(
        { toolName: name, input: {} },
        { hasUI: true, ui: { confirm: async () => (asked.push(name), true) } },
      );
    }
    expect(asked).toEqual(tools);
  });

  it("hasUiOutlet=false → 放行 + 留痕（**不是**全部 block）", async () => {
    const decisions: Array<{ toolName: string; decision: string }> = [];
    const deps = await buildWorkerDeps(
      { ...BASE, enableToolApproval: true, approvalTools: ["bash"] },
      ctx({
        hasUiOutlet: () => false,
        onApprovalDecision: (r) => decisions.push({ toolName: r.toolName, decision: r.decision }),
      }),
    );
    const factory = businessExtensions(deps)[0] as unknown as {
      factory: (pi: { on: (ev: string, h: unknown) => void }) => void;
    };
    let handler!: (event: { toolName: string; input: unknown }, c: unknown) => Promise<unknown>;
    factory.factory({ on: (_ev, h) => (handler = h as typeof handler) });

    // pi 侧 ctx.hasUI 在 gateway 下与 in-process 一样恒为 true —— 照抄旧判据会让语义反转。
    const result = await handler({ toolName: "bash", input: { cmd: "ls" } }, { hasUI: true, ui: {} });
    expect(result).toBeUndefined(); // undefined = 放行
    expect(decisions).toEqual([{ toolName: "bash", decision: "skipped" }]);
  });
});
