// 从已完成的研究报告归纳知识条目与 Memory 写入候选（U10）。
//
// **KTD10 红线**：本模块只产出 status="pending" 的候选，**永远不产出 approved**。
// 批准动作必须由用户在设置页逐条完成；任何在这里直接标 approved 的改动都是安全缺陷，
// 因为那等于让一次自动流程往用户的长期记忆里写东西。
//
// 归纳策略刻意保守：**只从报告里被引用过的句子提取**，不做 LLM 二次总结。
// 理由有二：
//   1. 记忆是长期资产，一条错误的「用户偏好」会污染之后每一轮对话；再过一次模型
//      就多一次幻觉机会，而这里的输入（报告正文）本身已经是模型写的了。
//   2. 引用过的句子天然带 chunkId，provenance 是现成的；模型改写后的句子无从溯源。
//
// 相关文件：类型见 core/research/knowledge；仓储读写见 ./research-repository；
// 三段化记忆见 core/memory/markdown。
import { randomUUID } from "node:crypto";
import type { KnowledgeItem, MemoryCandidate } from "@cortex-work/core/research/knowledge";
import type { ResearchReport, ResearchSessionView } from "@cortex-work/core/research/types";
import type { CitationRef, TrustZone } from "@cortex-work/core/research/evidence";

/// 单次沉淀最多产出的候选数。
///
/// 上限存在的理由：一份 deep 档报告可能有几十条引用，全变成待批条目会让用户面对
/// 一屏根本读不完的清单，最后要么全批（等于没有审批）要么全不看（等于功能没用）。
/// 10 条是「一次能认真读完」的量级。
export const MAX_MEMORY_CANDIDATES_PER_SESSION = 10;

/// 候选文本的字符上限。记忆是每轮都注入的常驻开销，单条太长会挤掉其它记忆。
const MAX_CANDIDATE_CHARS = 200;

/// 太短的句子不值得沉淀（多半是标题残片或「综上所述」这类连接词）。
const MIN_CANDIDATE_CHARS = 12;

export interface ExtractKnowledgeInput {
  view: ResearchSessionView;
  now?: () => Date;
  newId?: () => string;
}

export interface ExtractKnowledgeResult {
  items: KnowledgeItem[];
  candidates: MemoryCandidate[];
}

/// 把报告正文按句子切开，用于把引用锚点映射回一句完整的话。
///
/// 中英文标点都切：报告是模型写的，中英混排是常态。保留结尾标点让候选读起来是完整句子。
function splitSentences(markdown: string): string[] {
  return markdown
    // 去掉 Markdown 的结构性符号，避免候选里混进 `##` `- ` `**`。
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/\*\*/g, "")
    .split(/(?<=[。！？!?])\s*|\n{2,}/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/// 引用标记 `[^chunkId]` 的正则。报告生成器就是按这个形态写引用的。
const CITATION_MARKER = /\[\^([^\]]+)\]/g;

/// 从一句话里取出它引用的 chunkId 集合。
function chunkIdsIn(sentence: string): string[] {
  const ids = new Set<string>();
  for (const match of sentence.matchAll(CITATION_MARKER)) {
    const id = match[1]?.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

/// 去掉句子里的引用标记，得到可直接写进记忆的干净文本。
function stripCitations(sentence: string): string {
  return sentence.replace(CITATION_MARKER, "").replace(/\s{2,}/g, " ").trim();
}

/// 候选落到哪个记忆分区。
///
/// 研究结论几乎都是「关于世界的事实」而不是「关于用户的事实」，所以固定 projects——
/// 那是三个分区里唯一承载「正在进行的项目与长期目标」的，研究结论作为项目背景最贴切。
/// 写进 profile（用户画像）会是明确的错误：一条市场数据不是用户的身份信息。
const CANDIDATE_SCOPE: MemoryCandidate["scope"] = "projects";

/// 报告 → 知识条目 + 待批候选。
///
/// 纯函数（除注入的 newId / now 外无副作用），因此可以完整单测——
/// 这一层的正确性直接决定用户长期记忆里会出现什么，值得逐条锁住。
export function extractKnowledgeFromReport(input: ExtractKnowledgeInput): ExtractKnowledgeResult {
  const report: ResearchReport | undefined = input.view.report;
  if (!report?.markdown) return { items: [], candidates: [] };

  const newId = input.newId ?? ((): string => randomUUID());
  const nowIso = (input.now ?? ((): Date => new Date()))().toISOString();

  // 只认报告实际登记过的引用：模型可能写出 `[^不存在的id]`，citation-validator 会在
  // 报告落库前删掉它们，但这里再核一次成本极低，而放过一条就等于把幻觉写进长期记忆。
  const knownChunkIds = new Set(report.citations.map((citation: CitationRef) => citation.chunkId));
  const trustZones = collectTrustZones(input.view);

  const items: KnowledgeItem[] = [];
  const candidates: MemoryCandidate[] = [];
  const seenTexts = new Set<string>();

  for (const sentence of splitSentences(report.markdown)) {
    if (candidates.length >= MAX_MEMORY_CANDIDATES_PER_SESSION) break;

    const cited = chunkIdsIn(sentence).filter((id) => knownChunkIds.has(id));
    // 没有有效引用的句子一律跳过——那是模型的推断或过渡句，不是可溯源的事实。
    if (cited.length === 0) continue;

    const text = stripCitations(sentence);
    if (text.length < MIN_CANDIDATE_CHARS) continue;
    if (text.length > MAX_CANDIDATE_CHARS) continue;
    // 同一句话在报告里出现两次（摘要 + 正文）是常见排版，去重避免重复待批。
    if (seenTexts.has(text)) continue;
    seenTexts.add(text);

    const knowledgeId = newId();
    items.push({
      knowledgeId,
      // subject 用研究目标：这批知识都是围绕它产生的，UI 分组时按它聚合最自然。
      subject: input.view.summary.objective,
      statement: text,
      // 置信度按引用条数：多个独立片段支撑的结论更可信。不做更花哨的推断——
      // 这里任何"聪明"的估计都是在给一个本来就模糊的量加一层假精确。
      confidence: cited.length >= 2 ? "high" : "medium",
      citationChunkIds: cited,
      trustZones,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    candidates.push({
      candidateId: newId(),
      knowledgeId,
      scope: CANDIDATE_SCOPE,
      text,
      citationChunkIds: cited,
      // ⚠️ KTD10：恒为 pending。改成别的值即是安全缺陷（见文件头）。
      status: "pending",
      createdAt: nowIso,
    });
  }

  return { items, candidates };
}

/// 本次研究涉及的信任区全集。
///
/// 记在知识条目上而不是丢掉：含非 public_web 的知识若日后要出站给云模型，
/// 需要来源级单独授权（见 core/research/knowledge.ts 的字段注释）。
function collectTrustZones(view: ResearchSessionView): TrustZone[] {
  const zones = new Set<TrustZone>();
  for (const chunk of view.chunks ?? []) zones.add(chunk.trustZone);
  // 证据未加载（detail 不是 evidence 级别）时回落 public_web：
  // 窄面与 M1 的 deep_research 都只走公网，这是唯一可能的取值。
  if (zones.size === 0) zones.add("public_web");
  return [...zones];
}
