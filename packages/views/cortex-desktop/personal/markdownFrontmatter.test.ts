import { describe, expect, it } from "vitest";
import { splitFrontmatter } from "./markdownFrontmatter";

describe("splitFrontmatter", () => {
  it("解析平铺 key: value 并剥离引号,保持顺序", () => {
    const src = [
      "---",
      'title: "fix: 流式消息按到达顺序交替分块"',
      "type: fix",
      "status: completed",
      "date: 2026-06-14",
      "plan_id: 2026-06-14-002",
      "---",
      "",
      "# 正文标题",
      "正文内容",
    ].join("\n");
    const { meta, body } = splitFrontmatter(src);
    expect(meta).toEqual([
      { key: "title", value: "fix: 流式消息按到达顺序交替分块" },
      { key: "type", value: "fix" },
      { key: "status", value: "completed" },
      { key: "date", value: "2026-06-14" },
      { key: "plan_id", value: "2026-06-14-002" },
    ]);
    expect(body).toBe("# 正文标题\n正文内容");
  });

  it("没有 frontmatter 时原样返回正文", () => {
    const src = "# 普通标题\n一段正文";
    expect(splitFrontmatter(src)).toEqual({ meta: null, body: src });
  });

  it("正文里的 --- (分隔线) 不被误判为 frontmatter", () => {
    const src = "前言\n\n---\n\n后文";
    expect(splitFrontmatter(src)).toEqual({ meta: null, body: src });
  });

  it("开头有 --- 但没有闭合行时不当作 frontmatter", () => {
    const src = "---\ntitle: x\n# 没有闭合";
    expect(splitFrontmatter(src)).toEqual({ meta: null, body: src });
  });

  it("支持 ... 作为闭合行,并忽略空行与注释", () => {
    const src = ["---", "# 这是注释", "a: 1", "", "b: 2", "...", "正文"].join("\n");
    const { meta, body } = splitFrontmatter(src);
    expect(meta).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);
    expect(body).toBe("正文");
  });

  it("frontmatter 全为空/无有效键时 meta 为 null", () => {
    const src = "---\n\n# 只有注释\n---\n正文";
    expect(splitFrontmatter(src)).toEqual({ meta: null, body: "正文" });
  });

  it("value 含冒号时只按第一个冒号切分", () => {
    const { meta } = splitFrontmatter("---\nurl: https://a.com/x\n---\n");
    expect(meta).toEqual([{ key: "url", value: "https://a.com/x" }]);
  });
});
