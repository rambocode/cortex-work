import { describe, expect, it } from "vitest";
import { parseDocMeta } from "./docMeta";

describe("parseDocMeta", () => {
  it("解析 YAML frontmatter 编码", () => {
    const head = [
      "---",
      'title: "feat: 个人工作区落地页定宽内容列"',
      "type: feat",
      "status: completed",
      "date: 2026-06-14",
      "---",
      "",
      "# feat: 个人工作区落地页定宽内容列",
    ].join("\n");
    const m = parseDocMeta(head, "docs/plans/2026-06-14-001-feat-personal-landing-plan.md", "plan");
    expect(m.title).toBe("feat: 个人工作区落地页定宽内容列");
    expect(m.type).toBe("feat");
    expect(m.statusRaw).toBe("completed");
    expect(m.date).toBe("2026-06-14");
    expect(m.kind).toBe("plan");
  });

  it("解析 inline 编码（中文冒号）", () => {
    const head = [
      "# feat: pi RPC 会话——阶段 4（健壮性）",
      "- 类型：feat",
      "- origin：docs/plans/2026-06-16-003-feat-pi-rpc-session-plan.md §6/§7",
      "- 状态：待执行（U0 spike 已完成，见 §2）",
      "- 深度：Deep（跨 4 层）",
      "",
      "正文开始",
    ].join("\n");
    const m = parseDocMeta(head, "docs/plans/2026-06-17-002-feat-pi-rpc-robustness-plan.md", "plan");
    expect(m.type).toBe("feat");
    expect(m.statusRaw).toBe("待执行（U0 spike 已完成，见 §2）");
    expect(m.depth).toBe("Deep（跨 4 层）");
    expect(m.title).toBe("feat: pi RPC 会话——阶段 4（健壮性）");
    expect(m.origin).toEqual(["docs/plans/2026-06-16-003-feat-pi-rpc-session-plan.md §6/§7"]);
  });

  it("inline 编码兼容英文冒号", () => {
    const head = ["# 标题", "- type: fix", "- status: ready", ""].join("\n");
    const m = parseDocMeta(head, "docs/plans/2026-06-16-001-fix-something-plan.md", "plan");
    expect(m.type).toBe("fix");
    expect(m.statusRaw).toBe("ready");
  });

  it("无 frontmatter 无 inline：纯文件名兜底", () => {
    const head = "# 某计划\n\n直接正文，没有任何元数据";
    const m = parseDocMeta(head, "docs/plans/2026-06-14-003-feat-chat-file-link-preview-plan.md", "plan");
    expect(m.date).toBe("2026-06-14");
    expect(m.seq).toBe(3);
    expect(m.type).toBe("feat");
    expect(m.kind).toBe("plan");
  });

  it("title 三级兜底：无 title 字段取 # 行，无 # 行取 slug", () => {
    const withHeading = parseDocMeta("# 我是标题\n", "docs/ideation/x-deepen.md", "ideation");
    expect(withHeading.title).toBe("我是标题");

    const slugOnly = parseDocMeta("没有标题行的正文", "docs/plans/2026-06-14-001-feat-user-auth-flow-plan.md", "plan");
    expect(slugOnly.title).toBe("user auth flow");
  });

  it("损坏输入不抛、返回带 kind 的最小 DocMeta、不吞正文语义", () => {
    expect(() => parseDocMeta("---\n只有半个 frontmatter", "docs/plans/x.md", "plan")).not.toThrow();
    const empty = parseDocMeta("", "docs/brainstorms/foo.md", "brainstorm");
    expect(empty.kind).toBe("brainstorm");
    expect(empty.origin).toEqual([]);
    const half = parseDocMeta("---\n只有半个 frontmatter", "docs/plans/x.md", "plan");
    expect(half.kind).toBe("plan");
  });

  it("origin 多形态原样收集（YAML origin: null 也保留为字符串）", () => {
    const head = ["---", "type: feat", "origin: null", "---"].join("\n");
    const m = parseDocMeta(head, "docs/plans/2026-06-14-004-feat-x-plan.md", "plan");
    expect(m.origin).toEqual(["null"]);
  });

  it("ideation frontmatter（topic/focus/mode）", () => {
    const head = [
      "---",
      "date: 2026-06-17",
      "topic: tasks-panel-doc-status-tags",
      "mode: repo-grounded",
      "---",
    ].join("\n");
    const m = parseDocMeta(head, "docs/ideation/2026-06-17-tasks-panel-doc-status-tags.md", "ideation");
    expect(m.topic).toBe("tasks-panel-doc-status-tags");
    expect(m.date).toBe("2026-06-17");
    expect(m.kind).toBe("ideation");
  });
});
