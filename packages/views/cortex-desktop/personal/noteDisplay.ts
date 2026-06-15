// 闪记展示用的纯函数 / 常量,供 NotesView(右栏详情)与 FlashNoteEditor(中心写作面)共用,
// 避免两处各拷一份导致截断规则 / 状态文案漂移(code-review:maintainability)。

import type { NoteMeta } from "@cortex-work/core";

// 闪记标题 = 正文首个非空行截断(列表行 / 详情头 / 编辑器头共用)。
export function noteTitle(content: string): string {
  const line = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!line) return "（空白闪记）";
  return line.length > 80 ? line.slice(0, 80) + "…" : line;
}

export const STATUS_LABEL: Record<NoteMeta["status"], string | null> = {
  draft: null,
  deepening: "深化中",
  deepened: "已深化",
};
