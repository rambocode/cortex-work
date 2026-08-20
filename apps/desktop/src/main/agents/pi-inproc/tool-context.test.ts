// 工具上下文投影合同：只改 provider 前的副本，原始 toolResult / toolCall 配对绝不能漂移。
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createContextCheckpointGuard,
  createToolContextProjector,
  FileToolOutputStore,
  MemoryToolOutputStore,
} from "./tool-context";

const MODEL = {
  id: "test",
  name: "test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 40_000,
  maxTokens: 4_096,
} as Model<any>;

function assistantCall(id: string, name: string, arguments_: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: arguments_ }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function toolResult(id: string, name: string, text: string, isError = false): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError,
    timestamp: 2,
  };
}

describe("ToolContextProjector", () => {
  it("预算内原样返回同一消息引用，不产生投影报告", async () => {
    const messages = [assistantCall("read-1", "read", { file_path: "README.md" }), toolResult("read-1", "read", "short")];
    const result = await createToolContextProjector({ sessionId: "s1", store: new MemoryToolOutputStore() }).project({
      messages,
      model: MODEL,
      usage: { tokens: 100, contextWindow: 40_000, percent: 1 },
      systemPrompt: "system",
    });
    expect(result.messages).toBe(messages);
    expect(result.report).toMatchObject({ projectedResults: 0, deduplicatedResults: 0, externalizedResults: 0, budgetExhausted: false });
  });

  it("超预算 read 只投影副本、按完整行裁剪并给出继续读取 offset", async () => {
    const original = Array.from({ length: 8_000 }, (_, index) => `line ${index + 1}`).join("\n");
    const messages = [assistantCall("read-1", "read", { file_path: "README.md", offset: 0, limit: 8_000 }), toolResult("read-1", "read", original)];
    const result = await createToolContextProjector({ sessionId: "s2", store: new MemoryToolOutputStore() }).project({
      messages,
      model: MODEL,
      usage: { tokens: 39_000, contextWindow: 40_000, percent: 97 },
      systemPrompt: "system",
    });
    const projected = result.messages[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(projected).not.toBe(messages[1]);
    expect(projected.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("offset=") });
    expect((projected.content[0] as { text: string }).text).toContain("line 1");
    expect((messages[1] as Extract<AgentMessage, { role: "toolResult" }>).content[0]).toMatchObject({ text: original });
    expect(projected.toolCallId).toBe("read-1");
    expect(projected.toolName).toBe("read");
    expect(result.report.projectedResults).toBe(1);
  });

  it("usage 为 0 时退回字符估算，不能把大型 toolResult 误判为预算内", async () => {
    const original = "line\n".repeat(80_000);
    const messages = [assistantCall("read-1", "read", { file_path: "README.md" }), toolResult("read-1", "read", original)];
    const result = await createToolContextProjector({ sessionId: "s-zero", store: new MemoryToolOutputStore() }).project({
      messages,
      model: MODEL,
      usage: { tokens: 0, contextWindow: 40_000, percent: 0 },
      systemPrompt: "system",
    });
    expect(result.messages).not.toBe(messages);
    expect(result.report.projectedResults).toBe(1);
  });

  it("重复 read 以 path + content hash 替换为稳定引用，且不改变调用顺序", async () => {
    const body = "same result\n".repeat(4_000);
    const messages = [
      assistantCall("one", "read", { file_path: "README.md" }),
      toolResult("one", "read", body),
      assistantCall("two", "read", { file_path: "README.md" }),
      toolResult("two", "read", body),
    ];
    const result = await createToolContextProjector({ sessionId: "s3", store: new MemoryToolOutputStore() }).project({
      messages,
      model: MODEL,
      usage: { tokens: 39_000, contextWindow: 40_000, percent: 97 },
      systemPrompt: "system",
    });
    const duplicate = result.messages[3] as Extract<AgentMessage, { role: "toolResult" }>;
    expect((duplicate.content[0] as { text: string }).text).toContain("Unchanged file result");
    expect(result.messages.map((message) => message.role)).toEqual(messages.map((message) => message.role));
    expect(result.report.deduplicatedResults).toBe(1);
  });

  it("长 bash 成功输出外置到 0600 store 的引用，失败结果保留尾部错误", async () => {
    const store = new MemoryToolOutputStore();
    const long = `head\n${"middle\n".repeat(8_000)}tail`;
    const success = await createToolContextProjector({ sessionId: "s4", store }).project({
      messages: [assistantCall("bash-1", "bash", { command: "build" }), toolResult("bash-1", "bash", long)],
      model: MODEL,
      usage: { tokens: 39_000, contextWindow: 40_000, percent: 97 },
      systemPrompt: "system",
    });
    expect((success.messages[1] as Extract<AgentMessage, { role: "toolResult" }>).content[0]).toMatchObject({ text: expect.stringContaining("memory://cortex-tool-context") });
    expect(store.outputs.size).toBe(1);

    const failure = await createToolContextProjector({ sessionId: "s5", store: new MemoryToolOutputStore() }).project({
      messages: [assistantCall("bash-2", "bash", { command: "build" }), toolResult("bash-2", "bash", long, true)],
      model: MODEL,
      usage: { tokens: 39_000, contextWindow: 40_000, percent: 97 },
      systemPrompt: "system",
    });
    expect((failure.messages[1] as Extract<AgentMessage, { role: "toolResult" }>).content[0]).toMatchObject({ text: expect.stringContaining("tail") });
  });

  it("图片块和无法投影的结果保持原状，dispose 清理内存全文", async () => {
    const store = new MemoryToolOutputStore();
    await store.put("old", "output");
    const imageResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "image-1",
      toolName: "mcp_image",
      content: [{ type: "image", data: "base64", mimeType: "image/png" }, { type: "text", text: "text".repeat(10_000) }],
      isError: false,
      timestamp: 1,
    };
    const projector = createToolContextProjector({ sessionId: "s6", store });
    const messages = [imageResult];
    const result = await projector.project({
      messages,
      model: MODEL,
      usage: { tokens: 39_000, contextWindow: 40_000, percent: 97 },
      systemPrompt: "system",
    });
    expect(result.messages).toBe(messages);
    expect(result.messages[0]).toBe(imageResult);
    await projector.dispose();
    expect(store.outputs.size).toBe(0);
  });

  it("生产全文存储只使用 hash 文件名与 0600 权限，dispose 后移除会话目录", async () => {
    const store = new FileToolOutputStore(`test-${Date.now()}`);
    const path = await store.put("call-id", "secret output");
    expect(path).toMatch(/cortex-tool-context\/[a-f0-9]+\/[a-f0-9]+\.txt$/);
    expect((await stat(path!)).mode & 0o777).toBe(0o600);
    await store.dispose();
    await expect(stat(path!)).rejects.toThrow();
  });
});

