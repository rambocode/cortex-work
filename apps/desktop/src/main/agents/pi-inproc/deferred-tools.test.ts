import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createDeferredToolsExtension } from "./deferred-tools";
import { PI_TOOL_SEARCH_NAME } from "./tools";

type SessionStartHandler = () => void | Promise<void>;
type TestTool = {
  name: string;
  description: string;
  parameters: ToolDefinition["parameters"];
  promptGuidelines?: string[];
  sourceInfo: { kind: "custom" };
};

function testTool(
  name: string,
  description = `${name} capability`,
  parameters: Record<string, unknown> = { type: "object", properties: {} },
): TestTool {
  return {
    name,
    description,
    parameters,
    sourceInfo: { kind: "custom" },
  };
}

function harness(
  options: Parameters<typeof createDeferredToolsExtension>[0],
  configured: TestTool[],
) {
  let active = configured.map((tool) => tool.name);
  let sessionStart: SessionStartHandler | undefined;
  const registered = new Map<string, ToolDefinition>();
  const setActiveTools = vi.fn((names: string[]) => {
    active = [...names];
  });
  const allTools = [...configured];
  const api = {
    registerTool(tool: ToolDefinition) {
      registered.set(tool.name, tool);
      allTools.push(testTool(tool.name, tool.description, tool.parameters as Record<string, unknown>));
    },
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") sessionStart = handler;
    },
    getAllTools: () => allTools,
    getActiveTools: () => [...active],
    setActiveTools,
  } as unknown as ExtensionAPI;

  const extension = createDeferredToolsExtension(options) as {
    factory: (pi: ExtensionAPI) => void;
  };
  extension.factory(api);

  return {
    allTools,
    registered,
    setActiveTools,
    active: () => [...active],
    start: async () => {
      await sessionStart?.();
    },
  };
}

async function search(h: ReturnType<typeof harness>, query: string, limit?: number) {
  const tool = h.registered.get(PI_TOOL_SEARCH_NAME);
  if (!tool) throw new Error("tool_search 未注册");
  return tool.execute(
    "search-call",
    { query, ...(limit === undefined ? {} : { limit }) } as never,
    undefined,
    undefined,
    {} as never,
  );
}

describe("createDeferredToolsExtension", () => {
  it("首轮只暴露 tool_search 与高频工具，完整目录仍保持注册", async () => {
    const configured = [
      testTool("read"),
      testTool("bash"),
      testTool("todo_write"),
      testTool("askquestion"),
      testTool("browser_navigate"),
      testTool("create_automation"),
    ];
    const h = harness(
      { initialToolNames: ["read", "bash", "todo_write", "askquestion"] },
      configured,
    );

    await h.start();

    expect(h.active()).toEqual([PI_TOOL_SEARCH_NAME, "read", "bash", "todo_write", "askquestion"]);
    expect(h.allTools.map((tool) => tool.name)).toEqual([
      ...configured.map((tool) => tool.name),
      PI_TOOL_SEARCH_NAME,
    ]);
  });

  it("搜索后在同一回合激活匹配工具，并显式返回 provider deferred 标记", async () => {
    const h = harness(
      { initialToolNames: ["read"] },
      [
        testTool("read"),
        testTool("browser_navigate", "Navigate the controlled browser to a URL"),
        testTool("browser_click", "Click an element in the browser page"),
        testTool("create_automation", "Create a scheduled automation"),
      ],
    );
    await h.start();

    const result = await search(h, "browser");

    expect(h.active().slice(0, 2)).toEqual([PI_TOOL_SEARCH_NAME, "read"]);
    expect(h.active().slice(2)).toEqual(expect.arrayContaining(["browser_click", "browser_navigate"]));
    expect(result.addedToolNames).toEqual(expect.arrayContaining(["browser_click", "browser_navigate"]));
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("Use the activated tools now");
  });

  it("plan 准入名单同时约束首轮和搜索，不能借 tool_search 恢复写工具", async () => {
    const h = harness(
      {
        allowedToolNames: ["read", "browser_read_dom"],
        initialToolNames: ["read", "write"],
      },
      [
        testTool("read"),
        testTool("write"),
        testTool("browser_read_dom", "Read browser page text"),
        testTool("browser_click", "Click browser controls"),
      ],
    );
    await h.start();
    expect(h.active()).toEqual([PI_TOOL_SEARCH_NAME, "read"]);

    const result = await search(h, "browser");

    expect(h.active()).toEqual([PI_TOOL_SEARCH_NAME, "read", "browser_read_dom"]);
    expect(result.addedToolNames).toEqual(["browser_read_dom"]);
    expect(h.active()).not.toContain("write");
    expect(h.active()).not.toContain("browser_click");
  });

  it("无匹配时保持 active set，不伪造不存在的工具", async () => {
    const h = harness(
      { initialToolNames: ["read"] },
      [testTool("read"), testTool("calendar_list", "List calendar events")],
    );
    await h.start();
    const before = h.active();

    const result = await search(h, "quantum chemistry simulator");

    expect(h.active()).toEqual(before);
    expect(result.addedToolNames).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("No deferred tools matched");
  });

  it("跨语言自然概念能命中产品能力，不要求模型猜精确工具名", async () => {
    const h = harness(
      { initialToolNames: ["read"] },
      [
        testTool("read"),
        testTool("create_automation", "创建一条定时任务"),
        testTool("create_calendar_event", "写入系统日历"),
        testTool("gui_click", "点击屏幕坐标"),
      ],
    );
    await h.start();

    const reminder = await search(h, "set a reminder");
    expect(reminder.addedToolNames).toEqual(
      expect.arrayContaining(["create_automation", "create_calendar_event"]),
    );

    const computer = await search(h, "operate the computer");
    expect(computer.addedToolNames).toEqual(["gui_click"]);
  });

  it("已 active 的高分工具不占结果上限，搜索优先补齐 deferred 能力", async () => {
    const h = harness(
      { initialToolNames: ["read"] },
      [
        testTool("read", "Read a file"),
        testTool("extract_document", "Read and extract document content"),
      ],
    );
    await h.start();

    const result = await search(h, "read", 1);

    expect(result.addedToolNames).toEqual(["extract_document"]);
    expect(h.active()).toContain("extract_document");
  });

  it("首轮 schema 上限不随延迟目录大小增长", async () => {
    const hugeDescription = "x".repeat(4_000);
    const configured = [
      testTool("read", "Read a file"),
      testTool("todo_write", "Maintain a task list"),
      ...Array.from({ length: 40 }, (_, index) =>
        testTool(`deferred_${index}`, hugeDescription, {
          type: "object",
          properties: { payload: { type: "string", description: hugeDescription } },
        }),
      ),
    ];
    const h = harness({ initialToolNames: ["read", "todo_write"] }, configured);
    const wireBytes = (names: readonly string[]) =>
      Buffer.byteLength(JSON.stringify(h.allTools.filter((tool) => names.includes(tool.name))));
    const eagerBytes = wireBytes(configured.map((tool) => tool.name));

    await h.start();
    const firstRequestBytes = wireBytes(h.active());

    expect(eagerBytes).toBeGreaterThan(300_000);
    expect(firstRequestBytes).toBeLessThan(3_000);
    expect(firstRequestBytes / eagerBytes).toBeLessThan(0.01);
  });
});
