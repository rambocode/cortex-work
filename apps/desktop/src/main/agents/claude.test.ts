// claude adapter 单测：参数构造 + stream-json 行解析（事件形状取自
// claude 2.1.172 实测输出）。

import { describe, expect, it } from "vitest";
import { claudeAdapter } from "./claude";
import type { CliStartRequest } from "../ipc/types";

const baseReq: CliStartRequest = {
  runId: "r1",
  sessionId: "s1",
  agent: "claude",
  cwd: "/tmp/proj",
  prompt: "hello",
};

describe("claudeAdapter.buildArgs", () => {
  it("首轮:基础参数 + stream-json", () => {
    const { cmd, args } = claudeAdapter.buildArgs(baseReq);
    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("hello");
    expect(args.join(" ")).toContain("--output-format stream-json");
    expect(args).toContain("--include-partial-messages");
    expect(args).not.toContain("--resume");
  });

  it("多轮:带 --resume / --model / --append-system-prompt", () => {
    const { args } = claudeAdapter.buildArgs({
      ...baseReq,
      model: "opus",
      resumeSessionId: "sess-123",
      appendSystemPrompt: "skill content",
    });
    expect(args.join(" ")).toContain("--model opus");
    expect(args.join(" ")).toContain("--resume sess-123");
    expect(args.join(" ")).toContain("--append-system-prompt skill content");
  });

  it("skills 默认禁用:仅 useOwnSkills=true 时不带 --disable-slash-commands", () => {
    expect(claudeAdapter.buildArgs(baseReq).args).toContain("--disable-slash-commands");
    expect(claudeAdapter.buildArgs({ ...baseReq, useOwnSkills: false }).args).toContain("--disable-slash-commands");
    expect(claudeAdapter.buildArgs({ ...baseReq, useOwnSkills: true }).args).not.toContain("--disable-slash-commands");
  });

  it("纯净启动:始终清空 MCP(strict-mcp-config + 空 mcp-config)", () => {
    const { args } = claudeAdapter.buildArgs(baseReq);
    expect(args).toContain("--strict-mcp-config");
    const i = args.indexOf("--mcp-config");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('{"mcpServers":{}}');
  });

  it("推理强度:effort → --effort,缺省不带", () => {
    expect(claudeAdapter.buildArgs({ ...baseReq, effort: "high" }).args.join(" ")).toContain("--effort high");
    expect(claudeAdapter.buildArgs(baseReq).args).not.toContain("--effort");
  });

  it("图片:绝对路径 + 读取指令前置进 -p,在用户文本之前;缺省 -p 值=原 prompt", () => {
    const { args } = claudeAdapter.buildArgs({
      ...baseReq,
      images: [
        { path: "/abs/a.png", mimeType: "image/png" },
        { path: "/abs/b.jpg", mimeType: "image/jpeg" },
      ],
    });
    const prompt = args[args.indexOf("-p") + 1];
    expect(prompt).toContain("/abs/a.png");
    expect(prompt).toContain("/abs/b.jpg");
    // 图片引用在用户文本(hello)之前,且顺序保持
    expect(prompt.indexOf("/abs/a.png")).toBeLessThan(prompt.indexOf("/abs/b.jpg"));
    expect(prompt.indexOf("/abs/b.jpg")).toBeLessThan(prompt.indexOf("hello"));
    // 无图:逐字符回归
    const plain = claudeAdapter.buildArgs(baseReq).args;
    expect(plain[plain.indexOf("-p") + 1]).toBe("hello");
  });
});

describe("claudeAdapter.parseLine", () => {
  it("system.init → init 事件(捕获 session_id)", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "559c64e6" });
    expect(claudeAdapter.parseLine(line)).toEqual({ type: "init", sessionId: "559c64e6" });
  });

  it("其它 system 子类型(hook_started 等)忽略", () => {
    const line = JSON.stringify({ type: "system", subtype: "hook_started", session_id: "x" });
    expect(claudeAdapter.parseLine(line)).toBeNull();
  });

  it("stream_event text_delta → text 增量", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "1+1 等于 2。" } },
    });
    expect(claudeAdapter.parseLine(line)).toEqual({ type: "text", delta: "1+1 等于 2。" });
  });

  it("thinking_delta 忽略(不渲染思考过程)", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "..." } },
    });
    expect(claudeAdapter.parseLine(line)).toBeNull();
  });

  it("assistant 完整消息:只取 tool_use(text 已由 delta 覆盖,避免重复)", () => {
    const textMsg = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "1+1 等于 2。" }] },
    });
    expect(claudeAdapter.parseLine(textMsg)).toBeNull();

    const toolMsg = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] },
    });
    expect(claudeAdapter.parseLine(toolMsg)).toEqual({ type: "tool", name: "Bash", detail: "ls -la" });
  });

  it("result success → ok 事件带最终文本", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "1+1 等于 2。" });
    expect(claudeAdapter.parseLine(line)).toEqual({ type: "result", ok: true, text: "1+1 等于 2。", error: undefined });
  });

  it("result error → ok=false 带错误信息", () => {
    const line = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true });
    const ev = claudeAdapter.parseLine(line);
    expect(ev).toMatchObject({ type: "result", ok: false });
  });

  it("非 JSON / 未知行忽略且不抛", () => {
    expect(claudeAdapter.parseLine("not json")).toBeNull();
    expect(claudeAdapter.parseLine(JSON.stringify({ type: "rate_limit_event" }))).toBeNull();
  });
});
