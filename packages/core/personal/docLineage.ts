// 按 origin 字段把 ParsedDocMeta[] 构成血缘森林。origin 文本不规范（路径 + § 章节 +
// 自由说明 + null/无 brainstorm 混写），故按 basename 容错匹配父节点，容相对/绝对差异。
// 抽不到文件路径的不当「文件缺失」处理（docs/lessons.md ENOENT 教训），归入孤儿。
// 输出：pipelines（成链，按 ideation→brainstorm→plan 排序）+ orphans（无血缘关系）。

import type { DocKind, ParsedDocMeta } from "./docMeta";

export interface Lineage {
  pipelines: ParsedDocMeta[][];
  orphans: ParsedDocMeta[];
}

const KIND_RANK: Record<DocKind, number> = { ideation: 0, brainstorm: 1, plan: 2 };

// 从 origin 文本数组里抽出 docs/...md 片段的 basename（容相对/绝对/带 §章节）。
export function extractOriginBasenames(origin: string[]): string[] {
  const out: string[] = [];
  for (const raw of origin) {
    const matches = raw.match(/[\w./-]*\.md/g);
    if (!matches) continue;
    for (const path of matches) {
      const base = path.split("/").pop();
      if (base) out.push(base);
    }
  }
  return out;
}

export function buildLineage(docs: ParsedDocMeta[]): Lineage {
  const byBasename = new Map<string, number>(); // basename → index
  docs.forEach((d, i) => byBasename.set(d.name, i));

  // 无向邻接：child.origin 命中某 doc → 连边。
  const adj: Set<number>[] = docs.map(() => new Set<number>());
  docs.forEach((doc, i) => {
    for (const base of extractOriginBasenames(doc.origin)) {
      const parent = byBasename.get(base);
      if (parent !== undefined && parent !== i) {
        adj[i]?.add(parent);
        adj[parent]?.add(i);
      }
    }
  });

  // 连通分量
  const seen = new Set<number>();
  const pipelines: ParsedDocMeta[][] = [];
  const orphans: ParsedDocMeta[] = [];

  for (let i = 0; i < docs.length; i++) {
    if (seen.has(i)) continue;
    const stack = [i];
    const comp: number[] = [];
    seen.add(i);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const nb of adj[cur] ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    if (comp.length <= 1) {
      const d = docs[i];
      if (d) orphans.push(d);
    } else {
      const chain = comp
        .map((idx) => docs[idx]!)
        .sort((a, b) => {
          const r = KIND_RANK[a.kind] - KIND_RANK[b.kind];
          if (r !== 0) return r;
          return (a.date ?? "").localeCompare(b.date ?? "");
        });
      pipelines.push(chain);
    }
  }

  return { pipelines, orphans };
}
