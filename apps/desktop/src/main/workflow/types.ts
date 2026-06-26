// 主进程侧工作流类型。
// ⚠️ 跨包镜像契约（KTD5）：本文件与 packages/core/desktop/workflow-types.ts 保持逐字镜像。
// 原因：core 包不能依赖 app 包（包硬边界），故主进程不能直接 import @cortex-work/core；
// 这与 automation 类型（AutomationMeta/AutomationRun 在 ipc/types.ts 镜像）现状一致。
// 修改任一侧时必须同步更新另一侧，否则 preload 编译通过但运行期字段错位。
//
// 主进程模块统一从本文件或 ../ipc/types 导入工作流类型（后者通过 export * 再导出本文件）。

// ScheduleSpec 内联（与 ipc/types.ts 中定义字面一致；
// 不直接 import 以避免 ipc/types.ts → workflow/types.ts 的循环导入）。
type ScheduleSpec =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "cron"; expression: string }
  | { kind: "once"; at: number };

// ── 基础词汇表 ────────────────────────────────────────────────────────────────

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
  | "custom"
  // 便签：画布注释节点，不参与连接与执行（详见 WorkflowStickyNoteConfig）。
  | "sticky-note";

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
  "sticky-note",
];

export type WorkflowRunStatus = "idle" | "running" | "success" | "error";
export type WorkflowNodeRunStatus = "pending" | "running" | "success" | "error" | "skipped";
export type WorkflowNodeErrorMode = "fail" | "continue" | "fallback";

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

export interface WorkflowInputField {
  key: string;
  label: string;
  type: WorkflowInputFieldType;
  required: boolean;
  options: string[];
  defaultValue: string;
  description: string;
}

export interface WorkflowNodeInput {
  key: string;
  type: WorkflowNodeInputType;
  source: string;
}

export interface WorkflowHttpHeader {
  key: string;
  value: string;
}

export interface WorkflowField {
  key: string;
  value: string;
}

export interface WorkflowSwitchRule {
  leftExpr: string;
  operator: WorkflowConditionOperator;
  rightValue: string;
  caseSensitive: boolean;
}

export interface WorkflowClassifierCategory {
  id: string;
  label: string;
}

export interface WorkflowEnvVar {
  key: string;
  value: string;
  type?: "string" | "number" | "boolean" | "secret";
}

// ── 25 种节点 Config 类型 ────────────────────────────────────────────────────

export interface WorkflowManualTriggerConfig {
  workspaceRoot?: string;
  inputSchema?: WorkflowInputField[];
  /**
   * 本地 API 触发令牌（P3）。normalizeWorkflow 自动生成 UUID；
   * webhook-server 的 POST /workflow/run 用 timingSafeEqual 校验
   * Authorization: Bearer <runToken>，防止同机任意进程触发手动工作流。
   */
  runToken?: string;
}

export interface WorkflowScheduleTriggerConfig {
  schedule: ScheduleSpec;
  workspaceRoot?: string;
}

export interface WorkflowWebhookTriggerConfig {
  path: string;
  method: WorkflowWebhookMethod;
  workspaceRoot?: string;
  /**
   * 身份验证 token（P2 Fix-12）。normalizeWorkflow 自动生成 UUID；
   * webhook-server 用 timingSafeEqual 校验 Authorization: Bearer <token>。
   */
  webhookToken?: string;
}

export interface WorkflowAiAgentConfig {
  prompt: string;
  workspaceRoot: string;
  providerId: string;
  model: string;
  reasoningEffort: "auto" | "off" | "low" | "medium" | "high" | "max";
  mode: "agent" | "plan";
}

export interface WorkflowGenerateImageConfig {
  prompt: string;
  providerId: string;
  model: string;
  size: string;
  outputDir: string;
}

export interface WorkflowConditionConfig {
  leftExpr: string;
  operator: WorkflowConditionOperator;
  rightValue: string;
  caseSensitive: boolean;
}

export interface WorkflowSwitchConfig {
  rules: WorkflowSwitchRule[];
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
  scope?: "payload" | "run";
}

export interface WorkflowCodeConfig {
  language: WorkflowCodeLanguage;
  code: string;
}

