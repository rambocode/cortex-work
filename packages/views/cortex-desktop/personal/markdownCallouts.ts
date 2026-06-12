// remark 插件:把 GitHub/Obsidian 风格 callout（> [!important] …）标记成
// 带类型 class 的 blockquote,CSS 按类型上色。只动 mdast,不引入额外依赖。

const CALLOUT_RE = /^\[!(\w+)\]\s*/;

// 已知类型 → 配色 class;未知类型回落 note 配色（data-callout 仍显示原词）。
const KNOWN_KINDS = new Set(["note", "tip", "important", "warning", "caution"]);

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
};

function tagCallout(quote: MdNode) {
  const para = quote.children?.[0];
  if (!para || para.type !== "paragraph") return;
  const first = para.children?.[0];
  if (!first || first.type !== "text" || typeof first.value !== "string") return;
  const m = CALLOUT_RE.exec(first.value);
  if (!m?.[1]) return;

  const type = m[1].toLowerCase();
  const kind = KNOWN_KINDS.has(type) ? type : "note";
  // 剥掉 [!type] 标记;若标记独占一行,顺带去掉行首软换行,避免渲染出空行。
  first.value = first.value.slice(m[0].length).replace(/^\n/, "");
  if (!first.value) para.children!.shift();
  if (para.children!.length === 0) quote.children!.shift();

  const data = (quote.data ??= {});
  data.hProperties = {
    ...(data.hProperties ?? {}),
    className: ["pw-md-callout", `is-${kind}`],
    "data-callout": type,
  };
}

export function remarkCallouts() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (!Array.isArray(node.children)) return;
      for (const child of node.children) {
        if (child.type === "blockquote") tagCallout(child);
        walk(child);
      }
    };
    walk(tree);
  };
}
