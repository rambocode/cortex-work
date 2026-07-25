// 各 Consumer 的 CRE 默认配置表（spec §15）。
//
// **这是 U9（跨消费者迁移）的留位**：M1 阶段只有 chat 与 deep_research 真正接入 CRE，
// slides / writing / coding / knowledge 的条目先把默认值定下来，等各自适配器落地时直接取用，
// 避免届时在四处各写一份「大概这样」的默认值。
//
// 相关文件：类型定义见 ./types；TrustZone 见 ./evidence；用户级开关见 ./settings。
import type { TrustZone } from "./evidence";
import type {
  ResearchConsumer,
  ResearchMode,
  ResearchOutputRequest,
  SourceScope,
} from "./types";

/// Consumer 全集的运行时清单。测试与设置页遍历它，保证新增 Consumer 不会漏配默认值。
export const RESEARCH_CONSUMERS = [
  "chat",
  "deep_research",
  "slides",
  "writing",
  "coding",
  "knowledge",
] as const;

/// 单个 Consumer 的默认配置。allowedTrustZones 是「该 Consumer 最多能碰到哪些信任区」的上界，
/// 与 sourceScopes（这次研究实际要用哪些来源）是两回事：前者是能力边界，后者是本次选择。
export interface ConsumerDefaults {
  mode: ResearchMode;
  sourceScopes: SourceScope[];
  allowedTrustZones: TrustZone[];
  output: ResearchOutputRequest;
}

/// 默认配置表。取值依据 spec §15 各小节：
/// - chat：默认 quick，只在用户明确要最新信息时触发，产物是带引用的简短回答（§15.1）。
/// - deep_research：完整多轮，产出可导出的 Markdown 报告（§15.2）。
/// - slides：产出 Evidence Package 写进 deck 的 drafts/research/manifest.json（§15.3）。
/// - writing：外部 Web 由 CRE 负责，本地片段经 WritingResearchAdapter 映射为 local_file（§15.4）。
/// - coding：**只回 Evidence Package + SourceRef，不回叙述性正文**，避免网页指令被当成命令执行（§15.5）。
/// - knowledge：导入 URL/文件时复用检索与去重，产物进知识库（§15.6）。
export const CONSUMER_DEFAULTS: Record<ResearchConsumer, ConsumerDefaults> = {
  chat: {
    mode: "quick",
    sourceScopes: [{ kind: "public_web" }],
    allowedTrustZones: ["public_web"],
    output: { format: "answer", maxWords: 400, requireCitations: true },
  },
  deep_research: {
    mode: "deep",
    sourceScopes: [{ kind: "public_web" }],
    // 登录站点仍需来源级单独授权，这里只表示「该 Consumer 允许出现这个信任区」。
    allowedTrustZones: ["public_web", "authenticated_web"],
    output: { format: "report", maxWords: 3000, requireCitations: true },
  },
  slides: {
    mode: "standard",
    sourceScopes: [{ kind: "public_web" }],
    allowedTrustZones: ["public_web"],
    output: { format: "evidence_package", requireCitations: true },
  },
  writing: {
    mode: "standard",
    // roots 留空表示「本地来源可用但尚未选定目录」，由写作适配器在发起时填入工作区目录。
    sourceScopes: [{ kind: "public_web" }, { kind: "local_file", roots: [] }],
    allowedTrustZones: ["public_web", "local_file"],
    output: { format: "evidence_package", requireCitations: true },
  },
  coding: {
    mode: "standard",
    sourceScopes: [{ kind: "public_web" }],
    allowedTrustZones: ["public_web"],
    output: { format: "evidence_package", requireCitations: true },
  },
  knowledge: {
    mode: "standard",
    sourceScopes: [{ kind: "public_web" }, { kind: "local_file", roots: [] }],
    allowedTrustZones: ["public_web", "local_file", "memory"],
    output: { format: "evidence_package", requireCitations: true },
  },
};

/// 取某个 Consumer 的默认配置。
/// 返回深拷贝而非常量引用：调用方通常会在此基础上按用户选择改 sourceScopes / budget，
/// 直接返回引用会让一次会话的改动泄漏成全进程默认值。
export function resolveConsumerDefaults(consumer: ResearchConsumer): ConsumerDefaults {
  return structuredClone(CONSUMER_DEFAULTS[consumer]);
}
