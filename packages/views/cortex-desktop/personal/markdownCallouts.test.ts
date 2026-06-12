import { describe, it, expect } from "vitest";
import { remarkCallouts } from "./markdownCallouts";

type Node = { type: string; value?: string; children?: Node[]; data?: { hProperties?: Record<string, unknown> } };

// 手工构造 mdast,等价于 remark-parse 对 "> [!xxx] …" 的产物。
function quoteOf(firstText: string, extra: Node[] = []): Node {
  return {
    type: "blockquote",
    children: [{ type: "paragraph", children: [{ type: "text", value: firstText }, ...extra] }],
  };
}

function root(...children: Node[]): Node {
  return { type: "root", children };
}

// 取 blockquote 首段第一个 inline 节点（断言用）。
const firstInline = (quote: Node) => quote.children?.[0]?.children?.[0];

const run = remarkCallouts();

describe("remarkCallouts", () => {
  it("识别 [!important]:剥掉标记,注入类型 class 与 data-callout", () => {
    const quote = quoteOf("[!important] 国际版不改服务器\n服务器地址相同");
    run(root(quote));
    expect(quote.data?.hProperties).toEqual({
      className: ["pw-md-callout", "is-important"],
      "data-callout": "important",
    });
    expect(firstInline(quote)?.value).toBe("国际版不改服务器\n服务器地址相同");
  });

  it("标记独占一行时,去掉行首软换行避免空行", () => {
    const quote = quoteOf("[!warning]\n注意事项");
    run(root(quote));
    expect(firstInline(quote)?.value).toBe("注意事项");
  });

  it("标记后无任何文本:移除空 text 节点,保留后续 inline", () => {
    const quote = quoteOf("[!tip] ", [{ type: "inlineCode", value: "x" }]);
    run(root(quote));
    expect(firstInline(quote)).toEqual({ type: "inlineCode", value: "x" });
  });

  it("未知类型回落 note 配色,data-callout 保留原词", () => {
    const quote = quoteOf("[!danger] 自定义类型");
    run(root(quote));
    expect(quote.data?.hProperties?.className).toEqual(["pw-md-callout", "is-note"]);
    expect(quote.data?.hProperties?.["data-callout"]).toBe("danger");
  });

  it("类型大小写不敏感", () => {
    const quote = quoteOf("[!IMPORTANT] 标题");
    run(root(quote));
    expect(quote.data?.hProperties?.["data-callout"]).toBe("important");
  });

  it("普通 blockquote 不受影响", () => {
    const quote = quoteOf("普通引用文本");
    run(root(quote));
    expect(quote.data).toBeUndefined();
    expect(firstInline(quote)?.value).toBe("普通引用文本");
  });

  it("嵌套在列表里的 blockquote 也能识别", () => {
    const quote = quoteOf("[!caution] 危险操作");
    const tree = root({ type: "list", children: [{ type: "listItem", children: [quote] }] });
    run(tree);
    expect(quote.data?.hProperties?.className).toEqual(["pw-md-callout", "is-caution"]);
  });
});
