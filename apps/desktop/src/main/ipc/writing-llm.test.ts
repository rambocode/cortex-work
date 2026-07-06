// 写作 LLM 协议纯函数单测(U3,test-first):续写/改写的 prompt 构造(前后缀截断)与响应解析(去回声)。
import { describe, it, expect } from "vitest";
import {
  WRITING_COMPLETION_PREFIX_WINDOW,
  WRITING_COMPLETION_SUFFIX_WINDOW,
  buildWritingCompletionMessages,
  parseWritingCompletionResponse,
  buildWritingInlineEditMessages,
  parseWritingInlineEditReplacement,
} from "./writing-llm";
import { isWritingLlmConfigured } from "./writing-llm-types";

describe("isWritingLlmConfigured(未配置降级判据)", () => {
  it("baseUrl 与 model 均非空 → true", () => {
    expect(
      isWritingLlmConfigured({ baseUrl: "https://x/v1", apiKey: "", model: "m", completionEnabled: true }),
    ).toBe(true);
  });
  it("缺 baseUrl 或 model → false(渲染端隐藏续写/改写入口)", () => {
    expect(isWritingLlmConfigured({ baseUrl: "", apiKey: "k", model: "m", completionEnabled: true })).toBe(false);
    expect(isWritingLlmConfigured({ baseUrl: "https://x", apiKey: "k", model: "  ", completionEnabled: true })).toBe(
      false,
    );
    expect(isWritingLlmConfigured(undefined)).toBe(false);
  });
});

describe("buildWritingCompletionMessages", () => {
  it("前后缀超窗时按尾/头截断(prefix 取尾、suffix 取头)", () => {
    const prefix = "P".repeat(WRITING_COMPLETION_PREFIX_WINDOW + 500) + "TAIL";
    const suffix = "HEAD" + "S".repeat(WRITING_COMPLETION_SUFFIX_WINDOW + 500);
    const msgs = buildWritingCompletionMessages({ prefix, suffix });
    const user = msgs.find((m) => m.role === "user")!.content;
    // prefix 保尾:窗口内应含最后的 TAIL,且总长不超窗口。
    expect(user).toContain("TAIL");
    expect(user).not.toContain("P".repeat(WRITING_COMPLETION_PREFIX_WINDOW + 400));
    // suffix 保头:窗口内应含开头的 HEAD。
    expect(user).toContain("HEAD");
  });

  it("含 PREFIX/SUFFIX 边界标记与系统角色", () => {
    const msgs = buildWritingCompletionMessages({ prefix: "hello", suffix: "world" });
    expect(msgs[0]?.role).toBe("system");
    const user = msgs.find((m) => m.role === "user")!.content;
    expect(user).toContain("<<<PREFIX");
    expect(user).toContain("<<<SUFFIX");
    expect(user).toContain("hello");
    expect(user).toContain("world");
  });
});

describe("parseWritingCompletionResponse", () => {
  it("合法:直接返回可插入文本", () => {
    expect(parseWritingCompletionResponse(" and then it worked")).toBe(" and then it worked");
  });
  it("去代码围栏与包裹引号", () => {
    expect(parseWritingCompletionResponse("```\nfoo bar\n```")).toBe("foo bar");
    expect(parseWritingCompletionResponse('"quoted text"')).toBe("quoted text");
  });
  it("包尾语/协议回声 → 空", () => {
    expect(parseWritingCompletionResponse("<<<PREFIX\nhello\n>>>")).toBe("");
    expect(parseWritingCompletionResponse("Return only the text to insert at the cursor.")).toBe("");
  });
  it("空/纯空白 → 空", () => {
    expect(parseWritingCompletionResponse("")).toBe("");
    expect(parseWritingCompletionResponse("   \n  ")).toBe("");
  });
});

describe("buildWritingInlineEditMessages", () => {
  it("含 <<<EDIT>>> 协议、指令、原文与前后缀", () => {
    const msgs = buildWritingInlineEditMessages({
      prefix: "before ",
      suffix: " after",
      original: "old words",
      instruction: "改得更正式",
    });
    const user = msgs.find((m) => m.role === "user")!.content;
    expect(user).toContain("<<<EDIT");
    expect(user).toContain("改得更正式");
    expect(user).toContain("old words");
    expect(user).toContain("before ");
    expect(user).toContain(" after");
  });
});

describe("parseWritingInlineEditReplacement", () => {
  it("合法 <<<EDIT>>> 块 → 替换文本", () => {
    expect(parseWritingInlineEditReplacement("<<<EDIT\nnew formal text\n>>>")).toBe("new formal text");
  });
  it("包尾语(EDIT 块后跟其它 marker)→ 只取 EDIT 体", () => {
    expect(
      parseWritingInlineEditReplacement("<<<EDIT\nnew text\n>>>\n<<<SHORT\nignored\n>>>"),
    ).toBe("new text");
  });
  it("只回声输入边界、无 EDIT → 空", () => {
    expect(parseWritingInlineEditReplacement("<<<PREFIX\nblah\n>>>")).toBe("");
  });
  it("空 → 空", () => {
    expect(parseWritingInlineEditReplacement("")).toBe("");
  });
  it("无 marker 的纯文本 → 当作替换文本(去围栏/引号)", () => {
    expect(parseWritingInlineEditReplacement("plain replacement")).toBe("plain replacement");
  });
});
