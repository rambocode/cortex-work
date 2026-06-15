// 闪记展示用的纯函数 / 常量,供 NotesView(右栏详情)与 FlashNoteEditor(中心写作面)共用,
// 避免两处各拷一份导致截断规则 / 状态文案漂移(code-review:maintainability)。

import type { NoteMeta } from "@cortex-work/core";

// 剥掉行首 markdown 块级标记,使标题展示为纯文本(首行是 `# 标题` 时不带 #)。
function stripLeadingMarkdownMarkers(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "") // ATX 标题:# 标题
    .replace(/^>\s?/, "") // 引用:> 文字
    .replace(/^[-*+]\s+/, "") // 无序列表:- 项
    .replace(/^\d+\.\s+/, "") // 有序列表:1. 项
    .trim();
}

// 闪记标题 = 正文首个非空行(剥离行首 markdown 标记)截断(列表行 / 详情头 / 编辑器头共用)。
export function noteTitle(content: string): string {
  const raw = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const line = stripLeadingMarkdownMarkers(raw) || raw; // 剥完为空(如孤立的 #)则回退原行
  if (!line) return "（空白闪记）";
  return line.length > 80 ? line.slice(0, 80) + "…" : line;
}

export const STATUS_LABEL: Record<NoteMeta["status"], string | null> = {
  draft: null,
  deepening: "深化中",
  deepened: "已深化",
};
