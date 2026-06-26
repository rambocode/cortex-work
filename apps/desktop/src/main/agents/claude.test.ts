// claude adapter 单测：参数构造 + stream-json 行解析（事件形状取自
// claude 2.1.172 实测输出）。

import { describe, expect, it } from "vitest";
import { claudeDef } from "./claude";
import type { CliStartRequest } from "../ipc/types";

const baseReq: CliStartRequest = {
  runId: "r1",
  sessionId: "s1",
  agent: "claude",
  cwd: "/tmp/proj",
  prompt: "hello",
};

describe("claudeDef.buildArgs", () => {
  it("首轮:基础参数 + stream-json,prompt 走 stdin(不在 argv)", () => {
    const { cmd, args, stdin } = claudeDef.buildArgs(baseReq);
    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args.join(" ")).toContain("--input-format stream-json");
    expect(args.join(" ")).toContain("--output-format stream-json");
    expect(args).toContain("--include-partial-messages");
    expect(args).not.toContain("hello"); // prompt 不再进 argv
    expect(args).not.toContain("--resume");
    // prompt 经 stdin 以 user message JSONL 投递
    const msg = JSON.parse(stdin!);
    expect(msg).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
  });

  it("多轮:带 --resume / --model / --append-system-prompt", () => {
    const { args } = claudeDef.buildArgs({
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
    expect(claudeDef.buildArgs(baseReq).args).toContain("--disable-slash-commands");
    expect(claudeDef.buildArgs({ ...baseReq, useOwnSkills: false }).args).toContain("--disable-slash-commands");
    expect(claudeDef.buildArgs({ ...baseReq, useOwnSkills: true }).args).not.toContain("--disable-slash-commands");
  });

  it("续接(U4):continueSession → --continue;与 resume 互斥优先", () => {
    expect(claudeDef.buildArgs({ ...baseReq, continueSession: true }).args).toContain("--continue");
    // continue 优先于 resume id
    const both = claudeDef.buildArgs({ ...baseReq, continueSession: true, resumeSessionId: "s1" }).args;
    expect(both).toContain("--continue");
    expect(both).not.toContain("--resume");
    // 仅 resume id 时仍走 --resume(回归)
    const r = claudeDef.buildArgs({ ...baseReq, resumeSessionId: "s1" }).args;
    expect(r.join(" ")).toContain("--resume s1");
    expect(r).not.toContain("--continue");
  });

  it("MCP(U2):不再写死清空,args 不含 strict-mcp-config / mcp-config(改由 cwd .mcp.json 文件注入)", () => {
    const { args } = claudeDef.buildArgs(baseReq);
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
  });

  it("运行模式:plan → --permission-mode plan,不带跳审批标志", () => {
    const { args } = claudeDef.buildArgs({ ...baseReq, permissionMode: "plan" });
    expect(args.join(" ")).toContain("--permission-mode plan");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("运行模式:accept-edits → --permission-mode acceptEdits", () => {
    const { args } = claudeDef.buildArgs({ ...baseReq, permissionMode: "accept-edits" });
    expect(args.join(" ")).toContain("--permission-mode acceptEdits");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("运行模式:full-auto 与缺省均回退 --dangerously-skip-permissions(回归)", () => {
    expect(claudeDef.buildArgs({ ...baseReq, permissionMode: "full-auto" }).args).toContain(
      "--dangerously-skip-permissions",
    );
    const def = claudeDef.buildArgs(baseReq).args;
    expect(def).toContain("--dangerously-skip-permissions");
    expect(def.join(" ")).not.toContain("--permission-mode");
  });

  it("目录授权:writableExtraDirs → 逐个 --add-dir;缺省不带", () => {
    const { args } = claudeDef.buildArgs({
      ...baseReq,
      permissionMode: "accept-edits",
      writableExtraDirs: ["/a", "/b"],
    });
    expect(args.join(" ")).toContain("--add-dir /a");
    expect(args.join(" ")).toContain("--add-dir /b");
    expect(claudeDef.buildArgs(baseReq).args).not.toContain("--add-dir");
  });

  it("推理强度:effort → --effort,缺省不带", () => {
    expect(claudeDef.buildArgs({ ...baseReq, effort: "high" }).args.join(" ")).toContain("--effort high");
    expect(claudeDef.buildArgs(baseReq).args).not.toContain("--effort");
  });

  it("图片:绝对路径 + 读取指令前置进 stdin 文本,在用户文本之前;无图=原 prompt", () => {
    const { stdin } = claudeDef.buildArgs({
      ...baseReq,
      images: [
        { path: "/abs/a.png", mimeType: "image/png" },
        { path: "/abs/b.jpg", mimeType: "image/jpeg" },
      ],
    });
    const text: string = JSON.parse(stdin!).message.content[0].text;
    expect(text).toContain("/abs/a.png");
    expect(text).toContain("/abs/b.jpg");
    // 图片引用在用户文本(hello)之前,且顺序保持
    expect(text.indexOf("/abs/a.png")).toBeLessThan(text.indexOf("/abs/b.jpg"));
    expect(text.indexOf("/abs/b.jpg")).toBeLessThan(text.indexOf("hello"));
    // 无图:stdin 文本=原 prompt
    const plain = claudeDef.buildArgs(baseReq);
    expect(JSON.parse(plain.stdin!).message.content[0].text).toBe("hello");
  });
});

describe("claudeDef.parseLine", () => {
  it("system.init → init 事件(捕获 session_id)", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "559c64e6" });
    expect(claudeDef.parseLine(line)).toEqual({ type: "init", sessionId: "559c64e6" });
  });

  it("其它 system 子类型(hook_started 等)忽略", () => {
    const line = JSON.stringify({ type: "system", subtype: "hook_started", session_id: "x" });
    expect(claudeDef.parseLine(line)).toBeNull();
  });

  it("stream_event text_delta → text 增量", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "1+1 等于 2。" } },
    });
    expect(claudeDef.parseLine(line)).toEqual({ type: "text", delta: "1+1 等于 2。" });
  });

  it("thinking_delta → thinking 事件(R2:采集思考增量)", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "让我想想" } },
    });
    expect(claudeDef.parseLine(line)).toEqual({ type: "thinking", delta: "让我想想" });
  });

  it("message_delta stop_reason → turn 事件(R2/R1 轮边界)", () => {
    const endTurn = JSON.stringify({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
    });
    expect(claudeDef.parseLine(endTurn)).toEqual({ type: "turn", stopReason: "end_turn" });
    const toolUse = JSON.stringify({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
    });
    expect(claudeDef.parseLine(toolUse)).toEqual({ type: "turn", stopReason: "tool_use" });
  });

  it("assistant 完整消息:只取 tool_use(text 已由 delta 覆盖,避免重复)+ phase/toolCallId", () => {
    const textMsg = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "1+1 等于 2。" }] },
    });
    expect(claudeDef.parseLine(textMsg)).toBeNull();

    const toolMsg = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } }] },
    });
    expect(claudeDef.parseLine(toolMsg)).toEqual({
      type: "tool",
      name: "Bash",
      detail: "ls -la",
      phase: "start",
      toolCallId: "toolu_1",
    });
  });

  it("result success → ok 事件带最终文本", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "1+1 等于 2。" });
    expect(claudeDef.parseLine(line)).toEqual({ type: "result", ok: true, text: "1+1 等于 2。", error: undefined });
  });

  it("result error → ok=false 带错误信息", () => {
    const line = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true });
    const ev = claudeDef.parseLine(line);
    expect(ev).toMatchObject({ type: "result", ok: false });
  });

  it("result 带 usage + cost → [usage, result] 两事件(usage 在前,缓存命中映射)", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      total_cost_usd: 0.0123,
    });
    expect(claudeDef.parseLine(line)).toEqual([
      { type: "usage", inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, costUsd: 0.0123 },
      { type: "result", ok: true, text: "done", error: undefined },
    ]);
  });

  it("result 无 usage/cost → 仅 result(降级,不产空 usage)", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "x" });
    expect(claudeDef.parseLine(line)).toEqual({ type: "result", ok: true, text: "x", error: undefined });
  });

  it("非 JSON / 未知行忽略且不抛", () => {
    expect(claudeDef.parseLine("not json")).toBeNull();
    expect(claudeDef.parseLine(JSON.stringify({ type: "rate_limit_event" }))).toBeNull();
  });
});
