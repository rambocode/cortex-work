// Cmd-K 就地改写请求构造/替换应用/审阅入参 纯函数单测(U3,test-first)。
import { describe, it, expect } from "vitest";
import {
  WRITING_INLINE_EDIT_PREFIX_WINDOW,
  WRITING_INLINE_EDIT_SUFFIX_WINDOW,
  canRunWritingInlineEdit,
  buildWritingInlineEditRequest,
  applyWritingInlineEditReplacement,
  buildWritingInlineEditReviewInput,
} from "./inline-edit";

describe("canRunWritingInlineEdit", () => {
  it("已配置且有非空选区 → true", () => {
    expect(canRunWritingInlineEdit(true, "选中的字")).toBe(true);
  });
  it("未配置 → false(即使有选区)", () => {
    expect(canRunWritingInlineEdit(false, "选中的字")).toBe(false);
  });
  it("无选区/空选区 → false", () => {
    expect(canRunWritingInlineEdit(true, "")).toBe(false);
    expect(canRunWritingInlineEdit(true, "   ")).toBe(false);
    expect(canRunWritingInlineEdit(true, undefined)).toBe(false);
  });
});

describe("buildWritingInlineEditRequest", () => {
  it("前缀取尾、后缀取头、original=选区,携带指令", () => {
    const before = "B".repeat(WRITING_INLINE_EDIT_PREFIX_WINDOW + 300) + "PRE";
    const sel = "SELECTED";
    const after = "SUF" + "A".repeat(WRITING_INLINE_EDIT_SUFFIX_WINDOW + 300);
    const content = before + sel + after;
    const from = before.length;
    const to = before.length + sel.length;
    const req = buildWritingInlineEditRequest(content, from, to, "更正式");
    expect(req.original).toBe("SELECTED");
    expect(req.instruction).toBe("更正式");
    // prefix 保尾:窗口内含 before 尾部的 PRE,且长度 ≤ 窗口。
    expect(req.prefix.endsWith("PRE")).toBe(true);
    expect(req.prefix.length).toBeLessThanOrEqual(WRITING_INLINE_EDIT_PREFIX_WINDOW);
    // suffix 保头:窗口内含 after 头部的 SUF,且长度 ≤ 窗口。
    expect(req.suffix.startsWith("SUF")).toBe(true);
    expect(req.suffix.length).toBeLessThanOrEqual(WRITING_INLINE_EDIT_SUFFIX_WINDOW);
  });

  it("from>to 时归一化(取 min/max)", () => {
    const content = "abcdefgh";
    const req = buildWritingInlineEditRequest(content, 6, 2, "x");
    expect(req.original).toBe("cdef");
    expect(req.prefix).toBe("ab");
    expect(req.suffix).toBe("gh");
  });
});

describe("applyWritingInlineEditReplacement", () => {
  it("用替换文本覆盖 [from,to) 区间", () => {
    expect(applyWritingInlineEditReplacement("hello world", 6, 11, "there")).toBe("hello there");
  });
});

describe("buildWritingInlineEditReviewInput", () => {
  it("baseline=原全文、next=替换后全文、origin 为允许值 agent", () => {
    const input = buildWritingInlineEditReviewInput("hello world", 6, 11, "there");
    expect(input.baseline).toBe("hello world");
    expect(input.next).toBe("hello there");
    expect(input.origin).toBe("agent");
  });
});
