// Knowledge 与 Memory 候选类型（spec §8.3、KTD10）。
//
// **这是 U10 的留位：M1 阶段只有类型，没有任何写入实现。**
// 红线（KTD10）：MemoryCandidate 未经用户显式批准（status === "approved"）**绝不能**进入
// buildMemoryAppend()。CRE SQLite 只保存带 provenance 的候选，批准动作必须由用户在 UI 上逐条完成；
// 来源过期时候选标记为 stale，也不得自动删除用户已确认的内容。
//
// 相关文件：证据链（EvidenceChunk / TrustZone）见 ./evidence；编排类型见 ./types。
import type { TrustZone } from "./evidence";

/// 从一个或多个 EvidenceChunk 归纳出的可复用知识对象（spec §8.3）。
/// 它是知识库内的对象，不等于 Memory——写进长期 Memory 必须再走 MemoryCandidate 的批准流程。
export interface KnowledgeItem {
  knowledgeId: string;
  /// 陈述的主体（实体/主题），用于归并同主体的多条知识。
  subject: string;
  statement: string;
  confidence: "low" | "medium" | "high";
  /// 支撑该陈述的证据片段 id（见 ./evidence 的 EvidenceChunk.chunkId）。空数组视为无依据，不可展示为事实。
  citationChunkIds: string[];
  /// 支撑证据涉及的全部信任区。含非 public_web 时，出站给云模型需要来源级单独授权。
  trustZones: TrustZone[];
  /// 知识的有效期。时效性事实（价格、版本号、任职）必须带上，过期后候选转 stale。
  validFrom?: string;
  validUntil?: string;
  createdAt: string;
  updatedAt: string;
}

/// Memory 写入候选：可写入长期 Memory、但**尚未被用户批准**的条目（spec §8.3、KTD10）。
/// status 是唯一的准入闸门，任何绕过它直接写 Memory 的代码路径都是 bug。
export interface MemoryCandidate {
  candidateId: string;
  knowledgeId: string;
  /// 写入 Memory 的哪个作用域；与现有 Memory 文件的分区对应。
  scope: "profile" | "preferences" | "projects";
  text: string;
  /// provenance：候选来自哪些证据片段，供用户在批准前查看来源。
  citationChunkIds: string[];
  /// pending 待批准；approved 已批准（唯一可写入态）；rejected 用户拒绝；
  /// revoked 曾批准后撤销；stale 来源过期需复核（不自动删除）。
  status: "pending" | "approved" | "rejected" | "revoked" | "stale";
  approvedAt?: string;
  createdAt: string;
}
