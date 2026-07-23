// 会话记忆截断单测:行定位(claude/codex 真实行形状)+ 文件截断与备份。
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { agentSessionExists, claudeTrimIndex, codexTrimIndex, trimSessionFile, trimSessionIntoCopy } from "./session-trim";

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

  // 带附件的轮:prompt 文本为「附件块 + \n\n + 原文」(buildTurnPromptText),按「\n\n+原文」后缀定位
  //(与 pi 的 piEntryMatchesText 同一模式);无 \n\n 分隔的尾串不得误命中。
  it("带附件前缀(附件块\\n\\n原文)按后缀匹配定位;无分隔尾串不误命中", () => {
    const lines = [
      claudeUser('<skill name="a">规则</skill>\n\n带附件的问题'),
      claudeUser("xyz带附件的问题"),
    ];
    expect(claudeTrimIndex(lines, "带附件的问题", 0)).toBe(0);
    expect(claudeTrimIndex(lines, "带附件的问题", 1)).toBe(-1);
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

  // 附件块并入 prompt 文本后,codex 历史形态为 <user_request>\n附件块\n\n原文\n</user_request>,
  // 需按「\n\n+原文+\n</user_request>」后缀定位。
  it("附件块在 user_request 内(前缀形态)也能定位", () => {
    const lines = [
      codexUser('append\n\n<user_request>\n<skill name="a">规则</skill>\n\n带附件的问题\n</user_request>'),
    ];
    expect(codexTrimIndex(lines, "带附件的问题", 0)).toBe(0);
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

describe("trimSessionIntoCopy(分支重新生成:复制+改 id+截断,源文件不动)", () => {
  it("claude:副本截断到目标轮之前、每行 sessionId 改写为新 id,源文件原样保留", async () => {
    const home = mkdtempSync(join(tmpdir(), "trim-copy-"));
    const dir = join(home, ".claude", "projects", "-tmp-proj");
    mkdirSync(dir, { recursive: true });
    const srcPath = join(dir, "old-id.jsonl");
    // 每行带 sessionId(真实 claude 事件流形状),截断点在第二个「继续」。
    const lines = claudeLines.map((l) => JSON.stringify({ ...JSON.parse(l), sessionId: "old-id" }));
    const raw = lines.join("\n") + "\n";
    writeFileSync(srcPath, raw, "utf8");

    const r = await trimSessionIntoCopy(
      { agent: "claude", agentSessionId: "old-id", promptText: "继续", occurrence: 1 },
      "new-id",
      home,
    );
    expect(r).toEqual({ newSessionId: "new-id" });
    // 源文件未动。
    expect(readFileSync(srcPath, "utf8")).toBe(raw);
    // 副本:截断到第 6 行前(含第一「继续」轮及其答复),且行内 sessionId 已改写。
    const copy = readFileSync(join(dir, "new-id.jsonl"), "utf8").trim().split("\n");
    expect(copy).toHaveLength(6);
    expect(copy.join("\n")).toContain("第二答");
    expect(copy.join("\n")).not.toContain("第三答");
    for (const line of copy) expect((JSON.parse(line) as { sessionId?: string }).sessionId).toBe("new-id");
  });

  it("codex:保留 rollout 前缀只换 thread id,session_meta.payload.id 改写", async () => {
    const home = mkdtempSync(join(tmpdir(), "trim-copy-"));
    const dir = join(home, ".codex", "sessions", "2026", "07", "09");
    mkdirSync(dir, { recursive: true });
    const srcPath = join(dir, "rollout-2026-07-09T10-00-00-old-thread.jsonl");
    writeFileSync(srcPath, codexLines.join("\n") + "\n", "utf8");

    const r = await trimSessionIntoCopy(
      { agent: "codex", agentSessionId: "old-thread", promptText: "带附件的问题", occurrence: 0 },
      "new-thread",
      home,
    );
    expect(r).toEqual({ newSessionId: "new-thread" });
    const copyPath = join(dir, "rollout-2026-07-09T10-00-00-new-thread.jsonl");
    const copy = readFileSync(copyPath, "utf8").trim().split("\n");
    expect(copy).toHaveLength(4); // 截掉 <user_request> 轮(第 4 行)
    const meta = JSON.parse(copy[0]!) as { payload: { id: string } };
    expect(meta.payload.id).toBe("new-thread");
    // 源文件仍是旧 id。
    expect(readFileSync(srcPath, "utf8")).toContain('"id":"t1"' /* session_meta 原样 */);
  });

  it("找不到文件 / 匹配不到截断点 / 会清到文件头 → null,不产生副本", async () => {
    const home = mkdtempSync(join(tmpdir(), "trim-copy-"));
    expect(await trimSessionIntoCopy({ agent: "claude", agentSessionId: "missing", promptText: "x", occurrence: 0 }, "n1", home)).toBeNull();

    const dir = join(home, ".claude", "projects", "-p");
    mkdirSync(dir, { recursive: true });
    const srcPath = join(dir, "sid.jsonl");
    writeFileSync(srcPath, claudeLines.map((l) => JSON.stringify({ ...JSON.parse(l), sessionId: "sid" })).join("\n") + "\n", "utf8");
    // 原文不匹配。
    expect(await trimSessionIntoCopy({ agent: "claude", agentSessionId: "sid", promptText: "不存在", occurrence: 0 }, "n2", home)).toBeNull();
    // pi 不支持。
    expect(await trimSessionIntoCopy({ agent: "pi", agentSessionId: "sid", promptText: "第一问", occurrence: 0 }, "n3", home)).toBeNull();
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
