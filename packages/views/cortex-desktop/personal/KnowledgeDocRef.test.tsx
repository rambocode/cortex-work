import { describe, expect, it } from "vitest";
import { knowledgeRefName, parseKnowledgeRef } from "./KnowledgeDocRef";

describe("parseKnowledgeRef", () => {
  it("解析基本形态", () => {
    expect(parseKnowledgeRef("kb://src-1/finance-policy.txt")).toEqual({
      sourceId: "src-1",
      relPath: "finance-policy.txt",
    });
  });

  // relPath 可以含斜杠，只能切第一个——按最后一个切会把目录并进 sourceId。
  it("relPath 含多级目录", () => {
    expect(parseKnowledgeRef("kb://src-1/a/b/c.md")).toEqual({
      sourceId: "src-1",
      relPath: "a/b/c.md",
    });
  });

  // remark 的 normalizeUri 会把 href percent-encode，中文路径尤甚。
  // 不解码就拿去请求服务端会因路径对不上而失败——与本地文件 ref 同一个坑。
  it("解码 percent-encoded 的中文路径", () => {
    const encoded = `kb://src-1/${encodeURI("制度/差旅报销.md")}`;
    expect(parseKnowledgeRef(encoded)).toEqual({
      sourceId: "src-1",
      relPath: "制度/差旅报销.md",
    });
  });

  it("大小写不敏感的 scheme", () => {
    expect(parseKnowledgeRef("KB://src/a.md")?.sourceId).toBe("src");
  });

  it("容忍 scheme 后多余的斜杠", () => {
    expect(parseKnowledgeRef("kb:///src/a.md")).toEqual({ sourceId: "src", relPath: "a.md" });
  });

  it("非 kb scheme / 残缺形态一律返回 null", () => {
    for (const bad of [
      undefined,
      "",
      "https://example.com/a.md",
      "./local/file.md",
      "kb://",
      "kb://onlysource", // 没有 relPath
      "kb://src/", // relPath 为空
      "kb:///", //
    ]) {
      expect(parseKnowledgeRef(bad)).toBeNull();
    }
  });
});

describe("knowledgeRefName", () => {
  it("取路径最后一段作展示名", () => {
    expect(knowledgeRefName({ sourceId: "s", relPath: "a/b/差旅报销.md" })).toBe("差旅报销.md");
    expect(knowledgeRefName({ sourceId: "s", relPath: "top.md" })).toBe("top.md");
  });
});
