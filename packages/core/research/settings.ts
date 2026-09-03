// CRE 的用户级设置与容错归一（spec §16、KTD6）。
//
// 设置来自磁盘 JSON，可能由旧版本写入、被用户手改、或整体缺失，因此归一化函数对任意 unknown
// 输入都必须给出可用结果且绝不抛错——设置读坏导致应用起不来，是比「设置丢了」严重得多的故障。
//
// 相关文件：模型选型见 ./model-selection；各 Consumer 的默认配置见 ./consumer；
// 直连搜索逃生阀的供应商表与请求构造见 ./direct-search。
import { isDirectSearchProviderId, type DirectSearchProviderId } from "./direct-search";
import type { ResearchMode } from "./types";

/// 自建 Search Server 的连接配置（spec KTD6 self-hosted 模式）。
export interface ResearchSearchServerSettings {
  baseUrl: string;
  workspaceId: string;
  /// **Electron safeStorage 加密后的密文**，只有主进程能解密。
  /// renderer 与 IPC 入参永不传明文 token（spec §16）：设置页提交明文后立即由 main 加密落盘，
  /// 回读给 renderer 的始终是这份密文（或仅「已配置」的布尔标记），不做反向解密下发。
  encryptedToken?: string;
}

/// 搜索后端的选择。**单选，二者不并存**：
///   - "direct" 直连商业搜索（Brave / Tavily 等）——查询词从本机直接出站给服务商；
///   - "server" 自建 Search Server——查询词经服务端转发，有限流与审计。
///
/// 为什么要一个显式字段、而不是像从前那样「两边都配、按优先级挑」：优先级是隐式规则，
/// 用户看着两张都填好的表单无法判断此刻究竟哪条在生效（截图里那位就同时配了两边）。
/// 单选把这件事变成界面上看得见的一次选择。
///
/// 另一个后果是**不再静默回落**：选了 server 而它配坏了，就报「未配置」，
/// 不会悄悄降级到隐私边界更弱的直连——降级到用户没选的出站路径本身就是个问题。
export type ResearchSearchBackend = "direct" | "server";

/// 直连商业搜索的配置（默认后端，见 ./direct-search 的文件头）。
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
///
/// **chat / slides 场景刻意没有灰度开关**：联网由各自会话栏的「联网」pill 决定。联网带有
/// 数据出站语义，「这一轮要不要联网」是用户当下的意图，全局开关会让后续会话悄悄具备出站能力、
/// 而界面上看不出痕迹。旧配置里残留的 chatEnabled / slidesEnabled 由下面的白名单重建自然
/// 丢弃，无需迁移代码。
export interface ResearchEngineSettings {
  /// 总开关。缺省 false —— 新能力，必须用户显式开启。
  enabled: boolean;
  deepResearchEnabled: boolean;
  /// 「总是先检索再回答」：每轮发送前先跑一次 gather，把证据注入 system prompt。
  ///
  /// 与「模型自主调用 web_search」是两种触发方式而非层级关系，但**依赖会话级联网开关**：
  /// 会话没开「联网」时，这一项即便为 true 也不生效（判定在 ./chat-retrieval 的
  /// shouldAutoRetrieve，不在此处表达）。它管的是「联网时的行为风格」而非「是否允许联网」，
  /// 所以留在全局设置里。
  /// 默认关闭——它给每一轮对话都加上几秒延迟，不该是所有人的默认体验。
  chatAutoRetrieve: boolean;
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
  /// 用哪条搜索路径（单选）。缺省 "direct"：绝大多数人不会自建 Search Server，
  /// 默认该落在「填个 API key 就能用」的那一档。
  ///
  /// 旧配置没有这个键，归一化时会按既有实际生效项推断（见 readSearchBackend），
  /// 而不是一律取默认——否则已配好 Search Server 的用户升级后联网会直接失效。
  searchBackend: ResearchSearchBackend;
  /// 自建 Search Server 的连接配置。仅在 searchBackend === "server" 时被读取。
  searchServer?: ResearchSearchServerSettings;
  /// 直连商业搜索的配置。仅在 searchBackend === "direct" 时被读取。
  ///
  /// 两个字段都保留下来（而非选了哪条就清掉另一条）是刻意的：用户来回切换后端时
  /// 不该丢掉另一边已经填好的地址与密钥，切回去还得重新配一遍。
  directSearch?: ResearchDirectSearchSettings;
  /// 发起深度研究时用哪一档强度（预算档位，具体数值见 ./budget）。
  ///
  /// **为什么是全局默认档而不是每次选**：深度研究的新建表单已随「研究改为会话 skill」
  /// 一并移除，`/skill:research` 直接由一句话目标派发，派发路径上没有让用户逐次挑档位的
  /// 界面。档位对绝大多数人是「设一次就不动」的偏好，放全局比每次弹表单更贴合实际。
  ///
  /// 类型上可选、但归一化后必然有值（见 NormalizedResearchEngineSettings）：声明成可选
  /// 只是为了让手写的部分设置字面量（主要是各处测试夹具）不必逐个补齐。读取方走
  /// normalizeResearchEngineSettings 拿到的就是非可选的档位，不要再写 `?? "standard"`
  /// 兜底——那会让默认值有第二个真源。
  defaultMode?: ResearchMode;
  /// 研究时是否把「个人记忆」纳入来源范围（SourceScope 的 memory 档）。
  ///
  /// 同样是原新建表单上的勾选项。默认关闭：它会把本机记忆正文送进研究流程并可能随证据
  /// 发给云端模型，属于数据出站语义，与本文件其它出站开关一样必须用户显式开启。
  includeMemoryScope?: boolean;
  // 注：意图理解（发送前「改写+意图分类」）已是独立于研究引擎的一等公民功能，模型引用在
  // GeneralSettings.queryUnderstandModel（Agent 设置页），不在本切片。旧持久化档里的
  // chatQueryUnderstand / queryUnderstandProviderId / queryUnderstandModelId 键经白名单重建自然丢弃。
}

