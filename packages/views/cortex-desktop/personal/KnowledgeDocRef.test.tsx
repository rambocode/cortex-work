import { describe, expect, it } from "vitest";
import { knowledgeRefName, normalizeKnowledgeLinks, parseKnowledgeRef } from "./KnowledgeDocRef";

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

describe("normalizeKnowledgeLinks", () => {
  // 线上实拍的形态：知识库文件名普遍带空格（`DX0B511 采集与上报链路.md`），
  // CommonMark 的链接目标不允许裸空格 → 整条链接根本不解析，用户看到的是原始 markdown 文本。
  it("链接目标里的空格编码为 %20", () => {
    const out = normalizeKnowledgeLinks(
      "[DX0B511 采集与上报链路.md](kb://synced_dir-硬件-20260612031026/DX0B511/开发/DX0B511 采集与上报链路.md)",
    );
    expect(out).toBe(
      "[DX0B511 采集与上报链路.md](kb://synced_dir-硬件-20260612031026/DX0B511/开发/DX0B511%20采集与上报链路.md)",
    );
  });

  it("多条链接与已编码的目标都能正确处理", () => {
    const out = normalizeKnowledgeLinks("见[a](kb://s/x y.md)与[b](kb://s/已%20编码.md)");
    expect(out).toBe("见[a](kb://s/x%20y.md)与[b](kb://s/已%20编码.md)");
  });

  it("代码块 / inline code 里的示例原样保留", () => {
    const fenced = "```\n[a](kb://s/x y.md)\n```";
    expect(normalizeKnowledgeLinks(fenced)).toBe(fenced);
    expect(normalizeKnowledgeLinks("格式：`[a](kb://s/x y.md)`")).toBe("格式：`[a](kb://s/x y.md)`");
  });

  it("不含 kb:// 的文本原样返回", () => {
    const text = "[doc](docs/a b.md) 和普通文字";
    expect(normalizeKnowledgeLinks(text)).toBe(text);
  });
});

describe("knowledgeRefName", () => {
  it("取路径最后一段作展示名", () => {
    expect(knowledgeRefName({ sourceId: "s", relPath: "a/b/差旅报销.md" })).toBe("差旅报销.md");
    expect(knowledgeRefName({ sourceId: "s", relPath: "top.md" })).toBe("top.md");
  });
});
