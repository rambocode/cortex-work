// 报告 markdown 的**展示层**预处理（只影响渲染，不改写导出的原始 markdown）。
//
// 解决三类版式噪音：
// 1. 报告生成器会把 `# 目标` 写进正文开头，而运行视图头部已经展示了大标题——重复；
//    单子问题与目标同名时，紧接着的 `## 目标` 会再重复一次。
// 2. `[^chunkId]` 是 UUID 级别的长串，react-markdown 不认脚注语法，会原样糊在段落里；
//    这里按首次出现顺序转成 `[n]` 编号链接，渲染层再做成引用 chip。
// 3. 确定性生成器在标记后尾随 `（来源：标题）`，长标题把段落撑得支离破碎；
//    标题收进 chip 的 tooltip 与文末「参考来源」列表，正文里不再重复。
//
// 词法与 core/research/citation 保持一致：围栏代码块与行内代码里的同形文本不转换——
// 那里面的 `list[^idx]` 是代码，不是引用。
import type { CitationRef } from "@cortex-work/core/research/evidence";

/// 一条展示用引用：编号（1 起，首次出现顺序）、chunkId 与可展示的来源信息。
export interface DisplayRef {
  index: number;
  chunkId: string;
  title?: string;
  url?: string;
}

/// 预处理结果：markdown 已转换，refs 供渲染层在文末生成「参考来源」列表。
export interface PreparedReportMarkdown {
  markdown: string;
  refs: DisplayRef[];
}

/// 行级 token：行内代码 span 或引用标记，二选一。行内代码优先匹配，保证其中的 `[^x]` 原样保留。
/// 引用词法与 core/research/citation 的 CITATION_RE 同构，
/// 并顺手吃掉确定性生成器尾随的（来源：…）。
const INLINE_TOKEN_RE = /(`+)[^\n]*?\1|\[\^([A-Za-z0-9_][A-Za-z0-9_.:-]*)\](?:（来源：([^）\n]*)）)?/g;

/// 围栏起始行（CommonMark：最多 3 个前导空格，``` 或 ~~~）。
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

/// markdown 链接 title 属性的净化：双引号会破坏 `[t](u "title")` 语法，直接剔除。
function sanitizeTitle(title: string): string {
  return title.replace(/["\n\r]/g, " ").replace(/\s+/g, " ").trim();
}

/// 报告 markdown 的展示层预处理。objective 用于剥掉重复标题；citations 提供编号链接的
/// tooltip / 参考来源列表所需的标题与 URL。原始传入字符串不被修改（返回新串）。
export function prepareReportMarkdown(input: {
  markdown: string;
  objective: string;
  citations: readonly CitationRef[];
}): PreparedReportMarkdown {
  const objective = input.objective.trim();
  const citationByChunk = new Map(input.citations.map((c) => [c.chunkId, c]));
  const indexByChunk = new Map<string, number>();
  const refs: DisplayRef[] = [];

  const lines = input.markdown.split("\n");
  const out: string[] = [];
  let fenceMarker: string | null = null;
  // 两种重复标题各只剥一次：剥第二次就可能误伤正文里正当的同名小节。
  let strippedH1 = false;
  let strippedH2 = false;
  let seenContent = false;

  for (const line of lines) {
    const fence = FENCE_LINE_RE.exec(line);
    if (fence) {
      // 同种符号配对开关；未闭合的围栏一路吃到文末（与 citation.ts 的保守策略一致）。
      if (fenceMarker === null) fenceMarker = fence[1]![0]!;
      else if (fence[1]![0] === fenceMarker) fenceMarker = null;
      out.push(line);
      continue;
    }
    if (fenceMarker !== null) {
      out.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed !== "") {
      // 只认「第一个内容行就是 h1 且等于目标」的情形，避免误删正文深处的同名标题。
      const h1 = /^#\s+(.*)$/.exec(trimmed);
      if (!seenContent && !strippedH1 && h1 && objective !== "" && h1[1]!.trim() === objective) {
        strippedH1 = true;
        seenContent = true;
        continue;
      }
      const h2 = /^##\s+(.*)$/.exec(trimmed);
      if (!strippedH2 && h2 && objective !== "" && h2[1]!.trim() === objective) {
        strippedH2 = true;
        seenContent = true;
        continue;
      }
      seenContent = true;
    }

    INLINE_TOKEN_RE.lastIndex = 0;
    const converted = line.replace(
      INLINE_TOKEN_RE,
      (whole, _code: string | undefined, chunkId: string | undefined, inlineSource: string | undefined) => {
        if (chunkId === undefined) return whole; // 行内代码 span，原样保留
        let index = indexByChunk.get(chunkId);
        if (index === undefined) {
          index = refs.length + 1;
          indexByChunk.set(chunkId, index);
          const known = citationByChunk.get(chunkId);
          refs.push({
            index,
            chunkId,
            title: known?.title ?? inlineSource?.trim() ?? undefined,
            url: known?.url,
          });
        }
        const ref = refs[index - 1]!;
        const title = ref.title ? ` "${sanitizeTitle(ref.title)}"` : "";
        return `[[${index}]](#cite-${index}${title})`;
      },
    );
    out.push(converted);
  }

  return { markdown: out.join("\n"), refs };
}
