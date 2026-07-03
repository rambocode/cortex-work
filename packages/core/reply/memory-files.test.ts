// 记忆 markdown 文件格式的行为契约测试：⟨auto⟩ 标记 parse/render 往返、
// 引导模板注释、注释剥离（prompt 组装用）。格式协议见 memory-files.ts 文件头。

import { describe, expect, it } from "vitest";
import { MEMORY_SCOPES } from "./memory";
import {
  AUTO_MARKER,
  memoryFileTemplate,
  parseMemoryMarkdown,
  renderMemoryMarkdown,
  stripMemoryComments,
} from "./memory-files";

describe("parseMemoryMarkdown", () => {
  it("标记行上方为 manual、下方为 auto（首尾空白裁剪）", () => {
    const text = `<!-- 模板注释 -->\n手写内容\n\n${AUTO_MARKER}\n- 学到的要点\n`;
    expect(parseMemoryMarkdown(text)).toEqual({
      manual: "<!-- 模板注释 -->\n手写内容",
      auto: "- 学到的要点",
    });
  });

  it("无标记行 → 全文为 manual，auto 为空", () => {
    expect(parseMemoryMarkdown("只有手写")).toEqual({ manual: "只有手写", auto: "" });
  });

  it("标记行按前缀识别（源项目文件的完整标题行也能命中）", () => {
    const text = `手写\n## ⟨auto⟩ 从你最近发出的消息学到的（手写内容在上方，优先级更高）\n- 要点`;
    expect(parseMemoryMarkdown(text).auto).toBe("- 要点");
  });

  it("空串/纯空白 → 双空", () => {
    expect(parseMemoryMarkdown("")).toEqual({ manual: "", auto: "" });
    expect(parseMemoryMarkdown("  \n ")).toEqual({ manual: "", auto: "" });
  });
});

describe("renderMemoryMarkdown", () => {
  it("manual 与 auto 以标记行连接，parse 往返一致", () => {
    const rendered = renderMemoryMarkdown({ manual: "<!-- 注 -->\n手写", auto: "- 要点" });
    expect(parseMemoryMarkdown(rendered)).toEqual({ manual: "<!-- 注 -->\n手写", auto: "- 要点" });
  });

  it("auto 为空时仍写标记行（用户在 Finder 里能看到分区结构）", () => {
    const rendered = renderMemoryMarkdown({ manual: "手写", auto: "" });
    expect(rendered).toContain(AUTO_MARKER);
    expect(parseMemoryMarkdown(rendered)).toEqual({ manual: "手写", auto: "" });
  });

  it("双空往返安全", () => {
    expect(parseMemoryMarkdown(renderMemoryMarkdown({ manual: "", auto: "" }))).toEqual({
      manual: "",
      auto: "",
    });
  });
});

describe("memoryFileTemplate", () => {
  it("每个分区都有含 HTML 注释的引导模板，parse 后 auto 为空", () => {
    for (const scope of MEMORY_SCOPES) {
      const template = memoryFileTemplate(scope);
      expect(template).toContain("<!--");
      const parsed = parseMemoryMarkdown(template);
      expect(parsed.auto).toBe("");
      // 模板正文只有注释：剥离注释后 manual 应为空（不污染 prompt）
      expect(stripMemoryComments(parsed.manual)).toBe("");
    }
  });
});

describe("stripMemoryComments", () => {
  it("剥离 HTML 注释（含多行）并收敛空行", () => {
    expect(stripMemoryComments("<!-- 说明\n多行 -->\n真实内容")).toBe("真实内容");
    expect(stripMemoryComments("前<!-- x -->后")).toBe("前后");
  });

  it("无注释原样返回（仅裁剪首尾空白）", () => {
    expect(stripMemoryComments(" 内容 ")).toBe("内容");
  });
});
