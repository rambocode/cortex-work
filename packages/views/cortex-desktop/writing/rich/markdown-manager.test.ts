// 富文本 Markdown 往返 + 保真审计单测(数据安全红线):常见语法往返幂等且不丢文本;超大文档拒绝回落。
import { describe, it, expect } from "vitest";
import {
  auditWriteMarkdownFidelity,
  parseWriteMarkdown,
  serializeWriteMarkdown,
  WRITE_RICH_MAX_CHARS,
} from "./markdown-manager";

// 两趟序列化应幂等(往返稳定)。
function roundtripStable(md: string): boolean {
  const once = serializeWriteMarkdown(parseWriteMarkdown(md));
  const twice = serializeWriteMarkdown(parseWriteMarkdown(once));
  return once === twice;
}

describe("rich markdown round-trip + 保真审计", () => {
  it("常见语法(标题/强调/列表/引用/代码块)往返稳定且审计通过", () => {
    const md =
      "# 标题\n\n正文 **粗** *斜* `代码`\n\n- a\n- b\n\n1. x\n2. y\n\n> 引用\n\n```js\nconst a = 1\n```\n";
    expect(roundtripStable(md)).toBe(true);
    expect(auditWriteMarkdownFidelity(md).eligible).toBe(true);
  });

  it("图片语法 ![]() 往返保真(保证不丢图)", () => {
    const md = "![alt](./img.png)\n";
    expect(roundtripStable(md)).toBe(true);
    expect(auditWriteMarkdownFidelity(md).eligible).toBe(true);
  });

  it("任务列表 + 表格(GFM)往返保真", () => {
    const md = "- [ ] 待办\n- [x] 完成\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    expect(roundtripStable(md)).toBe(true);
    expect(auditWriteMarkdownFidelity(md).eligible).toBe(true);
  });

  it("超大文档 → 拒绝(too-large),不进富文本", () => {
    const big = "a".repeat(WRITE_RICH_MAX_CHARS + 1);
    const fidelity = auditWriteMarkdownFidelity(big);
    expect(fidelity.eligible).toBe(false);
    if (!fidelity.eligible) expect(fidelity.reason).toBe("too-large");
  });

  it("审计通过时返回归一化后的无损文本", () => {
    const md = "# H\n\n正文\n";
    const fidelity = auditWriteMarkdownFidelity(md);
    expect(fidelity.eligible).toBe(true);
    if (fidelity.eligible) {
      // normalized 应能再次无损往返。
      expect(roundtripStable(fidelity.normalized)).toBe(true);
    }
  });
});
