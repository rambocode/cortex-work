// 工作流（loop）类型契约。
// 从 core/desktop/types.ts 拆出以遵守单文件 1200 行上限（与 plugin-types.ts、media-gen-types.ts 同款处理）。
// 使用方经 @cortex-work/core（barrel）或直接 import 本文件均可。
// ⚠️ 跨包契约：与 apps/desktop/src/main/workflow/types.ts 逐字镜像，两侧改动必须同步。
// schedule-trigger 的 schedule 字段复用 cortex-work 现有 ScheduleSpec（与 automation 段共用同一类型定义）。
// 不另起 Kun 的 WorkflowScheduleV1（含 interval/at/everyMinutes 等字段）；
// DSL 导入 interval/at 的兼容（Kun 特有 schedule kind）在 U15 处理。
//
// 注意：本文件不从 ./types 导入，以避免循环依赖（types.ts 通过 export * from "./workflow-types" 引本文件）。
// ScheduleSpec 在此内联定义，与 types.ts 中的定义保持字面一致。

// ScheduleSpec 内联定义（与 core/desktop/types.ts 的 ScheduleSpec 字面镜像；
// 不直接 import 以避免循环依赖，但二者必须保持逐字一致）。
// 不对外 export——消费方从 @cortex-work/core（桶）或 core/desktop/types 取 ScheduleSpec 即可。
type ScheduleSpec =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "cron"; expression: string }
  | { kind: "once"; at: number };

// ── 基础词汇表 ────────────────────────────────────────────────────────────────

/** 25 种节点 kind（权威清单）。判别联合的判别字段为 `type`（见 WorkflowNode）。 */
export type WorkflowNodeKind =
  | "manual-trigger"
  | "schedule-trigger"
  | "webhook-trigger"
  | "ai-agent"
  | "generate-image"
  | "condition"
  | "switch"
  | "filter"
  | "set-fields"
  | "code"
  | "sort"
  | "limit"
  | "aggregate"
  | "http-request"
  | "merge"
  | "subworkflow"
  | "loop"
  | "delay"
  | "template"
  | "json"
  | "output"
  | "parameter-extractor"
  | "question-classifier"
  | "human-approval"
  | "custom";

export const WORKFLOW_NODE_KINDS: readonly WorkflowNodeKind[] = [
  "manual-trigger",
  "schedule-trigger",
  "webhook-trigger",
  "ai-agent",
  "generate-image",
  "condition",
  "switch",
  "filter",
  "set-fields",
  "code",
  "sort",
  "limit",
  "aggregate",
  "http-request",
  "merge",
  "subworkflow",
  "loop",
  "delay",
  "template",
  "json",
  "output",
  "parameter-extractor",
  "question-classifier",
  "human-approval",
  "custom",
];

/** 工作流整体运行状态。 */
export type WorkflowRunStatus = "idle" | "running" | "success" | "error";

/** 单节点运行状态。 */
export type WorkflowNodeRunStatus = "pending" | "running" | "success" | "error" | "skipped";

/** 节点失败策略：停止/继续/fallback 值兜底。 */
export type WorkflowNodeErrorMode = "fail" | "continue" | "fallback";

/** condition/filter/switch 的 12 种比较运算符（对齐 Kun WorkflowConditionOperator）。 */
export type WorkflowConditionOperator =
  | "contains"
  | "notContains"
  | "equals"
  | "notEquals"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export type WorkflowHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type WorkflowWebhookMethod = "ANY" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const WORKFLOW_INPUT_FIELD_TYPES = [
  "text",
  "paragraph",
  "number",
  "boolean",
  "select",
  "json",
] as const;
export type WorkflowInputFieldType = (typeof WORKFLOW_INPUT_FIELD_TYPES)[number];

export const WORKFLOW_NODE_INPUT_TYPES = ["text", "number", "boolean", "json"] as const;
export type WorkflowNodeInputType = (typeof WORKFLOW_NODE_INPUT_TYPES)[number];

export const WORKFLOW_CODE_LANGUAGES = ["javascript", "python", "bash"] as const;
export type WorkflowCodeLanguage = (typeof WORKFLOW_CODE_LANGUAGES)[number];

export type WorkflowSortOrder = "asc" | "desc";
export type WorkflowLimitFrom = "first" | "last";
export type WorkflowAggregateMode = "count" | "sum" | "collect" | "join";
export type WorkflowMergeMode = "array" | "object";
export type WorkflowLoopMode = "condition" | "foreach";
export type WorkflowLoopExecution = "sequential" | "parallel";
export type WorkflowApprovalDecision = "approved" | "rejected";

// ── 共享子结构 ────────────────────────────────────────────────────────────────

