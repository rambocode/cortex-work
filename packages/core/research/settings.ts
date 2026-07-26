// CRE 的用户级设置与容错归一（spec §16、KTD6）。
//
// 设置来自磁盘 JSON，可能由旧版本写入、被用户手改、或整体缺失，因此归一化函数对任意 unknown
// 输入都必须给出可用结果且绝不抛错——设置读坏导致应用起不来，是比「设置丢了」严重得多的故障。
//
// 相关文件：模型选型见 ./model-selection；各 Consumer 的默认配置见 ./consumer；
// 直连搜索逃生阀的供应商表与请求构造见 ./direct-search。
import { isDirectSearchProviderId, type DirectSearchProviderId } from "./direct-search";

/// 自建 Search Server 的连接配置（spec KTD6 self-hosted 模式）。
export interface ResearchSearchServerSettings {
  baseUrl: string;
  workspaceId: string;
  /// **Electron safeStorage 加密后的密文**，只有主进程能解密。
  /// renderer 与 IPC 入参永不传明文 token（spec §16）：设置页提交明文后立即由 main 加密落盘，
  /// 回读给 renderer 的始终是这份密文（或仅「已配置」的布尔标记），不做反向解密下发。
  encryptedToken?: string;
}

/// 直连商业搜索的配置（Search Server 未部署时的逃生阀，见 ./direct-search 的文件头）。
///
/// **没有 baseUrl 字段**，这是刻意的：端点写死在 DIRECT_SEARCH_PROVIDERS 里。
/// 可配置的 baseUrl 等于从设置页开一个「任意 URL 出站」后门，绕开 url-safety / dns-guard。
export interface ResearchDirectSearchSettings {
  provider: DirectSearchProviderId;
  /// **Electron safeStorage 加密后的密文**，与 Search Server 的 PAT 同一条通道，
  /// renderer 提交明文后立即由 main 加密落盘，回读始终是密文（或「已配置」布尔）。
  encryptedApiKey?: string;
}

/// CRE 的全部用户可配置项。各 *Enabled 是按 Consumer 的灰度开关，允许「只开 Deep Research」。
export interface ResearchEngineSettings {
  /// 总开关。缺省 false —— 新能力，必须用户显式开启。
  enabled: boolean;
  deepResearchEnabled: boolean;
  /// 会话内检索：给聊天里的 agent 注入 web_search / web_read 工具，由模型自行决定何时用。
  chatEnabled: boolean;
  /// 「总是先检索再回答」：每轮发送前先跑一次 gather，把证据注入 system prompt。
  ///
  /// 与 chatEnabled 是两种触发方式而非层级关系，但**依赖它**：关掉会话内检索时，
  /// 这一项即便为 true 也不生效（判定在消费方，不在此处表达）。
  /// 默认关闭——它给每一轮对话都加上几秒延迟，不该是所有人的默认体验。
  chatAutoRetrieve: boolean;
  slidesEnabled: boolean;
  writingEnabled: boolean;
  /// 是否允许生成 MemoryCandidate（仍需逐条批准才写入，见 ./knowledge）。
  memoryEnabled: boolean;
  /// 研究专用的模型偏好（供应商 id 与模型 id）。**两者都可缺省 = 跟随全局默认模型**
  /// （ProviderSettings.defaultProviderId / defaultModel）。
  ///
  /// 为什么给研究单列一份而不复用全局默认：研究是长任务，一次 Session 的 token 消耗比一次
  /// 聊天高一到两个数量级，用户往往想给它配更便宜或更长上下文的模型；也有人专门给研究配
  /// 本机模型（选 loopback 供应商即等于「正文不出站」，这取代了原先的出站策略枚举）。
  /// 让研究换模型不必改动全局默认、连带影响聊天。
  ///
  /// 只存 id 不存快照：供应商可能被删或改名，运行时按 id 现查（见 ./model-selection 的三级回落），
  /// 查不到就落回全局默认，绝不因为设置里存了个失效 id 就让研究不可用。
  modelProviderId?: string;
  modelId?: string;
  searchServer?: ResearchSearchServerSettings;
  /// 直连商业搜索。**仅在 searchServer 未配置时生效**（自建服务端优先），
  /// 优先级由 main 的 createSearchClient 实现，不在此处表达。
  directSearch?: ResearchDirectSearchSettings;
}

