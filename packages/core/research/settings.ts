// CRE 的用户级设置与容错归一（spec §16、KTD6）。
//
// 设置来自磁盘 JSON，可能由旧版本写入、被用户手改、或整体缺失，因此归一化函数对任意 unknown
// 输入都必须给出可用结果且绝不抛错——设置读坏导致应用起不来，是比「设置丢了」严重得多的故障。
//
// 相关文件：ModelDataPolicy 见 ./types；各 Consumer 的默认配置见 ./consumer。
import type { ModelDataPolicy } from "./types";

/// 自建 Search Server 的连接配置（spec KTD6 self-hosted 模式）。
export interface ResearchSearchServerSettings {
  baseUrl: string;
  workspaceId: string;
  /// **Electron safeStorage 加密后的密文**，只有主进程能解密。
  /// renderer 与 IPC 入参永不传明文 token（spec §16）：设置页提交明文后立即由 main 加密落盘，
  /// 回读给 renderer 的始终是这份密文（或仅「已配置」的布尔标记），不做反向解密下发。
  encryptedToken?: string;
}

/// CRE 的全部用户可配置项。各 *Enabled 是按 Consumer 的灰度开关，允许「只开 Deep Research」。
export interface ResearchEngineSettings {
  /// 总开关。缺省 false —— 新能力，必须用户显式开启。
  enabled: boolean;
  deepResearchEnabled: boolean;
  chatEnabled: boolean;
  slidesEnabled: boolean;
  writingEnabled: boolean;
  /// 是否允许生成 MemoryCandidate（仍需逐条批准才写入，见 ./knowledge）。
  memoryEnabled: boolean;
  defaultModelDataPolicy: ModelDataPolicy;
  searchServer?: ResearchSearchServerSettings;
}

/// 合法的 ModelDataPolicy 值清单，用于归一化时判定非法枚举。
const MODEL_DATA_POLICIES = [
  "local_only",
  "metadata_only",
  "evidence_allowed",
] as const satisfies readonly ModelDataPolicy[];

/// 出厂默认：所有开关关闭；策略取 evidence_allowed（用户真开启 CRE 时的常规预期），
/// 但它只是「默认值」，具体 Session 仍以 ResearchRequest.modelDataPolicy 为准。
export const DEFAULT_RESEARCH_ENGINE_SETTINGS: ResearchEngineSettings = {
  enabled: false,
  deepResearchEnabled: false,
  chatEnabled: false,
  slidesEnabled: false,
  writingEnabled: false,
  memoryEnabled: false,
  defaultModelDataPolicy: "evidence_allowed",
};

/// 只接受真正的布尔值。字符串 "true" / 数字 1 一律不算 true —— 这些开关控制的是数据出站，
/// 宽松的真值判定会让一个手抖写错类型的配置文件把功能悄悄打开。
function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

/// 归一化 searchServer 段。baseUrl 与 workspaceId 缺一不可：半截配置会在运行时报出难懂的
/// 请求错误，不如在此整段丢弃，让 UI 呈现「未配置」这一清晰状态。
function normalizeSearchServer(raw: unknown): ResearchSearchServerSettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const baseUrl = source.baseUrl;
  const workspaceId = source.workspaceId;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return undefined;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return undefined;

  const encryptedToken = source.encryptedToken;
  const normalized: ResearchSearchServerSettings = { baseUrl, workspaceId };
  if (typeof encryptedToken === "string" && encryptedToken.length > 0) {
    normalized.encryptedToken = encryptedToken;
  }
  return normalized;
}

/// 把任意 unknown（磁盘 JSON / IPC 入参）归一为完整的 ResearchEngineSettings。
/// 语义：未知字段丢弃、缺失字段取默认、类型或枚举非法一律回落默认，永不抛错。
export function normalizeResearchEngineSettings(raw: unknown): ResearchEngineSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_RESEARCH_ENGINE_SETTINGS };
  }
  const source = raw as Record<string, unknown>;

  const policy = source.defaultModelDataPolicy;
  const defaultModelDataPolicy = MODEL_DATA_POLICIES.includes(policy as ModelDataPolicy)
    ? (policy as ModelDataPolicy)
    : DEFAULT_RESEARCH_ENGINE_SETTINGS.defaultModelDataPolicy;

  // 逐字段白名单重建（而非展开 raw），未知字段自然被丢弃，也杜绝原型污染类的键混入。
  const normalized: ResearchEngineSettings = {
    enabled: readBoolean(source, "enabled", DEFAULT_RESEARCH_ENGINE_SETTINGS.enabled),
    deepResearchEnabled: readBoolean(
      source,
      "deepResearchEnabled",
      DEFAULT_RESEARCH_ENGINE_SETTINGS.deepResearchEnabled,
    ),
    chatEnabled: readBoolean(source, "chatEnabled", DEFAULT_RESEARCH_ENGINE_SETTINGS.chatEnabled),
    slidesEnabled: readBoolean(source, "slidesEnabled", DEFAULT_RESEARCH_ENGINE_SETTINGS.slidesEnabled),
    writingEnabled: readBoolean(
      source,
      "writingEnabled",
      DEFAULT_RESEARCH_ENGINE_SETTINGS.writingEnabled,
    ),
    memoryEnabled: readBoolean(source, "memoryEnabled", DEFAULT_RESEARCH_ENGINE_SETTINGS.memoryEnabled),
    defaultModelDataPolicy,
  };

  const searchServer = normalizeSearchServer(source.searchServer);
  if (searchServer) normalized.searchServer = searchServer;
  return normalized;
}