/**
 * 触发工作流时调用方提供的一个类型化输入字段定义。
 * 驱动「立即运行」表单、/workflow/run 校验、以及 run 初始 payload.json 的 key。
 */
export interface WorkflowInputField {
  key: string;
  label: string;
  type: WorkflowInputFieldType;
  required: boolean;
  /** `select` 类型的选项列表。 */
  options: string[];
  defaultValue: string;
  description: string;
}

/**
 * 节点从上游节点输出中拉取的一个命名类型化输入（dify 风格）。
 * `source` 是表达式（如 {{$nodes.<id>.json.path}} / {{text}} / {{json.x}}）；
 * 解析后的值以 {{$input.key}} 暴露给节点。
 */
export interface WorkflowNodeInput {
  key: string;
  type: WorkflowNodeInputType;
  source: string;
}

/** HTTP Header 键值对。 */
export interface WorkflowHttpHeader {
  key: string;
  value: string;
}

/** set-fields 的一个字段赋值项。 */
export interface WorkflowField {
  key: string;
  /** 支持 {{json.x}} / {{text}} 插值。 */
  value: string;
}

/** switch 的一条规则；匹配时走 `case-<index>` 输出 handle。 */
export interface WorkflowSwitchRule {
  leftExpr: string;
  operator: WorkflowConditionOperator;
  rightValue: string;
  caseSensitive: boolean;
}

/** question-classifier 的一个分类类别。 */
export interface WorkflowClassifierCategory {
  id: string;
  label: string;
}

/** 工作流环境变量（{{$env.key}} 在节点表达式中可读）。 */
export interface WorkflowEnvVar {
  key: string;
  value: string;
  /** secret 类型运行时屏蔽明文；缺省 = 普通字符串。 */
  type?: "string" | "number" | "boolean" | "secret";
}

// ── 25 种节点 Config 类型 ────────────────────────────────────────────────────

export interface WorkflowManualTriggerConfig {
  workspaceRoot?: string;
  /** 启动工作流时调用方提供的类型化输入模式。 */
  inputSchema?: WorkflowInputField[];
}

/** 定时触发复用 cortex-work 现有 ScheduleSpec（daily/cron/once 等）。
 * 注意：Kun 原始 WorkflowScheduleV1 还有 interval/at 两种 kind，
 * 此处按 cortex ScheduleSpec 建模；DSL 导入 interval/at 的兼容在 U15 处理。 */
export interface WorkflowScheduleTriggerConfig {
  schedule: ScheduleSpec;
  workspaceRoot?: string;
}

export interface WorkflowWebhookTriggerConfig {
  /** Webhook 监听路径（带前导斜杠），默认 '/webhook'。 */
  path: string;
  method: WorkflowWebhookMethod;
  workspaceRoot?: string;
}

export interface WorkflowAiAgentConfig {
  prompt: string;
  workspaceRoot: string;
  providerId: string;
  model: string;
  /** 推理强度，对应 cortex ReasoningEffort 扩展档：'auto'|'off'|'low'|'medium'|'high'|'max'。 */
  reasoningEffort: "auto" | "off" | "low" | "medium" | "high" | "max";
  /** 运行模式：agent = 全自动执行；plan = 只读分析。 */
  mode: "agent" | "plan";
}

/** 图片生成节点配置。
 * 执行层（U13）消费 capabilities/media-gen 的 generateImage + resolveMediaGenSettings，
 * config 字段保持 Kun 形状不变。 */
export interface WorkflowGenerateImageConfig {
  prompt: string;
  providerId: string;
  model: string;
  size: string;
  /** 图片保存目录；空 = <workspace>/workflow-images。 */
  outputDir: string;
}

export interface WorkflowConditionConfig {
  leftExpr: string;
  operator: WorkflowConditionOperator;
  rightValue: string;
  /** 默认 false。 */
  caseSensitive: boolean;
}

export interface WorkflowSwitchConfig {
  rules: WorkflowSwitchRule[];
  /** true = 暴露 `fallback` 输出；默认 true。 */
  fallback: boolean;
}

export interface WorkflowFilterConfig {
  leftExpr: string;
  operator: WorkflowConditionOperator;
  rightValue: string;
  caseSensitive: boolean;
}

export interface WorkflowSetFieldsConfig {
  fields: WorkflowField[];
  keepIncoming: boolean;
  /** 'payload' 写节点输出；'run' 写运行级变量 {{$run.key}}；缺省 'payload'。 */
  scope?: "payload" | "run";
}

export interface WorkflowCodeConfig {
  /** 默认 'javascript'。 */
  language: WorkflowCodeLanguage;
  code: string;
}