/// 归一化之后的设置：研究默认档两项在这里是**非可选**的。
///
/// 为什么要单独一个类型而不是把字段本身改成必填：ResearchEngineSettings 也被手写的部分
/// 配置字面量用着（测试夹具、IPC 入参片段），改成必填要逐个补齐；而归一化的产物是有保证的，
/// 让调用方在类型上直接看到这份保证，就不会再各写一次 `?? "standard"` 兜底。
export type NormalizedResearchEngineSettings = ResearchEngineSettings &
  Required<Pick<ResearchEngineSettings, "defaultMode" | "includeMemoryScope">>;

/// 研究默认档的出厂值。**单独提出来而不是只写在 DEFAULT_RESEARCH_ENGINE_SETTINGS 里**：
/// 这两项在类型上是可选的，从那个对象上读会得到 `ResearchMode | undefined`，
/// 归一化处就得再写一次 `?? "standard"`——默认值一旦有两个字面量，改默认档时必漏一个。
const DEFAULT_RESEARCH_MODE: ResearchMode = "standard";
const DEFAULT_INCLUDE_MEMORY_SCOPE = false;

/// 出厂默认：所有开关关闭；模型偏好留空 = 跟随全局默认模型；搜索后端默认直连；
/// 研究强度取「标准」（原新建表单的初始选中项，保持既有体验），个人记忆不入来源范围。
export const DEFAULT_RESEARCH_ENGINE_SETTINGS: NormalizedResearchEngineSettings = {
  enabled: false,
  deepResearchEnabled: false,
  chatAutoRetrieve: false,
  writingEnabled: false,
  memoryEnabled: false,
  searchBackend: "direct",
  defaultMode: DEFAULT_RESEARCH_MODE,
  includeMemoryScope: DEFAULT_INCLUDE_MEMORY_SCOPE,
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

/// 读研究强度档位。封闭枚举，非法值一律回落标准档而不是保留原值——
/// 档位会直接索引 ./budget 的 MODE_BUDGETS，留个不认识的值会让预算取到 undefined，
/// 然后在夹取时炸在离设置很远的地方。
function readMode(source: Record<string, unknown>): ResearchMode {
  const value = source.defaultMode;
  return value === "quick" || value === "standard" || value === "deep"
    ? value
    : DEFAULT_RESEARCH_MODE;
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

/// 读 searchBackend，缺失或非法时**按既有配置推断**而不是取默认。
///
/// 这个键是「两条路径改单选」时新加的，所有升级上来的配置都没有它。若一律回落 "direct"，
/// 已经部署并配好 Search Server 的用户升级后会突然走到「直连但没填 key」，联网整个失效——
/// 而设置页上他的 Search Server 明明显示「已配置」，无从排查。
///
/// 推断依据是**升级前实际生效的那一条**：旧的 createSearchClient 是
/// `createSearchServerClient() ?? createDirectSearchClient()`，而 Search Server 客户端
/// 需要 baseUrl + workspaceId + 可解密的令牌才构造得出来。所以只有三者齐全才推断 server，
/// 缺令牌的半截配置在升级前走的也是直连回落，推断成 direct 才叫「保持既有行为」。
function readSearchBackend(source: Record<string, unknown>): ResearchSearchBackend {
  const value = source.searchBackend;
  if (value === "direct" || value === "server") return value;
  const server = normalizeSearchServer(source.searchServer);
  return server?.encryptedToken ? "server" : "direct";
}

/// 把任意 unknown（磁盘 JSON / IPC 入参）归一为完整的设置。
/// 语义：未知字段丢弃、缺失字段取默认、类型或枚举非法一律回落默认，永不抛错。
/// 例外是 searchBackend：它按既有配置推断而非取默认，理由见 readSearchBackend。
export function normalizeResearchEngineSettings(raw: unknown): NormalizedResearchEngineSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_RESEARCH_ENGINE_SETTINGS };
  }
  const source = raw as Record<string, unknown>;

  // 逐字段白名单重建（而非展开 raw），未知字段自然被丢弃，也杜绝原型污染类的键混入。
  // 附带效果：旧版本写入的 defaultModelDataPolicy 会在这里被自然丢弃，无需专门的迁移代码。
  const normalized: NormalizedResearchEngineSettings = {
    enabled: readBoolean(source, "enabled", DEFAULT_RESEARCH_ENGINE_SETTINGS.enabled),
    deepResearchEnabled: readBoolean(
      source,
      "deepResearchEnabled",
      DEFAULT_RESEARCH_ENGINE_SETTINGS.deepResearchEnabled,
    ),
    chatAutoRetrieve: readBoolean(
      source,
      "chatAutoRetrieve",
      DEFAULT_RESEARCH_ENGINE_SETTINGS.chatAutoRetrieve,
    ),
    writingEnabled: readBoolean(
      source,
      "writingEnabled",
      DEFAULT_RESEARCH_ENGINE_SETTINGS.writingEnabled,
    ),
    memoryEnabled: readBoolean(source, "memoryEnabled", DEFAULT_RESEARCH_ENGINE_SETTINGS.memoryEnabled),
    searchBackend: readSearchBackend(source),
    // 这两个键**无条件写出**（不走下面「有值才写键」那条规则）：它们类型上可选，
    // 但派发路径要拿它们构造 ResearchRequest，缺省时必须由这里给出唯一的默认值，
    // 而不是让每个调用方各写一次 `?? "standard"`。
    defaultMode: readMode(source),
    includeMemoryScope: readBoolean(source, "includeMemoryScope", DEFAULT_INCLUDE_MEMORY_SCOPE),
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

/// 当前选中的搜索后端是否已配好。
///
/// **只看 searchBackend 选中的那一条**，另一条配得再全也不算。否则会出现
/// 「选了直连、只配了 Server」而「联网」pill 却可点的状态，用户开了之后主进程那侧
/// createSearchClient 返回 null，得到的是一句「搜索服务未配置」。
///
/// **只看配置是否完整，不做连通性探测**：主进程侧的调用发生在 agent 启动路径上，
/// 为此发一次网络请求会给每次会话启动加上几百毫秒；配了但不通，由工具调用时的错误信息告知，
/// 那时用户已经在等结果、有心理预期。
///
/// **住在 core 而非各自实现一份**：主进程用它决定是否注入研究 MCP，渲染端用它决定输入框上
/// 「联网」pill 是否可点。两份拷贝一旦漂移，就会出现「按钮可点、点了不注入」这种查不出原因的
/// 状态——与 consumer-gate 抽成单文件是同一个理由。判定条件必须与 main 的
/// createSearchServerClient / createDirectSearchClient 的构造前提保持一致。
export function hasSearchBackend(settings: ResearchEngineSettings | undefined): boolean {
  if (!settings) return false;
  if (settings.searchBackend === "server") {
    const server = settings.searchServer;
    return !!(server?.baseUrl && server.workspaceId && server.encryptedToken);
  }
  return !!settings.directSearch?.encryptedApiKey;
}