export interface WorkflowSortConfig {
  field: string;
  order: WorkflowSortOrder;
  numeric: boolean;
}

export interface WorkflowLimitConfig {
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
  headers: WorkflowHttpHeader[];
  body: string;
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
  mode?: WorkflowLoopMode;
  arraySource?: string;
  execution?: WorkflowLoopExecution;
  concurrency?: number;
  continueOnError?: boolean;
  maxIterations: number;
  leftExpr: string;
  operator: WorkflowConditionOperator;
  rightValue: string;
  caseSensitive: boolean;
}

export interface WorkflowDelayConfig {
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
  categories: WorkflowClassifierCategory[];
  providerId: string;
  model: string;
  reasoningEffort: "auto" | "off" | "low" | "medium" | "high" | "max";
}

export interface WorkflowHumanApprovalConfig {
  title: string;
  instruction: string;
  timeoutMs: number;
  onTimeout: WorkflowApprovalDecision;
}

export interface WorkflowCustomConfig {
  moduleId: string;
  values: Record<string, string>;
}

/**
 * 便签（sticky note）节点配置：画布上的彩色注释卡片。
 * 不参与连接/执行——执行引擎遍历不到它（无连接、不入 readyQueue），
 * 仅在画布渲染与持久化。content 按 Markdown 渲染。
 * （与 packages/core/desktop/workflow-types.ts 逐字镜像，修改时必须同步。）
 */
export interface WorkflowStickyNoteConfig {
  /** 便签正文（Markdown 源文本）。 */
  content: string;
  /** 背景色（取自 STICKY_NOTE_COLORS 预设，存十六进制值）。 */
  color: string;
  /** 卡片宽度（px）。 */
  width: number;
  /** 卡片高度（px）。 */
  height: number;
}

// ── 自定义模块定义 ────────────────────────────────────────────────────────────
// （与 node-executors/modules.ts 的 WorkflowCustomModule 语义对齐，此处是契约层定义）

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

// ── 节点 config 按 kind 索引 ──────────────────────────────────────────────────

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
  "sticky-note": WorkflowStickyNoteConfig;
}

// ── 节点（discriminated union，判别字段 `type`）────────────────────────────────

export type WorkflowNode = {
  [K in WorkflowNodeKind]: {
    id: string;
    type: K;
    name: string;
    position: { x: number; y: number };
    disabled: boolean;
    onError?: WorkflowNodeErrorMode;
    retries?: number;
    retryDelayMs?: number;
    fallbackJson?: string;
    inputs?: WorkflowNodeInput[];
    config: WorkflowNodeConfigByKind[K];
  };
}[WorkflowNodeKind];

// ── 连接（边）────────────────────────────────────────────────────────────────

export interface WorkflowConnection {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

// ── 运行历史 ──────────────────────────────────────────────────────────────────

export interface WorkflowNodeRunResult {
  nodeId: string;
  status: WorkflowNodeRunStatus;
  startedAt: string;
  finishedAt: string;
  message: string;
  outputJson: string;
  inputJson?: string;
  retries?: number;
  threadId: string;
  error: string;
}

export interface WorkflowRun {
  id: string;
  trigger: string;
  status: WorkflowRunStatus;
  startedAt: string;
  finishedAt: string;
  message: string;
  nodeResults: WorkflowNodeRunResult[];
}

// ── 工作流顶层定义 ────────────────────────────────────────────────────────────

export interface WorkflowDef {
  id: string;
  name: string;
  enabled: boolean;
  callableByAgent: boolean;
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
  runs: WorkflowRun[];
}

// ── 事件（主进程 → 渲染层）────────────────────────────────────────────────────

/**
 * human-approval 节点进入 pending 时广播的待审批信息。
 * P0 Fix-1：与 core/desktop/workflow-types.ts 逐字镜像，修改须同步。
 */
export interface WorkflowPendingApproval {
  token: string;
  nodeId: string;
  nodeName: string;
  title: string;
  instruction: string;
}

export interface WorkflowRunEvent {
  workflowId: string;
  run: WorkflowRun;
  phase: "start" | "update" | "end" | "pending-approval";
  /** phase='pending-approval' 时携带，供 UI 展示审批卡。 */
  pendingApproval?: WorkflowPendingApproval;
}
