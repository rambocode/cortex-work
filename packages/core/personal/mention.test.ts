import { describe, it, expect } from "vitest";
import { parseMentions, BUILTIN_ROLES } from "./mention";
import type { RoleConfig } from "../desktop/types";

const designer: RoleConfig = {
  id: "designer",
  label: "设计师",
  agent: "claude",
  systemPrompt: "你是设计师",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  color: "#ff0000",
  avatar: "🎨",
};

const reviewer: RoleConfig = {
  id: "reviewer",
  label: "审查员",
  agent: "codex",
  systemPrompt: "你是代码审查员",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const customRoles = [designer, reviewer];

describe("parseMentions", () => {
  it("解析内置 @codex", () => {
    const result = parseMentions("@codex 写一个 hello world", []);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe(BUILTIN_ROLES.codex);
  });

  it("解析多个内置 @claude @codex 保序", () => {
    const result = parseMentions("@claude 设计 @codex 实现", []);
    expect(result).toHaveLength(2);
    expect(result[0].role.id).toBe("claude");
    expect(result[1].role.id).toBe("codex");
  });

  it("解析中文自定义角色 @设计师", () => {
    const result = parseMentions("@设计师 请设计一个界面", customRoles);
    expect(result).toHaveLength(1);
    expect(result[0].role.id).toBe("designer");
    expect(result[0].mention).toBe("设计师");
  });

  it("code fence 内的 @codex 被跳过", () => {
    const text = "看看这个:\n```\n@codex 这是代码\n```\n@claude 帮忙";
    const result = parseMentions(text, []);
    expect(result).toHaveLength(1);
    expect(result[0].role.id).toBe("claude");
  });

  it("inline code 内的 @codex 被跳过", () => {
    const text = "使用 `@codex` 命令 @claude 帮忙";
    const result = parseMentions(text, []);
    expect(result).toHaveLength(1);
    expect(result[0].role.id).toBe("claude");
  });

  it("重复 @codex @codex 去重", () => {
    const result = parseMentions("@codex 先做 @codex 再做", []);
    expect(result).toHaveLength(1);
    expect(result[0].role.id).toBe("codex");
  });

  it("未知 @foobar 跳过", () => {
    const result = parseMentions("@foobar 未知角色", []);
    expect(result).toHaveLength(0);
  });

  it("混合：@设计师 请设计 @codex 请实现", () => {
    const result = parseMentions("@设计师 请设计 @codex 请实现", customRoles);
    expect(result).toHaveLength(2);
    expect(result[0].role.id).toBe("designer");
    expect(result[1].role.id).toBe("codex");
  });

  it("自定义角色 id 精确匹配优先于 label", () => {
    const result = parseMentions("@designer 做界面", customRoles);
    expect(result).toHaveLength(1);
    expect(result[0].role.id).toBe("designer");
  });

  it("无 mention 返回空数组", () => {
    const result = parseMentions("普通消息没有 mention", customRoles);
    expect(result).toHaveLength(0);
  });

  it("邮箱地址中的 @ 不会被误解析", () => {
    // 邮箱格式 user@domain.com 中 domain.com 包含点号，不匹配 [\w\p{L}\p{N}_-]+
    // 但 user@domain 可能匹配——如果 domain 不是已知角色则被跳过
    const result = parseMentions("联系 user@unknown 和 test@example.com", []);
    expect(result).toHaveLength(0);
  });

  it("多行文本中跨行 mention 正确解析", () => {
    const text = "@claude 第一行\n普通文字\n@codex 第三行";
    const result = parseMentions(text, []);
    expect(result).toHaveLength(2);
    expect(result[0].role.id).toBe("claude");
    expect(result[1].role.id).toBe("codex");
  });

  it("@mention 大小写不敏感", () => {
    const result = parseMentions("@Claude 帮忙", []);
    expect(result).toHaveLength(1);
    expect(result[0].role.id).toBe("claude");
  });

  it("内置优先于同名自定义角色", () => {
    const customClaude: RoleConfig = {
      id: "claude",
      label: "Claude Custom",
      agent: "claude",
      systemPrompt: "自定义",
      createdAt: "",
      updatedAt: "",
    };
    const result = parseMentions("@claude 帮忙", [customClaude]);
    // 内置 shortcut 优先
    expect(result).toHaveLength(1);
    expect(result[0].role.systemPrompt).toBe("");
  });
});
