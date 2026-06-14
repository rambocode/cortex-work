// 会话记忆截断单测:行定位(claude/codex 真实行形状)+ 文件截断与备份。
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { agentSessionExists, claudeTrimIndex, codexTrimIndex, trimSessionFile } from "./session-trim";

// ── claude:~/.claude/projects/<dir>/<session>.jsonl 的行形状 ──────────────
function claudeUser(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: text }, ...extra });
}
const claudeLines = [
  JSON.stringify({ type: "mode", mode: "normal" }),
  JSON.stringify({ type: "file-history-snapshot", messageId: "m0" }),
  claudeUser("第一问"),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "第一答" }] } }),
  claudeUser("继续"),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "第二答" }] } }),
  claudeUser("继续"),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "第三答" }] } }),
];

describe("claudeTrimIndex", () => {
  it("按原文定位用户轮所在行", () => {
    expect(claudeTrimIndex(claudeLines, "第一问", 0)).toBe(2);
  });

  it("同文多轮:按同文序号区分", () => {
    expect(claudeTrimIndex(claudeLines, "继续", 0)).toBe(4);
    expect(claudeTrimIndex(claudeLines, "继续", 1)).toBe(6);
  });

  it("找不到 / 序号越界 / sidechain 行不计入 → -1", () => {
    expect(claudeTrimIndex(claudeLines, "不存在", 0)).toBe(-1);
    expect(claudeTrimIndex(claudeLines, "继续", 2)).toBe(-1);
    const withSidechain = [claudeUser("子任务", { isSidechain: true }), ...claudeLines];
    expect(claudeTrimIndex(withSidechain, "子任务", 0)).toBe(-1);
  });

  it("content 为块数组(text 块)也能匹配", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        isSidechain: false,
        message: { role: "user", content: [{ type: "text", text: "块消息" }] },
      }),
    ];
    expect(claudeTrimIndex(lines, "块消息", 0)).toBe(0);
  });
});

// ── codex:rollout-*.jsonl 的行形状 ────────────────────────────────────────
function codexUser(text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
}
const codexLines = [
  JSON.stringify({ type: "session_meta", payload: { id: "t1" } }),
  codexUser("# AGENTS.md instructions ..."),
  codexUser("第一问"),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } }),
  codexUser("<skill>规则</skill>\n\n<user_request>\n带附件的问题\n</user_request>"),
];

describe("codexTrimIndex", () => {
  it("按原文定位用户轮", () => {
    expect(codexTrimIndex(codexLines, "第一问", 0)).toBe(2);
  });

  it("带附件时按 <user_request> 包装匹配", () => {
    expect(codexTrimIndex(codexLines, "带附件的问题", 0)).toBe(4);
  });

  it("找不到返回 -1(AGENTS 指令行不会误匹配)", () => {
    expect(codexTrimIndex(codexLines, "不存在", 0)).toBe(-1);
  });
});

describe("trimSessionFile", () => {
  it("截断到目标行之前并写 .bak 备份", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trim-"));
    const path = join(dir, "s1.jsonl");
    const raw = claudeLines.join("\n") + "\n";
    writeFileSync(path, raw, "utf8");

    await trimSessionFile(path, raw, 4); // 截掉「继续」(第 0 个)及其后
    const kept = readFileSync(path, "utf8");
    expect(kept.trim().split("\n")).toHaveLength(4);
    expect(kept).toContain("第一答");
    expect(kept).not.toContain("第二答");
    expect(readFileSync(path + ".bak", "utf8")).toBe(raw);
  });
});

describe("agentSessionExists", () => {
  it("Codex:递归匹配 rollout 文件名末尾的 thread id", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-session-"));
    const id = "019ec100-3abf-7ab3-8ee8-cb1bce4fa851";
    const dir = join(home, ".codex", "sessions", "2026", "06", "14");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-06-14T20-56-00-${id}.jsonl`), "\n", "utf8");

    expect(agentSessionExists({ agent: "codex", agentSessionId: id }, home)).toBe(true);
    expect(agentSessionExists({ agent: "codex", agentSessionId: "missing" }, home)).toBe(false);
  });

  it("Claude:匹配 projects 下的 session jsonl 文件", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-session-"));
    const dir = join(home, ".claude", "projects", "-tmp-proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude-session.jsonl"), "\n", "utf8");

    expect(agentSessionExists({ agent: "claude", agentSessionId: "claude-session" }, home)).toBe(true);
    expect(agentSessionExists({ agent: "claude", agentSessionId: "missing" }, home)).toBe(false);
  });

  it("Pi:没有外部会话文件,恒视为存在", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-session-"));
    expect(agentSessionExists({ agent: "pi", agentSessionId: "pi-session" }, home)).toBe(true);
  });
});
