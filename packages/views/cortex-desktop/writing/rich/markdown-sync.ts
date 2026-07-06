// 富文本外部快照同步(移植自 Kun write/tiptap/markdown-sync.ts,去掉 term-propagation 依赖)。
// 文件打开 / agent 改盘等「外部来源」的 Markdown 快照,以「最小块级替换」应用进编辑器,而非整篇替换:
// 与当前文档相同的顶层块原样保留,从而光标/选区/未变区域在 agent 改动下存活;事务打上 external-sync
// 标记,使 onUpdate 不把它当成用户改动重新 emit(否则会误标 dirty 并把 agent 刚写的内容按归一化重写回盘)。
//
// ⚠️ 顶层 import 了 @tiptap/*,只允许被动态 import 触达(见 markdown-manager.ts 同款约束)。
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { parseWriteMarkdown } from "./markdown-manager";

// 外部同步事务标记:onUpdate 命中它则只更新选区、不 emit onChange(避免自回声重写)。
export const WRITING_RICH_EXTERNAL_SYNC_META = "writingRichExternalSync";

export type BlockSyncReplacement = {
  from: number;
  to: number;
  nodes: PMNode[];
};

// 计算把 currentDoc 变成 nextDoc 所需的「最小顶层块替换区间」;两者已相等则回 null。
// 做法:从两端向内比对相同的顶层子块(前缀 + 后缀),中间不同的一段即待替换区间。
export function computeBlockSyncReplacement(
  currentDoc: PMNode,
  nextDoc: PMNode,
): BlockSyncReplacement | null {
  if (currentDoc.eq(nextDoc)) return null;

  let prefix = 0;
  const maxPrefix = Math.min(currentDoc.childCount, nextDoc.childCount);
  while (prefix < maxPrefix && currentDoc.child(prefix).eq(nextDoc.child(prefix))) {
    prefix += 1;
  }

  let currentEnd = currentDoc.childCount;
  let nextEnd = nextDoc.childCount;
  while (
    currentEnd > prefix &&
    nextEnd > prefix &&
    currentDoc.child(currentEnd - 1).eq(nextDoc.child(nextEnd - 1))
  ) {
    currentEnd -= 1;
    nextEnd -= 1;
  }

  let from = 0;
  for (let index = 0; index < prefix; index += 1) {
    from += currentDoc.child(index).nodeSize;
  }
  let to = currentDoc.content.size;
  for (let index = currentEnd; index < currentDoc.childCount; index += 1) {
    to -= currentDoc.child(index).nodeSize;
  }

  const nodes: PMNode[] = [];
  for (let index = prefix; index < nextEnd; index += 1) {
    nodes.push(nextDoc.child(index));
  }

  return { from, to, nodes };
}

// 把外部 Markdown 快照以最小块级替换应用进编辑器。事务标 external-sync + 不入 undo 历史。
// 快照无法按 schema 解析时返回 false(交由调用方回落)。
export function applyExternalMarkdownToEditor(editor: Editor, markdown: string): boolean {
  let nextDoc: PMNode;
  try {
    nextDoc = editor.schema.nodeFromJSON(parseWriteMarkdown(markdown));
  } catch {
    return false;
  }

  const replacement = computeBlockSyncReplacement(editor.state.doc, nextDoc);
  if (!replacement) return true;

  const tr = editor.state.tr;
  if (replacement.nodes.length > 0) {
    tr.replaceWith(replacement.from, replacement.to, replacement.nodes);
  } else {
    tr.delete(replacement.from, replacement.to);
  }
  tr.setMeta(WRITING_RICH_EXTERNAL_SYNC_META, true);
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
  return true;
}