/// 出厂默认：所有开关关闭；模型偏好留空 = 跟随全局默认模型。
export const DEFAULT_RESEARCH_ENGINE_SETTINGS: ResearchEngineSettings = {
  enabled: false,
  deepResearchEnabled: false,
  chatEnabled: false,
  chatAutoRetrieve: false,
  slidesEnabled: false,
  writingEnabled: false,
  memoryEnabled: false,
};

/// 只接受真正的布尔值。字符串 "true" / 数字 1 一律不算 true —— 这些开关控制的是数据出站，
/// 宽松的真值判定会让一个手抖写错类型的配置文件把功能悄悄打开。
function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

/// 读一个可选的非空字符串标识（供应商 id / 模型 id）。
///
/// 空串与非字符串一律视为「未设置」而返回 undefined：空串若被当成有效 id 存下来，
/// 选型时会拿它去匹配供应商、匹配不上再回落，多绕一圈；且 UI 的「跟随全局默认」选项
/// 提交的正是空串，这里必须把它折叠回 undefined，否则设置里会留下 `modelId: ""` 这种脏值。
function readOptionalId(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

/// 归一化 directSearch 段。provider 非法枚举时**整段丢弃**：留一个不认识的 id，
/// runtime 拿它查 DIRECT_SEARCH_PROVIDERS 会得到 undefined，然后在构造请求时炸在很远的地方，
/// 而用户在设置页上看到的却是「已配置」。
///
/// 只选了供应商还没填 key 是正常中间态，必须保留（否则用户选完下拉、还没粘贴 key 就被清空）。
function normalizeDirectSearch(raw: unknown): ResearchDirectSearchSettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  if (!isDirectSearchProviderId(source.provider)) return undefined;

  const normalized: ResearchDirectSearchSettings = { provider: source.provider };
  const encryptedApiKey = source.encryptedApiKey;
  if (typeof encryptedApiKey === "string" && encryptedApiKey.length > 0) {
    normalized.encryptedApiKey = encryptedApiKey;
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

  // 逐字段白名单重建（而非展开 raw），未知字段自然被丢弃，也杜绝原型污染类的键混入。
  // 附带效果：旧版本写入的 defaultModelDataPolicy 会在这里被自然丢弃，无需专门的迁移代码。
  const normalized: ResearchEngineSettings = {
    enabled: readBoolean(source, "enabled", DEFAULT_RESEARCH_ENGINE_SETTINGS.enabled),
    deepResearchEnabled: readBoolean(
      source,
      "deepResearchEnabled",
      DEFAULT_RESEARCH_ENGINE_SETTINGS.deepResearchEnabled,
    ),
    chatEnabled: readBoolean(source, "chatEnabled", DEFAULT_RESEARCH_ENGINE_SETTINGS.chatEnabled),
    chatAutoRetrieve: readBoolean(
      source,
      "chatAutoRetrieve",
      DEFAULT_RESEARCH_ENGINE_SETTINGS.chatAutoRetrieve,
    ),
    slidesEnabled: readBoolean(source, "slidesEnabled", DEFAULT_RESEARCH_ENGINE_SETTINGS.slidesEnabled),
    writingEnabled: readBoolean(
      source,
      "writingEnabled",
      DEFAULT_RESEARCH_ENGINE_SETTINGS.writingEnabled,
    ),
    memoryEnabled: readBoolean(source, "memoryEnabled", DEFAULT_RESEARCH_ENGINE_SETTINGS.memoryEnabled),
  };

  // 可选字段一律「有值才写键」：exactOptionalPropertyTypes 下 `key: undefined` 不合法，
  // 且写进去会让落盘 JSON 多出一堆 null。
  const modelProviderId = readOptionalId(source, "modelProviderId");
  if (modelProviderId) normalized.modelProviderId = modelProviderId;
  const modelId = readOptionalId(source, "modelId");
  if (modelId) normalized.modelId = modelId;

  const searchServer = normalizeSearchServer(source.searchServer);
  if (searchServer) normalized.searchServer = searchServer;
  const directSearch = normalizeDirectSearch(source.directSearch);
  if (directSearch) normalized.directSearch = directSearch;
  return normalized;
}
