// Cortex Research Engine（CRE）的核心编排领域类型（spec §7、§8.1、§9、§10）。
//
// 定位：这是 main 进程编排层、preload 桥、renderer 视图三方共用的「形状真源」，只有类型与常量，
// 不含任何算法（预算夹取见 ./budget，引用校验见 ./citation，均由 U1 的其它文件实现）。
//
// 相关文件（不建 barrel，按需从子路径 import）：
// - 证据链类型（SourceRef / SearchCandidate / ResearchDocument / EvidenceChunk / CitationRef）见 ./evidence
// - Knowledge 与 Memory 候选见 ./knowledge
// - 各 Consumer 的默认配置见 ./consumer
// - 用户可配置项与归一化见 ./settings
// - Worker 进程间协议（snake_case）见 ./protocol
//
// 命名风格：本文件是 TS 领域模型，一律 camelCase；只有 ./protocol 与 Go 搜索 API 用 snake_case，
// 两者在 main 侧的 rpc-client / search-server-client 边界处转换。
import type { CitationRef, EvidenceChunk, ResearchDocument, TrustZone } from "./evidence";

// ---------------------------------------------------------------------------
// 消费者与模式
// ---------------------------------------------------------------------------

/// 调用 CRE 的产品能力（spec §7.1）。每个 Consumer 的默认配置见 ./consumer。
export type ResearchConsumer =
  | "chat"
  | "deep_research"
  | "slides"
  | "writing"
  | "coding"
  | "knowledge";

/// 研究强度档位。决定默认预算（轮数/查询数/文档数/时长），具体数值见 ./budget。
export type ResearchMode = "quick" | "standard" | "deep";

// 关于「数据出站」：**没有独立的出站策略枚举**（原 spec KTD5 的 ModelDataPolicy 已移除）。
// 数据去哪完全由用户为研究选定的模型决定——选 loopback 上的本地模型，正文就不离开本机；
// 选云供应商，证据正文片段就会发给它。再叠一层三选一的枚举只是同一件事的第二个真源，
// 用户既要选模型又要选策略，两者还能互相矛盾（选了云模型又选 local_only → 研究直接不可用）。
// 选型与「所选模型是否在本机」的判定见 ./model-selection。
//
/// 一次研究允许的来源范围。判别字段是 kind，新增来源类型时必须同步 ./consumer 的默认表。
export type SourceScope =
  | { kind: "public_web" }
  /// roots 是允许读取的本地目录绝对路径白名单；空数组表示「本地来源可用但尚未选定目录」。
  | { kind: "local_file"; roots: string[] }
  | { kind: "enterprise"; tenantId: string }
  | { kind: "memory" };

// ---------------------------------------------------------------------------
// 计划与预算（spec §8.1）
// ---------------------------------------------------------------------------

/// 一次 Session 的硬预算。用户覆盖值仍须经 ./budget 的夹取，模型给出的值一律不可信。
export interface ResearchBudget {
  maxRounds: number;
  maxQueries: number;
  maxCandidates: number;
  maxDocuments: number;
  maxBrowserFetches: number;
  maxDurationMs: number;
  /// 单次 Session 允许发给模型的证据总字符数上限，是来源级 allowCloudModel 之外的第二道出站闸门。
  maxEvidenceCharsToModel: number;
}

/// 「研究到什么程度算够」的判定阈值（spec §8.1）。Coverage 评估据此产出 CoverageReport。
export interface CompletionCriteria {
  minSourcesPerSubquestion: number;
  minIndependentDomains: number;
  requirePrimarySource: boolean;
  requireContradiction: boolean;
  /// 相关性下限（0~1）。低于此值的 chunk 不计入覆盖度。
  minimumRelevance: number;
}

/// 时间范围筛选。与 Go 搜索 API 的 time_range 同集合，边界处做 snake_case 转换。
export type ResearchTimeRange = "day" | "week" | "month" | "year" | "all";

/// 目标被拆出的可独立验证的子问题。id 在单个 Plan 内唯一，被 PlannedQuery 与 Coverage 引用。
export interface ResearchSubquestion {
  id: string;
  text: string;
  /// 为什么需要这个子问题；只供 UI 展示与调试，不参与任何自动判定。
  rationale?: string;
}

/// 一条待执行的搜索查询。**Planner 不得生成 URL**（spec §10.1），只能给查询词与筛选条件；
/// domainAllowlist/Blocklist 由 Plan Validator 校验后才下发给 Search Server。
export interface PlannedQuery {
  queryId: string;
  subquestionId: string;
  text: string;
  language?: string;
  categories?: string[];
  timeRange?: ResearchTimeRange;
  domainAllowlist?: string[];
  domainBlocklist?: string[];
  limit?: number;
}

