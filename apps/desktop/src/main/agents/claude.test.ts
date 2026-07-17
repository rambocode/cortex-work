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

  it("原生 skill(U3):useOwnSkills=true 且 skillsBridgeDir 有值 → --add-dir <dir>,不带 --disable-slash-commands", () => {
    const { args } = claudeDef.buildArgs({
      ...baseReq,
      useOwnSkills: true,
      skillsBridgeDir: "/tmp/skill-bridge/s1",
    });
    expect(args.join(" ")).toContain("--add-dir /tmp/skill-bridge/s1");
    expect(args).not.toContain("--disable-slash-commands");
  });

  it("原生 skill(U3):useOwnSkills!==true → --disable-slash-commands,不带 --add-dir(回归)", () => {
    // 即便误传了 skillsBridgeDir,关闭开关时也不应追加 --add-dir
    const off = claudeDef.buildArgs({ ...baseReq, skillsBridgeDir: "/tmp/skill-bridge/s1" }).args;
    expect(off).toContain("--disable-slash-commands");
    expect(off).not.toContain("--add-dir");
    const explicitOff = claudeDef.buildArgs({
      ...baseReq,
      useOwnSkills: false,
      skillsBridgeDir: "/tmp/skill-bridge/s1",
    }).args;
    expect(explicitOff).toContain("--disable-slash-commands");
    expect(explicitOff).not.toContain("--add-dir");
  });

  it("原生 skill(U3):useOwnSkills=true 但无 skillsBridgeDir(无已启用 skill) → 既不 --add-dir 也不 --disable-slash-commands", () => {
    const { args } = claudeDef.buildArgs({ ...baseReq, useOwnSkills: true });
    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("--disable-slash-commands");
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

  it("acceptEdits + 内置 MCP server → --allowed-tools 整体预授权(print 模式无人可批权限弹窗)", () => {
    const { args } = claudeDef.buildArgs({
      ...baseReq,
      permissionMode: "accept-edits",
      builtinMcpServers: ["cortex-slides", "cortex-design-delegate"],
    });
    expect(args.join(" ")).toContain("--allowed-tools mcp__cortex-slides,mcp__cortex-design-delegate");
  });

  it("plan / full-auto 不追加 --allowed-tools(plan 保只读承诺;bypass 本就全放行)", () => {
    const withServers = { ...baseReq, builtinMcpServers: ["cortex-slides"] };
    expect(claudeDef.buildArgs({ ...withServers, permissionMode: "plan" }).args).not.toContain("--allowed-tools");
    expect(claudeDef.buildArgs({ ...withServers, permissionMode: "full-auto" }).args).not.toContain("--allowed-tools");
    // 无内置 server 时 acceptEdits 也不追加。
    expect(claudeDef.buildArgs({ ...baseReq, permissionMode: "accept-edits" }).args).not.toContain("--allowed-tools");
  });

  it("运行模式:full-auto 与缺省均回退 --dangerously-skip-permissions(回归)", () => {
    expect(claudeDef.buildArgs({ ...baseReq, permissionMode: "full-auto" }).args).toContain(
      "--dangerously-skip-permissions",
    );
    const def = claudeDef.buildArgs(baseReq).args;
    expect(def).toContain("--dangerously-skip-permissions");
    expect(def.join(" ")).not.toContain("--permission-mode");
  });

  it("访问范围:sandbox(外部沙箱)降级为 acceptEdits(claude 无原生沙箱)", () => {
    const { args } = claudeDef.buildArgs({ ...baseReq, permissionMode: "sandbox" });
    expect(args.join(" ")).toContain("--permission-mode acceptEdits");
    expect(args).not.toContain("--dangerously-skip-permissions");
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

  it("assistant 完整消息:只取 tool_use(text 已由 delta 覆盖,避免重复)+ phase/toolCallId + 完整 input", () => {
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
      input: { command: "ls -la" },
      phase: "start",
      toolCallId: "toolu_1",
    });
  });

  it("assistant 消息含多个 tool_use(并行调用)→ 逐块产出 start 事件数组", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", id: "toolu_b", name: "Grep", input: { pattern: "foo" } },
        ],
      },
    });
    expect(claudeDef.parseLine(line)).toEqual([
      { type: "tool", name: "Read", detail: "/a.ts", input: { file_path: "/a.ts" }, phase: "start", toolCallId: "toolu_a" },
      { type: "tool", name: "Grep", detail: "foo", input: { pattern: "foo" }, phase: "start", toolCallId: "toolu_b" },
    ]);
  });

  it("user tool_result(string content)→ tool phase:end 带输出与 toolCallId", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "total 8\ndrwxr-xr-x" }] },
    });
    expect(claudeDef.parseLine(line)).toEqual({
      type: "tool",
      name: "",
      phase: "end",
      toolCallId: "toolu_1",
      output: "total 8\ndrwxr-xr-x",
      isError: false,
    });
  });

  it("user tool_result(content block 数组)→ 拼接 text 块;is_error 透出", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            is_error: true,
            content: [
              { type: "text", text: "line1" },
              { type: "text", text: "line2" },
            ],
          },
        ],
      },
    });
    expect(claudeDef.parseLine(line)).toEqual({
      type: "tool",
      name: "",
      phase: "end",
      toolCallId: "toolu_2",
      output: "line1\nline2",
      isError: true,
    });
  });

  it("user 消息不含 tool_result(纯文本回灌)→ null;超长输出截断到 8000", () => {
    const textOnly = JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    expect(claudeDef.parseLine(textOnly)).toBeNull();

    const long = "x".repeat(20_000);
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_3", content: long }] },
    });
    const ev = claudeDef.parseLine(line);
    expect(ev).toMatchObject({ type: "tool", phase: "end", toolCallId: "toolu_3" });
    const output = (ev as { output: string }).output;
    expect(output.length).toBe(8_001); // 8000 + 截断省略号
    expect(output.endsWith("…")).toBe(true);
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