export interface WorkflowSortConfig {
  field: string;
  order: WorkflowSortOrder;
  numeric: boolean;
}

export interface WorkflowLimitConfig {
  /** 1–100000，默认 10。 */
  count: number;
  from: WorkflowLimitFrom;
}

export interface WorkflowAggregateConfig {
  mode: WorkflowAggregateMode;
  field: string;
  separator: string;
}

export interface WorkflowHttpRequestConfig {
  method: WorkflowHttpMethod;
  url: string;
  /** 最多 50 条。 */
  headers: WorkflowHttpHeader[];
  body: string;
  /** 1000–600000ms，默认 30000。 */
  timeoutMs: number;
  parseJson: boolean;
}

export interface WorkflowMergeConfig {
  mode: WorkflowMergeMode;
}

export interface WorkflowSubWorkflowConfig {
  workflowId: string;
}

export interface WorkflowLoopConfig {
  workflowId: string;
  /** 'condition'（while 循环，默认）或 'foreach'（遍历数组）。 */
  mode?: WorkflowLoopMode;
  /** foreach：解析为要遍历数组的表达式；空 = 传入 payload.json。 */
  arraySource?: string;
  /** foreach：顺序或并行执行。 */
  execution?: WorkflowLoopExecution;
  /** foreach parallel 时最大并发数（1–8，默认 4）。 */
  concurrency?: number;
  /** foreach：失败项包装为 {error} 而非中断整个循环。 */
  continueOnError?: boolean;
  /** 迭代次数上限（1–100，默认 10）。 */
  maxIterations: number;
  /** condition 模式的停止条件。 */
  leftExpr: string;
  operator: WorkflowConditionOperator;
  rightValue: string;
  caseSensitive: boolean;
}

export interface WorkflowDelayConfig {
  /** 0–86400000ms，默认 1000。 */
  delayMs: number;
}

export interface WorkflowTemplateConfig {
  template: string;
  outputMode: "text" | "json";
}

export interface WorkflowJsonConfig {
  mode: "parse" | "stringify";
  strict: boolean;
}

export interface WorkflowOutputConfig {
  mode: "auto" | "text" | "json";
  textTemplate: string;
  jsonPath: string;
}

export interface WorkflowParameterExtractorConfig {
  source: string;
  instruction: string;
  fields: WorkflowInputField[];
  providerId: string;
  model: string;
  reasoningEffort: "auto" | "off" | "low" | "medium" | "high" | "max";
}

export interface WorkflowQuestionClassifierConfig {
  source: string;
  instruction: string;
  /** 最多 20 个分类。 */
  categories: WorkflowClassifierCategory[];
  providerId: string;
  model: string;
  reasoningEffort: "auto" | "off" | "low" | "medium" | "high" | "max";
}

export interface WorkflowHumanApprovalConfig {
  title: string;
  instruction: string;
  /** 0 = 无限等待；最大 86400000ms。 */
  timeoutMs: number;
  onTimeout: WorkflowApprovalDecision;
}

export interface WorkflowCustomConfig {
  moduleId: string;
  values: Record<string, string>;
}

// ── 自定义模块定义 ────────────────────────────────────────────────────────────
// （与 apps/desktop/src/main/workflow/types.ts 逐字镜像，修改时必须同步）

/** 模块字段声明（与 Kun WorkflowModuleFieldV1 保持语义对齐）。 */
export interface WorkflowModuleField {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "boolean" | "select";
  defaultValue: string;
  options: string[];
  placeholder: string;
}

/** 自定义脚本模块定义（custom 节点的底层，存于工作流内嵌数组）。 */
export interface WorkflowCustomModule {
  id: string;
  name: string;
  description: string;
  /** 保留字段，供未来图标选择器使用；空字符串使用通用图标。 */
  icon: string;
  language: WorkflowCodeLanguage;
  fields: WorkflowModuleField[];
  code: string;
}

// ── 节点 config 按 kind 索引（供类型安全访问）────────────────────────────────

export interface WorkflowNodeConfigByKind {
  "manual-trigger": WorkflowManualTriggerConfig;
  "schedule-trigger": WorkflowScheduleTriggerConfig;
  "webhook-trigger": WorkflowWebhookTriggerConfig;
  "ai-agent": WorkflowAiAgentConfig;
  "generate-image": WorkflowGenerateImageConfig;
  condition: WorkflowConditionConfig;
  switch: WorkflowSwitchConfig;
  filter: WorkflowFilterConfig;
  "set-fields": WorkflowSetFieldsConfig;
  code: WorkflowCodeConfig;
  sort: WorkflowSortConfig;
  limit: WorkflowLimitConfig;
  aggregate: WorkflowAggregateConfig;
  "http-request": WorkflowHttpRequestConfig;
  merge: WorkflowMergeConfig;
  subworkflow: WorkflowSubWorkflowConfig;
  loop: WorkflowLoopConfig;
  delay: WorkflowDelayConfig;
  template: WorkflowTemplateConfig;
  json: WorkflowJsonConfig;
  output: WorkflowOutputConfig;
  "parameter-extractor": WorkflowParameterExtractorConfig;
  "question-classifier": WorkflowQuestionClassifierConfig;
  "human-approval": WorkflowHumanApprovalConfig;
  custom: WorkflowCustomConfig;
}