/// 全局检索范围偏好，作为各 PlannedQuery 未显式指定时的缺省。
export interface ResearchScope {
  language?: string;
  timeRange?: ResearchTimeRange;
  regions?: string[];
}

/// 初始 Planner 的输出（spec §8.1）。schemaVersion 固定为 1，字段变更须 +1 并处理旧 Session 兼容。
export interface ResearchPlan {
  schemaVersion: 1;
  objective: string;
  scope: ResearchScope;
  subquestions: ResearchSubquestion[];
  initialQueries: PlannedQuery[];
  budget: ResearchBudget;
  completion: CompletionCriteria;
}

// ---------------------------------------------------------------------------
// 请求与输出
// ---------------------------------------------------------------------------

/// 消费方对产物形态的要求。requireCitations 为 true 时，无有效 CitationRef 的事实段
/// 必须被标记为 unsupported，不得表现为确定事实（spec §10.4）。
///
/// **刻意没有 maxWords 之类的用户配置字段**：报告生成器按 quick / standard / deep
/// 提供统一的证据感知软目标，用户在研究目标里的「简要说明」「详尽综述」仍可进一步调节。
/// 曾经的 maxWords 会与模式档位形成两套互相矛盾的真源，因此不再开放第二个长度旋钮。
/// 模型的输出 token 上限仍只是安全阀（见 report-generator 的 resolveReportMaxTokens）。
export interface ResearchOutputRequest {
  format: "report" | "evidence_package" | "answer";
  requireCitations: boolean;
}

/// Consumer 发起一次研究的入参（spec §7.1）。budget 只允许部分覆盖，缺项取模式默认值后夹取。
export interface ResearchRequest {
  consumer: ResearchConsumer;
  objective: string;
  mode: ResearchMode;
  sourceScopes: SourceScope[];
  output: ResearchOutputRequest;
  budget?: Partial<ResearchBudget>;
}

// ---------------------------------------------------------------------------
// Session 状态与视图
// ---------------------------------------------------------------------------

/// Session 生命周期状态（spec KTD8）。**不存在 "running"**：运行中由具体阶段状态表达；
/// 应用启动时所有非终态统一转为 interrupted，可恢复。
export type ResearchSessionStatus =
  | "created"
  | "planning"
  | "searching"
  | "fetching"
  | "evaluating"
  | "reporting"
  | "completed"
  | "paused"
  | "cancelled"
  | "failed"
  | "interrupted";

/// 运行中的阶段（状态机里的非终态子集），用于进度事件与 UI 分步展示。
export type ResearchStage = "planning" | "searching" | "fetching" | "evaluating" | "reporting";

/// 读取 Session 的详细程度（spec §16）。逐级放开数据量：
/// summary 只有元数据，full 加计划/轮次/覆盖/报告，evidence 才加文档与证据正文。
export type ResearchDetailLevel = "summary" | "full" | "evidence";

/// Session 的元数据摘要——list 与 get(..., "summary") 的返回单位。
///
/// **隐私红线（spec §19.3.2）：此结构绝不包含任何正文、token 或模型凭据。**
/// 只有计数与状态。新增字段前先问一句「它会不会把网页正文/密钥带进 renderer」，
/// 会就放到 ResearchSessionView 的 evidence 层级里，而不是这里。
export interface ResearchSessionSummary {
  sessionId: string;
  consumer: ResearchConsumer;
  objective: string;
  mode: ResearchMode;
  status: ResearchSessionStatus;
  createdAt: string;
  updatedAt: string;
  roundCount: number;
  documentCount: number;
  chunkCount: number;
  /// 可展示的失败原因（人类可读、无正文）。仅 failed 状态下有意义。
  errorMessage?: string;
}

/// 一轮编排的执行记录。用于 Deep Research 任务页展示「计划 → 轮次 → 来源」。
export interface ResearchRound {
  roundIndex: number;
  startedAt: string;
  endedAt?: string;
  /// 本轮 Gap Planner 的决策；首轮由初始 Plan 驱动时可缺省。
  decision?: PlannerDecision["action"];
  /// 本轮执行的查询 id（正文见 plan.initialQueries / 后续轮的补充查询）。
  queryIds: string[];
  candidateCount: number;
  documentCount: number;
  chunkCount: number;
}

