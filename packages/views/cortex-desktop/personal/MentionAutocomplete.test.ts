import { describe, it, expect } from "vitest";
import { extractMentionQuery, filterMentionOptions, applyMention, type MentionOption } from "./MentionAutocomplete";

describe("extractMentionQuery", () => {
  it("提取 @ 后的查询文本", () => {
    const result = extractMentionQuery("hello @cla", 10);
    expect(result).toEqual({ query: "cla", start: 6 });
  });

  it("@ 后无文本返回空 query", () => {
    const result = extractMentionQuery("hello @", 7);
    expect(result).toEqual({ query: "", start: 6 });
  });

  it("光标不在 @ 后返回 null", () => {
    expect(extractMentionQuery("hello world", 11)).toBeNull();
  });

  it("@ 后有空格返回 null", () => {
    expect(extractMentionQuery("hello @claude ", 14)).toBeNull();
  });

  it("多个 @ 取最后一个", () => {
    const result = extractMentionQuery("@claude tell @co", 16);
    expect(result).toEqual({ query: "co", start: 13 });
  });
});

describe("filterMentionOptions", () => {
  const options: MentionOption[] = [
    { id: "claude", label: "Claude", agent: "claude", builtin: true },
    { id: "codex", label: "Codex", agent: "codex", builtin: true },
    { id: "custom-1", label: "设计师", agent: "claude" },
  ];

  it("空 query 返回全部", () => {
    expect(filterMentionOptions(options, "")).toHaveLength(3);
  });

  it("按 label 模糊匹配", () => {
    const result = filterMentionOptions(options, "clau");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("claude");
  });

  it("按 id 匹配", () => {
    const result = filterMentionOptions(options, "custom");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("custom-1");
  });

  it("大小写不敏感", () => {
    const result = filterMentionOptions(options, "CODEX");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("codex");
  });

  it("无匹配返回空", () => {
    expect(filterMentionOptions(options, "zzz")).toHaveLength(0);
  });
});

describe("applyMention", () => {
  it("替换 @query 为 @label + 空格", () => {
    const { newText, newCursor } = applyMention("hello @cla", 6, 10, "Claude");
    expect(newText).toBe("hello @Claude ");
    expect(newCursor).toBe(14);
  });

  it("保留光标后的文本", () => {
    const { newText } = applyMention("hey @co world", 4, 7, "Codex");
    expect(newText).toBe("hey @Codex  world");
  });

  it("文本开头的 @ 也能处理", () => {
    const { newText, newCursor } = applyMention("@pi", 0, 3, "Pi");
    expect(newText).toBe("@Pi ");
    expect(newCursor).toBe(4);
  });
});