// ── 节点（discriminated union，判别字段 `type`）────────────────────────────────

/**
 * 工作流节点判别联合。`type` 是判别字段，每个 kind 携带自己的 `config`。
 * 画布坐标 `position` 对主进程执行引擎透明（仅渲染层关心）。
 */
export type WorkflowNode = {
  [K in WorkflowNodeKind]: {
    id: string;
    /** 判别字段：节点种类。 */
    type: K;
    /** 画布展示标签。 */
    name: string;
    /** React Flow 画布坐标；后端执行引擎忽略。 */
    position: { x: number; y: number };
    disabled: boolean;
    /** 失败策略：缺省 = 'fail'（运行终止）。 */
    onError?: WorkflowNodeErrorMode;
    /** 失败后重试次数（0 = 不重试）。 */
    retries?: number;
    retryDelayMs?: number;
    /** onError='fallback' 时节点发出的兜底 JSON。 */
    fallbackJson?: string;
    /** 从上游节点输出拉取的命名类型化输入；解析为 {{$input.key}}。 */
    inputs?: WorkflowNodeInput[];
    config: WorkflowNodeConfigByKind[K];
  };
}[WorkflowNodeKind];

// ── 连接（边）────────────────────────────────────────────────────────────────

/** 节点间的有向边；直接绑定 React Flow。condition 的 sourceHandle 为 'true' | 'false'。 */
export interface WorkflowConnection {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

// ── 运行历史 ──────────────────────────────────────────────────────────────────

/** 单个节点的执行结果快照。 */
export interface WorkflowNodeRunResult {
  nodeId: string;
  status: WorkflowNodeRunStatus;
  /** ISO 8601 字符串（epoch ms 在执行层转换，持久化存 ISO 字符串与 Kun 对齐）。 */
  startedAt: string;
  finishedAt: string;
  /** 助手文本 / HTTP body / 条件分支摘要。 */
  message: string;
  /** 节点发出的 JSON payload（序列化）。 */
  outputJson: string;
  /** 节点接收的 JSON payload（序列化，供运行历史查看器）。 */
  inputJson?: string;
  retries?: number;
  /** ai-agent 节点：对应的 CLI 会话 id（cortex 侧）。 */
  threadId: string;
  error: string;
}

/** 一次工作流执行记录。 */
export interface WorkflowRun {
  id: string;
  /** 'manual' | 'schedule' | 触发器节点 id。 */
  trigger: string;
  status: WorkflowRunStatus;
  startedAt: string;
  finishedAt: string;
  message: string;
  nodeResults: WorkflowNodeRunResult[];
}

// ── 工作流顶层定义 ────────────────────────────────────────────────────────────

/**
 * 一个工作流的完整定义（画布 + 持久化元数据 + 运行历史）。
 * 最近 N 条运行历史随定义落盘（每条 output 已在执行层截断，磁盘占用可控）。
 */
export interface WorkflowDef {
  id: string;
  name: string;
  enabled: boolean;
  /** true = AI 可通过 MCP 工具调用本工作流（list_workflows / run_workflow）。 */
  callableByAgent: boolean;
  /** 工作流级环境变量，节点表达式中经 {{$env.key}} 读取。 */
  env: WorkflowEnvVar[];
  /** 工作流内嵌自定义模块（custom 节点的底层脚本，存于工作流内，不跨工作流共享）。 */
  modules?: WorkflowCustomModule[];
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  createdAt: string;
  updatedAt: string;
  lastRunAt: string;
  nextRunAt: string;
  lastStatus: WorkflowRunStatus;
  lastMessage: string;
  /** 最近若干次运行历史（最旧在前，按 MAX_WORKFLOW_RUNS 截断）。 */
  runs: WorkflowRun[];
}

// ── 事件（主进程 → 渲染层）────────────────────────────────────────────────────

/** 工作流运行阶段推送事件（对齐 AutomationRunEvent 结构）。 */
export interface WorkflowRunEvent {
  workflowId: string;
  run: WorkflowRun;
  phase: "start" | "end";
}