/// 最终报告。citations 中的 chunkId 必须全部是已知 id，未知的由 Citation Validator 删除；
/// unsupportedSections 记录被判定为「无有效引用」的段落标识，供 UI 显式降级展示。
export interface ReportGenerationStats {
  /// 报告生成时已经抓取并可供编排器使用的文档/片段总量。
  availableDocumentCount: number;
  availableChunkCount: number;
  /// 经过出站策略、相关性和 prompt 预算筛选后实际送入模型的独立文档/片段数。
  includedDocumentCount: number;
  includedChunkCount: number;
  /// 最终通过 Citation Validator 的独立文档/片段数。
  citedDocumentCount: number;
  citedChunkCount: number;
  /// 所有报告模型调用实际发送的 prompt 字符总数；重试会累计。
  promptEvidenceChars: number;
  /// 至少一个符合条件的证据片段因 prompt 字符预算未被送入模型。
  promptTruncated: boolean;
  /// 去掉 Markdown 标记与引用编号后的正文字符数，用于判断报告是否明显偏短。
  reportBodyChars?: number;
  /// 有证据可写且最终正文中至少出现一个有效引用的子问题数量。
  coveredSubquestionCount?: number;
  /// 本次是否因完整度或来源多样性不足执行过一次质量重写。
  qualityRetryCount?: number;
  /// 最终报告是否达到当前研究强度对应的结构、覆盖和篇幅软目标。
  qualityPassed?: boolean;
  /// 未达到的质量项；历史报告没有该字段。
  qualityIssues?: string[];
  /// true 表示模型不可用、调用失败或空输出，正文来自确定性降级摘要。
  usedFallback?: boolean;
}

export interface ResearchReport {
  markdown: string;
  citations: CitationRef[];
  unsupportedSections: string[];
  generatedAt: string;
  /// 老数据库中的报告没有该字段，读取时保持可选以兼容历史数据。
  generationStats?: ReportGenerationStats;
}

/// 按 detail level 逐级填充的 Session 视图。
/// summary → 只有 summary；full → 补 plan/rounds/coverage/report；evidence → 再补 documents/chunks。
export interface ResearchSessionView {
  summary: ResearchSessionSummary;
  /// 创建时的输出要求（产物形态 / 是否强制引用）。
  ///
  /// 放在 view 而不是 summary：summary 会经 IPC 送给 renderer 并用于列表渲染，
  /// 而 output 只有重跑（逐项继承参数）需要。
  output?: ResearchOutputRequest;
  /// 创建时的来源范围。与 output 同理放在 view 而不是 summary：只有重跑与编排需要它。
  sourceScopes?: readonly SourceScope[];
  /// 会话归属的项目 id；缺省表示不使用项目（报告归档落 Documents）。
  ///
  /// 与 output / sourceScopes 同理放 view 不放 summary：summary 会整批过 IPC 用于列表渲染，
  /// 而「这次研究属于哪个项目」只有报告归档与重跑继承需要。
  projectId?: string;
  plan?: ResearchPlan;
  rounds?: ResearchRound[];
  coverage?: CoverageReport[];
  report?: ResearchReport;
  documents?: ResearchDocument[];
  chunks?: EvidenceChunk[];
}

