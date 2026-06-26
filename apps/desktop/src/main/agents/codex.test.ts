// codex adapter 单测：参数构造 + codex exec --json 行解析（事件形状取自
// codex-cli 0.139.0 实测输出）。

import { describe, expect, it } from "vitest";
import { codexDef } from "./codex";
import type { CliStartRequest } from "../ipc/types";

const baseReq: CliStartRequest = {
  runId: "r1",
  sessionId: "s1",
  agent: "codex",
  cwd: "/tmp/proj",
  prompt: "hello",
};

describe("codexDef.buildArgs", () => {
  it("首轮:基础参数 + json + cwd + bypass,prompt 走 stdin(不在 argv)", () => {
    const { cmd, args, stdin } = codexDef.buildArgs(baseReq);
    expect(cmd).toBe("codex");
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.join(" ")).toContain("--cd /tmp/proj");
    expect(args).not.toContain("hello"); // prompt 不在 argv
    expect(args).not.toContain("-"); // 无 `-` 哨兵(否则 codex exit 2)
    expect(stdin).toBe("hello");
  });

  it("多轮:使用 exec resume + session id + model,prompt 走 stdin", () => {
    const { args, stdin } = codexDef.buildArgs({
      ...baseReq,
      model: "gpt-5.4",
      resumeSessionId: "019eb656-4f8a-7841-846c-82bc4c0abee9",
    });
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(args.join(" ")).toContain("--model gpt-5.4");
    expect(args).not.toContain("--cd");
    expect(args.at(-1)).toBe("019eb656-4f8a-7841-846c-82bc4c0abee9"); // threadId 为末位位置参数
    expect(stdin).toBe("hello");
  });

  it("续接(U4):continueSession → exec resume --last;与 resume id 互斥优先", () => {
    const cont = codexDef.buildArgs({ ...baseReq, continueSession: true }).args;
    expect(cont.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(cont).toContain("--last");
    expect(cont.at(-1)).toBe("--last"); // --last 在 common 之后、无 threadId
    // continue 优先于 resume id
    const both = codexDef.buildArgs({ ...baseReq, continueSession: true, resumeSessionId: "tid-1" }).args;
    expect(both).toContain("--last");
    expect(both).not.toContain("tid-1");
  });

  it("MCP(U2):默认不再写死 mcp_servers={};无 mcpArgs 时不注入(codex 原生继承 ~/.codex)", () => {
    expect(codexDef.buildArgs(baseReq).args).not.toContain("mcp_servers={}");
    expect(codexDef.buildArgs(baseReq).args.join(" ")).not.toContain("mcp_servers");
  });

  it("MCP(U2):传入 mcpArgs 时注入到 common(位置参数 threadId 之前)", () => {
    const mcpArgs = ["-c", 'mcp_servers.fs.command="/bin/fs"'];
    const first = codexDef.buildArgs(baseReq, mcpArgs).args;
    expect(first.join(" ")).toContain('mcp_servers.fs.command="/bin/fs"');
    const resume = codexDef.buildArgs({ ...baseReq, resumeSessionId: "tid-1" }, mcpArgs).args;
    const ci = resume.lastIndexOf('mcp_servers.fs.command="/bin/fs"');
    expect(ci).toBeLessThan(resume.indexOf("tid-1")); // 注入在 threadId 之前
  });

  it("prompt 附件:拼入用户请求前置上下文(经 stdin)", () => {
    const { stdin } = codexDef.buildArgs({
      ...baseReq,
      appendSystemPrompt: '<skill name="rule">Use concise Chinese.</skill>',
    });
    expect(stdin).toContain('<skill name="rule">Use concise Chinese.</skill>');
    expect(stdin).toContain("<user_request>\nhello\n</user_request>");
  });

  it("运行模式:plan → sandbox_mode=read-only + approval_policy=never,无 bypass,无 -s", () => {
    const { args } = codexDef.buildArgs({ ...baseReq, permissionMode: "plan" });
    expect(args).toContain("sandbox_mode=read-only");
    expect(args).toContain("approval_policy=never");
    expect(args).not.toContain("-s"); // resume 子命令不接受 -s,sandbox 统一走 -c sandbox_mode
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("运行模式:accept-edits → sandbox_mode=workspace-write + approval_policy=never,无 -s", () => {
    const { args } = codexDef.buildArgs({ ...baseReq, permissionMode: "accept-edits" });
    expect(args).toContain("sandbox_mode=workspace-write");
    expect(args).toContain("approval_policy=never");
    expect(args).not.toContain("-s");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("运行模式:full-auto 与缺省均回退 bypass(回归);任何档位都不出现 --ask-for-approval/--full-auto", () => {
    expect(codexDef.buildArgs({ ...baseReq, permissionMode: "full-auto" }).args).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(codexDef.buildArgs(baseReq).args).toContain("--dangerously-bypass-approvals-and-sandbox");
    for (const m of ["plan", "accept-edits", "full-auto"] as const) {
      const { args } = codexDef.buildArgs({ ...baseReq, permissionMode: m });
      expect(args).not.toContain("--ask-for-approval");
      expect(args).not.toContain("--full-auto");
    }
  });

  it("运行模式:resume 分支模式标志在 threadId 之前;prompt 走 stdin", () => {
    const { args, stdin } = codexDef.buildArgs({ ...baseReq, permissionMode: "plan", resumeSessionId: "tid-1" });
    expect(args.indexOf("sandbox_mode=read-only")).toBeLessThan(args.indexOf("tid-1"));
    expect(args.at(-1)).toBe("tid-1");
    expect(stdin).toBe("hello");
  });

  // 回归:`codex exec resume` 子命令不接受 -s(实测 `error: unexpected argument '-s' found`)。
  // 续接 + 非 full-auto 模式必须只用 -c sandbox_mode,绝不出现 -s,否则 spawn 即报错。
  it("回归:resume + plan/accept-edits 绝不出现 -s(走 exec resume 子命令)", () => {
    for (const mode of ["plan", "accept-edits"] as const) {
      const cont = codexDef.buildArgs({ ...baseReq, permissionMode: mode, continueSession: true }).args;
      expect(cont.slice(0, 2)).toEqual(["exec", "resume"]);
      expect(cont).not.toContain("-s");
      const byId = codexDef.buildArgs({ ...baseReq, permissionMode: mode, resumeSessionId: "tid-1" }).args;
      expect(byId.slice(0, 2)).toEqual(["exec", "resume"]);
      expect(byId).not.toContain("-s");
    }
  });

  it("目录授权:writableExtraDirs → -c sandbox_workspace_write.writable_roots(TOML 数组);缺省不带", () => {
    const { args } = codexDef.buildArgs({
      ...baseReq,
      permissionMode: "accept-edits",
      writableExtraDirs: ["/a", "/b"],
    });
    expect(args.join(" ")).toContain('sandbox_workspace_write.writable_roots=["/a","/b"]');
    expect(codexDef.buildArgs(baseReq).args.join(" ")).not.toContain("writable_roots");
  });

  it("目录授权:resume 分支同样走 -c writable_roots(不依赖 exec-only 的 --add-dir)", () => {
    const { args } = codexDef.buildArgs({
      ...baseReq,
      permissionMode: "accept-edits",
      resumeSessionId: "tid-1",
      writableExtraDirs: ["/a"],
    });
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args).not.toContain("--add-dir");
    expect(args.join(" ")).toContain('sandbox_workspace_write.writable_roots=["/a"]');
  });

  it("推理强度:effort → -c model_reasoning_effort=,缺省不带", () => {
    const { args } = codexDef.buildArgs({ ...baseReq, effort: "low" });
    const i = args.indexOf("model_reasoning_effort=low");
    expect(i).toBeGreaterThan(-1);
    expect(args[i - 1]).toBe("-c");
    expect(codexDef.buildArgs(baseReq).args.join(" ")).not.toContain("model_reasoning_effort");
  });

  it("图片:每张 --image 绝对路径,顺序保持;prompt 走 stdin 不含路径", () => {
    const { args, stdin } = codexDef.buildArgs({
      ...baseReq,
      images: [
        { path: "/abs/a.png", mimeType: "image/png" },
        { path: "/abs/b.webp", mimeType: "image/webp" },
      ],
    });
    const imgPos = args.reduce<number[]>((acc, a, idx) => (a === "--image" ? [...acc, idx] : acc), []);
    expect(imgPos.length).toBe(2);
    expect(args[imgPos[0] + 1]).toBe("/abs/a.png");
    expect(args[imgPos[1] + 1]).toBe("/abs/b.webp"); // 顺序保持
    expect(stdin).toBe("hello"); // prompt 走 stdin
    expect(stdin).not.toContain("/abs/"); // prompt 不含图片路径(避开 consent 拦截)
  });

  it("图片:resume 分支 --image 在位置参数(threadId)之前;prompt 走 stdin", () => {
    const { args, stdin } = codexDef.buildArgs({
      ...baseReq,
      resumeSessionId: "tid-1",
      images: [{ path: "/abs/a.png", mimeType: "image/png" }],
    });
    const imgIdx = args.indexOf("--image");
    expect(imgIdx).toBeGreaterThan(-1);
    expect(imgIdx).toBeLessThan(args.indexOf("tid-1")); // --image 在 threadId 之前
    expect(stdin).toBe("hello");
  });

  it("无图:args 不含 --image(回归)", () => {
    expect(codexDef.buildArgs(baseReq).args).not.toContain("--image");
  });
});

describe("codexDef.parseLine", () => {
  it("thread.started → init 事件", () => {
    const line = JSON.stringify({ type: "thread.started", thread_id: "019eb656-4f8a-7841-846c-82bc4c0abee9" });
    expect(codexDef.parseLine(line)).toEqual({
      type: "init",
      sessionId: "019eb656-4f8a-7841-846c-82bc4c0abee9",
    });
  });

  it("command_execution item.started → tool 事件(归一化名 Shell + phase/toolCallId,R2)", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        id: "item_0",
        type: "command_execution",
        command: "/opt/homebrew/bin/zsh -lc pwd",
        status: "in_progress",
      },
    });
    expect(codexDef.parseLine(line)).toEqual({
      type: "tool",
      name: "Shell",
      detail: "/opt/homebrew/bin/zsh -lc pwd",
      phase: "start",
      toolCallId: "item_0",
    });
  });

  it("tool 名归一化(R2):file_change→Edit、web_search→WebSearch、mcp_tool_call→MCP", () => {
    const ev = (item: Record<string, unknown>) =>
      codexDef.parseLine(JSON.stringify({ type: "item.started", item }));
    expect(ev({ id: "i1", type: "file_change", path: "/a/b.ts" })).toEqual({
      type: "tool",
      name: "Edit",
      detail: "/a/b.ts",
      phase: "start",
      toolCallId: "i1",
    });
    expect(ev({ id: "i2", type: "web_search", query: "vitest" })).toMatchObject({ name: "WebSearch", detail: "vitest" });
    expect(ev({ id: "i3", type: "mcp_tool_call", tool: "fs.read" })).toMatchObject({ name: "MCP", detail: "fs.read" });
  });

  it("未知工具类型不当作 tool(reasoning/agent_message 不产 tool 事件)", () => {
    expect(codexDef.parseLine(JSON.stringify({ type: "item.started", item: { id: "x", type: "reasoning" } }))).toBeNull();
  });

  it("agent_message item.completed → text 事件", () => {
    const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "OK" } });
    expect(codexDef.parseLine(line)).toEqual({ type: "text", delta: "OK" });
  });

  it("turn.completed 带 usage → [usage, result] 两事件(usage 在前)", () => {
    const line = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 3 },
    });
    expect(codexDef.parseLine(line)).toEqual([
      { type: "usage", inputTokens: 10, outputTokens: 5, cachedInputTokens: 3 },
      { type: "result", ok: true },
    ]);
  });

  it("turn.completed 无 usage → 仅 result(降级,不产空 usage)", () => {
    expect(codexDef.parseLine(JSON.stringify({ type: "turn.completed" }))).toEqual({ type: "result", ok: true });
  });

  it("turn.completed usage 字段类型异常 → 仅 result(降级不抛)", () => {
    const line = JSON.stringify({ type: "turn.completed", usage: { input_tokens: "x" } });
    expect(codexDef.parseLine(line)).toEqual({ type: "result", ok: true });
  });

  it("非 JSON / 未知行忽略且不抛", () => {
    expect(codexDef.parseLine("Reading additional input from stdin...")).toBeNull();
    expect(codexDef.parseLine(JSON.stringify({ type: "turn.started" }))).toBeNull();
  });
});