describe("ContextCheckpointGuard", () => {
  it("只在一次 run 的 tool batch 后按原始上下文触发一次 checkpoint", () => {
    const guard = createContextCheckpointGuard({ model: MODEL, reserveTokens: 16_384 });
    const decision = guard.shouldStopAfterTurn({
      message: assistantCall("call-1", "read") as Extract<AgentMessage, { role: "assistant" }>,
      toolResults: [toolResult("call-1", "read", "done") as Extract<AgentMessage, { role: "toolResult" }>],
      context: {
        systemPrompt: "system",
        messages: [{ role: "user", content: "x".repeat(100_000), timestamp: 1 }],
        tools: [],
      },
      newMessages: [],
    });
    expect(decision).toEqual({ reason: "context-checkpoint" });
    expect(
      guard.shouldStopAfterTurn({
        message: assistantCall("call-2", "read") as Extract<AgentMessage, { role: "assistant" }>,
        toolResults: [toolResult("call-2", "read", "done") as Extract<AgentMessage, { role: "toolResult" }>],
        context: { systemPrompt: "system", messages: [], tools: [] },
        newMessages: [],
      }),
    ).toBe(false);
    guard.reset();
    expect(
      guard.shouldStopAfterTurn({
        message: assistantCall("call-3", "read") as Extract<AgentMessage, { role: "assistant" }>,
        toolResults: [toolResult("call-3", "read", "done") as Extract<AgentMessage, { role: "toolResult" }>],
        context: {
          systemPrompt: "system",
          messages: [{ role: "user", content: "x".repeat(100_000), timestamp: 1 }],
          tools: [],
        },
        newMessages: [],
      }),
    ).toEqual({ reason: "context-checkpoint" });
  });
});