/// list() 的筛选条件。before 是游标（updatedAt 的 ISO 字符串），配合 limit 做倒序分页。
export interface ResearchSessionFilter {
  consumer?: ResearchConsumer;
  status?: ResearchSessionStatus;
  limit?: number;
  before?: string;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

/// 执行流水的一条记录（UI 的「实时活动」列表）。
///
/// **text 的内容受限**（spec §19.3.1/§19.3.2）：只允许出现查询词、域名、决策名与计数。
/// 抓取到的网页正文、标题、完整 URL（query string 可能含搜索词）一律不得进入——
/// 它们属于 evidence 级别，只能由右栏在用户显式展开来源时经 get(..., "evidence") 取。
export interface ResearchActivityEvent {
  type: "activity";
  sessionId: string;
  /// 发生时刻（ISO）。UI 按它排序与展示，不参与任何状态判定。
  at: string;
  kind: "query" | "document" | "fetch_failed" | "decision" | "report";
  text: string;
  roundIndex?: number;
}

/// main → renderer 的研究事件（spec §16）。
///
/// **不带证据正文**——网页正文、摘录、文档标题只能经 get(..., "evidence") 显式取。
/// 唯一携带长文本的是 report_delta，它带的是**模型自己写的报告正文**：这份内容本来就要经
/// get(..., "full") 完整回到 renderer，流式只是把它提前一点送到，并没有新增数据类别。
/// activity 的 text 另有更严的约束，见 ResearchActivityEvent。
export type ResearchEvent =
  | {
      type: "stage";
      sessionId: string;
      stage: ResearchStage;
      /// 阶段内进度；总量未知时可缺省（例如 planning 阶段）。
      progress?: { completed: number; total: number };
    }
  | {
      /// 任意一次状态落库都会广播它（由 SessionStateWriter 的 onStatus 单点发出）。
      ///
      /// 为什么不能只靠 stage / done：ResearchStage 只覆盖 5 个运行中阶段，done 只覆盖 3 个终态，
      /// paused / interrupted 两个状态在事件里根本无法表达——这正是「点暂停后界面不变、
      /// 必须重开覆盖层才看到」的成因。
      type: "status";
      sessionId: string;
      status: ResearchSessionStatus;
    }
  | {
      type: "round";
      sessionId: string;
      roundIndex: number;
      decision?: PlannerDecision["action"];
    }
  | ResearchActivityEvent
  | {
      /// 报告正文的流式增量（**增量而非累计全文**：累计会让长报告的 IPC 流量变成 O(n²)）。
      /// 仅供展示；落库的永远是引用校验后的最终稿。
      type: "report_delta";
      sessionId: string;
      delta: string;
    }
  | {
      type: "error";
      sessionId: string;
      /// 稳定的可编程错误码，UI 据此选文案；message 是人类可读补充，无正文。
      code: string;
      message: string;
      /// 非终态错误（例如单 URL 抓取失败）不会结束 Session，UI 应降级为警告。
      terminal: boolean;
    }
  | {
      type: "done";
      sessionId: string;
      status: Extract<ResearchSessionStatus, "completed" | "cancelled" | "failed">;
    };

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/// CRE 对所有 Consumer 的唯一入口（spec §7.2）。
/// 刻意收窄：不暴露任意 URL fetch、任意 Worker method、数据库句柄或本地路径。
export interface ResearchEngineFacade {
  create(request: ResearchRequest): Promise<ResearchSessionSummary>;
  /// 用同一批参数新建一个会话（终态会话的「重跑」）。返回新会话的 summary。
  ///
  /// 刻意是**克隆**而不是就地重置：终态在状态机里没有出口，理由见 session-status 的注释
  /// ——就地改写会让旧报告引用的证据凭空消失，而报告可能已被导出。
  rerun(sessionId: string): Promise<ResearchSessionSummary>;
  /// 复用已完成 Session 的原计划、覆盖度与证据重新撰写报告；成功后原子覆盖正文与引用。
  /// 不重新搜索、不改变 Session 状态，失败时旧报告保持不变。
  regenerateReport(sessionId: string): Promise<ResearchReport>;
  /// 启动一次编排。**返回 = 已启动，不等于已完成**：调用方不该 await 它来等研究结束
  /// （那会让整条 IPC 挂上几分钟，期间 renderer 拿不到会话、事件全被丢弃）。
  /// 进度与结束一律经 onEvent 观察；启动前就能判定的失败（未开启 / 搜索服务未配置）仍原样抛出。
  run(sessionId: string): Promise<void>;
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  get(sessionId: string, detail: ResearchDetailLevel): Promise<ResearchSessionView>;
  list(filter?: ResearchSessionFilter): Promise<ResearchSessionSummary[]>;
  delete(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Planner 与 Coverage（spec §10）
// ---------------------------------------------------------------------------

/// Gap Planner 的决策（spec §10.3）。它只看 Coverage、已执行查询统计和剩余预算，
/// **不接收完整网页正文、Memory 或本地文件**——这是 Prompt Injection 防线的一环。
export type PlannerDecision =
  | { action: "search_more"; reason: string; queries: PlannedQuery[] }
  | { action: "fetch_more"; reason: string; candidateIds: string[] }
  | { action: "finish"; reason: string };

/// 单个子问题的覆盖度评估（spec §10.2）。
/// 注意 independentDomainCount 的算法约束：同一重复簇只算一个独立来源，
/// 同组织的镜像域名可配置归入同一 authority group，避免「同一篇稿子转载十次」被当成十个来源。
export interface CoverageReport {
  subquestionId: string;
  status: "missing" | "weak" | "sufficient";
  sourceCount: number;
  independentDomainCount: number;
  primarySourceCount: number;
  contradictionCount: number;
  averageRelevance: number;
  /// 该子问题下相关性最高的若干 chunkId，供报告生成与 UI 定位。
  bestChunkIds: string[];
  /// 仍缺失的信息点描述，交给 Gap Planner 生成补充查询。
  missing: string[];
}

/// Consumer 允许的信任区约束在 ./consumer 的默认表里给出；此处重导出类型别名，
/// 让编排层只 import ./types 即可写出完整签名。
export type { TrustZone };
