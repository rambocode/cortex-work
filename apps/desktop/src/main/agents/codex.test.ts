// codex adapter 单测：参数构造 + codex exec --json 行解析（事件形状取自
// codex-cli 0.139.0 实测输出）。

import { describe, expect, it } from "vitest";
import { codexAdapter } from "./codex";
import type { CliStartRequest } from "../ipc/types";

const baseReq: CliStartRequest = {
  runId: "r1",
  sessionId: "s1",
  agent: "codex",
  cwd: "/tmp/proj",
  prompt: "hello",
};

describe("codexAdapter.buildArgs", () => {
  it("首轮:基础参数 + json + cwd + bypass", () => {
    const { cmd, args } = codexAdapter.buildArgs(baseReq);
    expect(cmd).toBe("codex");
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.join(" ")).toContain("--cd /tmp/proj");
    expect(args.at(-1)).toBe("hello");
  });

  it("多轮:使用 exec resume + session id + model", () => {
    const { args } = codexAdapter.buildArgs({
      ...baseReq,
      model: "gpt-5.4",
      resumeSessionId: "019eb656-4f8a-7841-846c-82bc4c0abee9",
    });
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(args.join(" ")).toContain("--model gpt-5.4");
    expect(args).not.toContain("--cd");
    expect(args.at(-2)).toBe("019eb656-4f8a-7841-846c-82bc4c0abee9");
    expect(args.at(-1)).toBe("hello");
  });

  it("纯净启动:始终带 -c mcp_servers={} 清空 MCP", () => {
    const first = codexAdapter.buildArgs(baseReq).args;
    let i = first.indexOf("-c");
    expect(first[i + 1]).toBe("mcp_servers={}");
    const resume = codexAdapter.buildArgs({ ...baseReq, resumeSessionId: "t1" }).args;
    i = resume.indexOf("-c");
    expect(resume[i + 1]).toBe("mcp_servers={}");
  });

  it("prompt 附件:拼入用户请求前置上下文", () => {
    const { args } = codexAdapter.buildArgs({
      ...baseReq,
      appendSystemPrompt: '<skill name="rule">Use concise Chinese.</skill>',
    });
    const prompt = args.at(-1);
    expect(prompt).toContain('<skill name="rule">Use concise Chinese.</skill>');
    expect(prompt).toContain("<user_request>\nhello\n</user_request>");
  });
});

describe("codexAdapter.parseLine", () => {
  it("thread.started → init 事件", () => {
    const line = JSON.stringify({ type: "thread.started", thread_id: "019eb656-4f8a-7841-846c-82bc4c0abee9" });
    expect(codexAdapter.parseLine(line)).toEqual({
      type: "init",
      sessionId: "019eb656-4f8a-7841-846c-82bc4c0abee9",
    });
  });

  it("command_execution item.started → tool 事件", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        id: "item_0",
        type: "command_execution",
        command: "/opt/homebrew/bin/zsh -lc pwd",
        status: "in_progress",
      },
    });
    expect(codexAdapter.parseLine(line)).toEqual({
      type: "tool",
      name: "Shell",
      detail: "/opt/homebrew/bin/zsh -lc pwd",
    });
  });

  it("agent_message item.completed → text 事件", () => {
    const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "OK" } });
    expect(codexAdapter.parseLine(line)).toEqual({ type: "text", delta: "OK" });
  });

  it("turn.completed → ok result 事件", () => {
    const line = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    expect(codexAdapter.parseLine(line)).toEqual({ type: "result", ok: true });
  });

  it("非 JSON / 未知行忽略且不抛", () => {
    expect(codexAdapter.parseLine("Reading additional input from stdin...")).toBeNull();
    expect(codexAdapter.parseLine(JSON.stringify({ type: "turn.started" }))).toBeNull();
  });
});
