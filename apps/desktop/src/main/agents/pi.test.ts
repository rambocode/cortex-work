// pi adapter 单测：参数构造 + --mode json 行解析（事件形状取自
// @earendil-works/pi-coding-agent 0.79.2 实测输出）。
// pi-locate 依赖 electron app,这里 mock 成固定路径避免引入运行时依赖。

import { describe, expect, it, vi } from "vitest";

vi.mock("./pi-locate", () => ({
  resolvePiCliEntry: () => "/fake/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
}));

import { piAdapter } from "./pi";
import type { CliStartRequest } from "../ipc/types";

const CLI = "/fake/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

const baseReq: CliStartRequest = {
  runId: "r1",
  sessionId: "s1",
  agent: "pi",
  cwd: "/tmp/proj",
  prompt: "hello",
};

describe("piAdapter.buildArgs", () => {
  it("首轮:cli.js + --mode json + -p + --no-extensions + --no-skills,prompt 在末位", () => {
    const { cmd, args } = piAdapter.buildArgs(baseReq);
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toBe(CLI);
    expect(args.join(" ")).toContain("--mode json");
    expect(args).toContain("-p");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-skills");
    expect(args.at(-1)).toBe("hello");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--session");
    expect(args).not.toContain("--append-system-prompt");
  });

  it("skills:仅 useOwnSkills=true 时省略 --no-skills", () => {
    expect(piAdapter.buildArgs(baseReq).args).toContain("--no-skills");
    expect(piAdapter.buildArgs({ ...baseReq, useOwnSkills: false }).args).toContain("--no-skills");
    expect(piAdapter.buildArgs({ ...baseReq, useOwnSkills: true }).args).not.toContain("--no-skills");
  });

  it("多轮:model / resumeSessionId / appendSystemPrompt 各自透传,prompt 仍在末位", () => {
    const { args } = piAdapter.buildArgs({
      ...baseReq,
      model: "openai/gpt-5.5",
      resumeSessionId: "019ebe91-aaaa-7775-b82f-9810d333859a",
      appendSystemPrompt: "Use concise Chinese.",
    });
    expect(args.join(" ")).toContain("--model openai/gpt-5.5");
    expect(args.join(" ")).toContain("--session 019ebe91-aaaa-7775-b82f-9810d333859a");
    expect(args.join(" ")).toContain("--append-system-prompt Use concise Chinese.");
    expect(args.at(-1)).toBe("hello");
  });

  it("自定义供应商:piExtensionPath → -e/-a,provider.id → --provider", () => {
    const { args } = piAdapter.buildArgs({
      ...baseReq,
      model: "deepseek-chat",
      piExtensionPath: "/data/pi-providers/deepseek.js",
      provider: { id: "deepseek", baseUrl: "https://api.deepseek.com/v1", models: [{ id: "deepseek-chat" }] },
    });
    expect(args.join(" ")).toContain("-e /data/pi-providers/deepseek.js");
    expect(args).toContain("-a");
    expect(args.join(" ")).toContain("--provider deepseek");
    expect(args.join(" ")).toContain("--model deepseek-chat");
    expect(args.at(-1)).toBe("hello");
  });

  it("无 piExtensionPath:不加 -e/-a/--provider（pi 用自身默认 provider）", () => {
    const { args } = piAdapter.buildArgs(baseReq);
    expect(args).not.toContain("-e");
    expect(args).not.toContain("-a");
    expect(args).not.toContain("--provider");
  });

  it("推理强度:pi 无对应 flag,effort 被忽略", () => {
    const { args } = piAdapter.buildArgs({ ...baseReq, effort: "high" });
    expect(args.join(" ")).not.toContain("effort");
    expect(args.join(" ")).not.toContain("reasoning");
  });
});

describe("piAdapter.parseLine", () => {
  it("session → init 事件(捕获 id)", () => {
    const line = JSON.stringify({
      type: "session",
      version: 3,
      id: "019ebe91-aaaa-7775-b82f-9810d333859a",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: "/private/tmp/x",
    });
    expect(piAdapter.parseLine(line)).toEqual({
      type: "init",
      sessionId: "019ebe91-aaaa-7775-b82f-9810d333859a",
    });
  });

  it("message_update text_delta → text 增量", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: {} },
      message: {},
    });
    expect(piAdapter.parseLine(line)).toEqual({ type: "text", delta: "Hello" });
  });

  it("tool_execution_start → tool 事件(detail 取 command)", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "ls -la" },
    });
    expect(piAdapter.parseLine(line)).toEqual({ type: "tool", name: "bash", detail: "ls -la" });
  });

  it("message_end stopReason=stop → ok result 带拼接文本", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "PING" }],
        stopReason: "stop",
        usage: {},
      },
    });
    expect(piAdapter.parseLine(line)).toEqual({ type: "result", ok: true, text: "PING" });
  });

  it("message_end stopReason=error → ok=false 带 diagnostics 错误", () => {
    // 陷阱样例：provider 失败时进程仍 exit 0,错误只在这条事件里。
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "provider failed",
        diagnostics: [{ type: "provider_transport_failure", error: { message: "WebSocket error" } }],
      },
    });
    expect(piAdapter.parseLine(line)).toEqual({ type: "result", ok: false, error: "provider failed" });
  });

  it("message_end stopReason=error 无 errorMessage → 回退到 diagnostics", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        diagnostics: [{ type: "provider_transport_failure", error: { message: "WebSocket error" } }],
      },
    });
    expect(piAdapter.parseLine(line)).toEqual({ type: "result", ok: false, error: "WebSocket error" });
  });

  it("message_end stopReason=aborted → ok=false(无错误信息时回退 stopReason 文本)", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "aborted" },
    });
    expect(piAdapter.parseLine(line)).toEqual({ type: "result", ok: false, error: "aborted" });
  });

  it("message_end stopReason=toolUse → null(中间轮,不发 result)", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "toolUse" },
    });
    expect(piAdapter.parseLine(line)).toBeNull();
  });

  it("agent_end / 其它事件 → null", () => {
    expect(piAdapter.parseLine(JSON.stringify({ type: "agent_end" }))).toBeNull();
    expect(piAdapter.parseLine(JSON.stringify({ type: "turn_start" }))).toBeNull();
    expect(piAdapter.parseLine(JSON.stringify({ type: "message_start" }))).toBeNull();
  });

  it("非 JSON / 形状不符 → null 且不抛", () => {
    expect(piAdapter.parseLine("not json")).toBeNull();
    expect(piAdapter.parseLine(JSON.stringify({ type: "session" }))).toBeNull();
  });
});
