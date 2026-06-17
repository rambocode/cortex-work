// 从 ParsedDocMeta 派生四维正交标签：阶段(stage)/类型(type)/主题域(topic)/深度(depth)。
// 阶段恒有（来自 kind）；其余维度缺字段则不产标签。纯函数，供右栏标签筛选复用。

import type { DocKind, ParsedDocMeta } from "./docMeta";
import { stripStatusAnnotation } from "./docStatus";

export type TagDim = "stage" | "type" | "topic" | "depth";

export interface Tag {
  dim: TagDim;
  value: string; // 用于筛选匹配的归一值
  label: string; // 用于展示
}

const STAGE_LABEL: Record<DocKind, string> = {
  ideation: "💡 构思",
  brainstorm: "📋 需求",
  plan: "📐 计划",
};

const FILENAME_SLUG_RE =
  /^\d{4}-\d{2}-\d{2}-\d{3}-(?:feat|fix|chore|docs|style|refactor)-(.+)-(?:plan|deepen|brainstorm)\.md$/;

// 主题域：优先显式 topic；否则从文件名 slug 取首 token 作粗粒度簇（pi-rpc-* → pi）。
export function topicOf(doc: ParsedDocMeta): string | undefined {
  if (doc.topic && doc.topic.trim()) return doc.topic.trim();
  const m = FILENAME_SLUG_RE.exec(doc.name);
  const slug = m?.[1];
  if (!slug) return undefined;
  const first = slug.split("-")[0];
  return first || undefined;
}

export function deriveTags(doc: ParsedDocMeta): Tag[] {
  const tags: Tag[] = [{ dim: "stage", value: doc.kind, label: STAGE_LABEL[doc.kind] }];

  if (doc.type && doc.type.trim()) {
    const t = doc.type.trim();
    tags.push({ dim: "type", value: t.toLowerCase(), label: t });
  }

  const topic = topicOf(doc);
  if (topic) tags.push({ dim: "topic", value: topic.toLowerCase(), label: topic });

  if (doc.depth && doc.depth.trim()) {
    const d = stripStatusAnnotation(doc.depth); // 复用去括号补注（Deep（跨 4 层）→ Deep）
    if (d) tags.push({ dim: "depth", value: d.toLowerCase(), label: d });
  }

  return tags;
}
