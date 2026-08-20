import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeferredToolsExtension } from "./deferred-tools";
import { createPiNativeHooks } from "./native-hooks";
import { createToolContextExtension, MemoryToolOutputStore } from "./tool-context";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-deferred-tools-"));
  roots.push(root);
  return root;
}

function params(properties: Record<string, unknown> = {}): ToolDefinition["parameters"] {
  return { type: "object", properties };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("deferred tools · Pi agent loop", () => {
  it("首轮不发送大目录，tool_search 后同一回合能调用新增工具", async () => {
    const root = tempRoot();
    // 本地验收可指向真实仓库，连同 AGENTS/CLAUDE 上下文测完整首轮；CI 缺省仍用隔离临时目录。
    const cwd = process.env["CORTEX_TOOL_BUDGET_CWD"] || root;
    const faux = fauxProvider();
    const runtime = await ModelRuntime.create({ modelsPath: null });
    runtime.registerNativeProvider(faux.provider);
    const browserExecute = vi.fn(async (_toolCallId: string, _input: unknown) => ({
      content: [{ type: "text" as const, text: "navigated" }],
      details: undefined,
    }));
    const browserTool: ToolDefinition = {
      name: "browser_navigate",
      label: "Browser Navigate",
      description: "Navigate the controlled browser to a URL.",
      parameters: params({ url: { type: "string", description: "Destination URL" } }),
      execute: browserExecute,
    };
    const nativeTools = createPiNativeHooks({
      hasUiOutlet: () => true,
      askQuestionSentinel: "@@CORTEX_TEST_ASKQ@@",
    }).customTools;
    const heavy = "schema".repeat(400);
    const deferredCatalog: ToolDefinition[] = Array.from({ length: 30 }, (_, index) => ({
      name: `large_capability_${index}`,
      label: `Large ${index}`,
      description: heavy,
      parameters: params({ payload: { type: "string", description: heavy } }),
      async execute() {
        return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
      },
    }));

    const snapshots: Array<{
      tools: string[];
      toolSchemaBytes: number;
      estimatedInputTokens: number;
      added: string[][];
    }> = [];
    const capture = (context: Context): void => {
      const serializedInput = [
        context.systemPrompt ?? "",
        JSON.stringify(context.messages),
        JSON.stringify(context.tools ?? []),
      ].join("\n");
      snapshots.push({
        tools: (context.tools ?? []).map((tool) => tool.name),
        toolSchemaBytes: Buffer.byteLength(JSON.stringify(context.tools ?? [])),
        // 与 pi-ai Faux provider 的估算口径一致（4 chars/token），用于守住“约 15K”目标。
        estimatedInputTokens: Math.ceil(serializedInput.length / 4),
        added: context.messages
          .filter((message): message is Extract<Context["messages"][number], { role: "toolResult" }> =>
            message.role === "toolResult" && !!message.addedToolNames?.length,
          )
          .map((message) => [...(message.addedToolNames ?? [])]),
      });
    };
    faux.setResponses([
      (context) => {
        capture(context);
        return fauxAssistantMessage(fauxToolCall("tool_search", { query: "browser" }), {
          stopReason: "toolUse",
        });
      },
      (context) => {
        capture(context);
        return fauxAssistantMessage(
          fauxToolCall("browser_navigate", { url: "https://example.com" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        capture(context);
        return fauxAssistantMessage(fauxText("done"));
      },
    ]);

    const services = await createAgentSessionServices({
      cwd,
      agentDir: root,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        extensionFactories: [
          createDeferredToolsExtension({
            initialToolNames: ["read", "bash", "edit", "write", "todo_write", "askquestion"],
          }),
        ],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      model: faux.getModel(),
      thinkingLevel: "off",
      customTools: [...nativeTools, browserTool, ...deferredCatalog],
    });

    try {
      // 生产路径由 PiInProcSession.rebind() 完成同一绑定；直接使用 SDK 的测试必须显式触发，
      // session_start 正是在这里把 eager 默认集收窄成首轮集。
      await session.bindExtensions({ mode: "rpc" });
      await session.prompt("Open example.com in the browser.");

      expect(snapshots).toHaveLength(3);
      expect(snapshots[0]!.tools).toEqual([
        "tool_search",
        "read",
        "bash",
        "edit",
        "write",
        "todo_write",
        "askquestion",
      ]);
      expect(snapshots[1]!.tools).toEqual([
        "tool_search",
        "read",
        "bash",
        "edit",
        "write",
        "todo_write",
        "askquestion",
        "browser_navigate",
      ]);
      expect(snapshots[1]!.added).toContainEqual(["browser_navigate"]);
      expect(browserExecute).toHaveBeenCalledOnce();
      expect(browserExecute.mock.calls[0]?.[1]).toMatchObject({ url: "https://example.com" });

      const fullCatalogBytes = Buffer.byteLength(
        JSON.stringify([...nativeTools, browserTool, ...deferredCatalog].map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        }))),
      );
      const deferredCatalogBytes = Buffer.byteLength(
        JSON.stringify([browserTool, ...deferredCatalog].map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        }))),
      );
      const eagerInputTokenEstimate = snapshots[0]!.estimatedInputTokens + Math.ceil(deferredCatalogBytes / 4);
      expect(fullCatalogBytes).toBeGreaterThan(100_000);
      expect(snapshots[0]!.toolSchemaBytes).toBeLessThan(8_000);
      expect(snapshots[0]!.toolSchemaBytes / fullCatalogBytes).toBeLessThan(0.05);
      expect(eagerInputTokenEstimate).toBeGreaterThan(35_000);
      expect(snapshots[0]!.estimatedInputTokens).toBeLessThan(15_000);
      if (process.env["CORTEX_TOOL_BUDGET_REPORT"] === "1") {
        console.info("[tool-budget]", {
          cwd,
          firstRequestTools: snapshots[0]!.tools,
          firstRequestToolSchemaBytes: snapshots[0]!.toolSchemaBytes,
          fullCatalogBytes,
          eagerInputTokenEstimate,
          estimatedInputTokens: snapshots[0]!.estimatedInputTokens,
        });
      }
    } finally {
      session.dispose();
    }
  });

  it("context checkpoint 经真实 AgentSession 自动 compaction 后继续同一轮", async () => {
    const root = tempRoot();
    const faux = fauxProvider();
    const runtime = await ModelRuntime.create({ modelsPath: null });
    runtime.registerNativeProvider(faux.provider);
    const largeTool: ToolDefinition = {
      name: "large_result",
      label: "Large Result",
      description: "Return a large deterministic result.",
      parameters: params(),
      async execute() {
        return { content: [{ type: "text" as const, text: "large\n".repeat(100) }], details: undefined };
      },
    };
    faux.setResponses([
      () => fauxAssistantMessage(fauxText("warmup one complete")),
      () => fauxAssistantMessage(fauxText("warmup two complete")),
      () => fauxAssistantMessage(fauxText("warmup three complete")),
      () => fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("checkpoint summary")),
      () => fauxAssistantMessage(fauxText("checkpoint turn-prefix summary")),
      () => fauxAssistantMessage(fauxText("final answer after checkpoint")),
    ]);
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 512 },
        retry: { enabled: false },
      }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true },
    });
    const model = { ...faux.getModel(), contextWindow: 4_096, maxTokens: 1_024 };
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(root),
      model,
      thinkingLevel: "off",
      customTools: [largeTool],
    });
    // 生产路径同样由 PiInProcSession.rebind() 在 session 创建后安装 guard。
    session.agent.shouldStopAfterTurn = ({ toolResults }) =>
      toolResults.length > 0 ? { reason: "context-checkpoint" } : false;
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = session.subscribe((event) => events.push(event as unknown as Record<string, unknown>));

    try {
      await session.bindExtensions({ mode: "rpc" });
      await session.prompt(`warmup-one ${"x".repeat(4_000)}`);
      await session.prompt(`warmup-two ${"y".repeat(4_000)}`);
      await session.prompt(`warmup-three ${"z".repeat(4_000)}`);
      await session.prompt("call the large result tool, then finish the answer");

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "agent_end", reason: "context-checkpoint", willRetry: true }),
        expect.objectContaining({ type: "compaction_start", reason: "context-checkpoint" }),
        expect.objectContaining({ type: "compaction_end", reason: "context-checkpoint", willRetry: true }),
      ]));
      expect(session.getLastAssistantText()).toBe("final answer after checkpoint");
      expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(4);
    } finally {
      unsubscribe();
      session.dispose();
    }
  });

  it("PI_CONTEXT_BLOCKED 在 provider request 前终止，不被 extension fail-open 吞掉", async () => {
    const root = tempRoot();
    const faux = fauxProvider();
    const runtime = await ModelRuntime.create({ modelsPath: null });
    runtime.registerNativeProvider(faux.provider);
    const providerCall = vi.fn(() => fauxAssistantMessage(fauxText("must not run")));
    faux.setResponses([providerCall]);
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        extensionFactories: [
          createToolContextExtension({ sessionId: "context-block", store: new MemoryToolOutputStore() }),
        ],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(root),
      model: { ...faux.getModel(), contextWindow: 6_000, maxTokens: 1_024 },
      thinkingLevel: "off",
    });

    try {
      await session.bindExtensions({ mode: "rpc" });
      await session.prompt(`force context block ${"x".repeat(8_000)}`);
      expect(providerCall).not.toHaveBeenCalled();
      expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
    } finally {
      session.dispose();
    }
  });
});