// 已知忽略帧声明:dev 启动实测「未映射的 claude 输出帧」被 stream_event 生命周期子帧、
// system 信息性子类型、assistant/user 非工具帧刷屏,声明为已知忽略以降噪;
// 未知子类型保持可观测(协议漂移告警)。
describe("claudeDef 已知忽略帧(盲区补点降噪)", () => {
  it("ignoredFrameTypes:assistant/user/rate_limit_event 按顶层 type 已知忽略", () => {
    // assistant 无 tool_use(text/thinking 已由 stream 增量覆盖)与 user 无 tool_result
    // (skill 注入等回灌)本就 return null,属已评审忽略;rate_limit_event 为信息性帧。
    for (const t of ["assistant", "user", "rate_limit_event"]) {
      expect(claudeDef.ignoredFrameTypes?.has(t)).toBe(true);
    }
  });

  it("stream_event 生命周期子帧(content_block_start/stop、message_start/stop)→ 已知忽略", () => {
    for (const sub of ["content_block_start", "content_block_stop", "message_start", "message_stop"]) {
      expect(claudeDef.isIgnoredFrame?.({ type: "stream_event", event: { type: sub } })).toBe(true);
    }
  });

  it("content_block_delta 的 signature_delta / input_json_delta → 已知忽略(完整 input 由 assistant 帧承载)", () => {
    for (const dt of ["signature_delta", "input_json_delta"]) {
      expect(
        claudeDef.isIgnoredFrame?.({ type: "stream_event", event: { type: "content_block_delta", delta: { type: dt } } }),
      ).toBe(true);
    }
  });

  it("content_block_delta 未知 delta 类型 → 不忽略(保留协议漂移告警)", () => {
    expect(
      claudeDef.isIgnoredFrame?.({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "brand_new" } } }),
    ).toBe(false);
    expect(claudeDef.isIgnoredFrame?.({ type: "stream_event", event: { type: "content_block_delta" } })).toBe(false);
  });

  it("stream_event 未知子帧 / 无 stop_reason 的 message_delta → 不忽略", () => {
    expect(claudeDef.isIgnoredFrame?.({ type: "stream_event", event: { type: "brand_new_event" } })).toBe(false);
    expect(claudeDef.isIgnoredFrame?.({ type: "stream_event", event: { type: "message_delta", delta: {} } })).toBe(false);
    expect(claudeDef.isIgnoredFrame?.({ type: "stream_event" })).toBe(false);
  });

  it("system 信息性子类型(status/thinking_tokens/hook_*/task_*)→ 已知忽略", () => {
    for (const sub of [
      "status",
      "thinking_tokens",
      "hook_started",
      "hook_response",
      "hook_progress",
      "task_started",
      "task_notification",
    ]) {
      expect(claudeDef.isIgnoredFrame?.({ type: "system", subtype: sub })).toBe(true);
    }
  });

  it("system 未知子类型 → 不忽略(新协议帧保持可观测)", () => {
    expect(claudeDef.isIgnoredFrame?.({ type: "system", subtype: "brand_new_subtype" })).toBe(false);
    expect(claudeDef.isIgnoredFrame?.({ type: "system" })).toBe(false);
  });

  it("其它顶层 type → 不忽略(交由 ignoredFrameTypes 集合判定)", () => {
    expect(claudeDef.isIgnoredFrame?.({ type: "result" })).toBe(false);
  });
});
