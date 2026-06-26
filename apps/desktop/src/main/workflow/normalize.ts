// 工作流配置规范化器：负责将磁盘/DSL 读入的原始 JSON 归一为合法的 WorkflowDef。
// 复刻 Kun src/shared/app-settings-workflow.ts 的 normalizeWorkflow / normalizeWorkflowNode，
// 但调度字段替换为 cortex ScheduleSpec（非 Kun WorkflowScheduleV1）。
// 契约：任何输入（包括未知 kind、损坏节点、越界值）都安全处理——不抛出，返回合法默认值。

import { randomUUID } from 'crypto'

import type {
  WorkflowClassifierCategory,
  WorkflowConditionOperator,
  WorkflowConnection,
  WorkflowCustomModule,
  WorkflowDef,
  WorkflowEnvVar,
  WorkflowField,
  WorkflowHttpHeader,
  WorkflowHttpMethod,
  WorkflowInputField,
  WorkflowInputFieldType,
  WorkflowModuleField,
  WorkflowNode,
  WorkflowNodeInput,
  WorkflowNodeInputType,
  WorkflowNodeKind,
  WorkflowNodeRunResult,
  WorkflowNodeRunStatus,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowSwitchRule,
  WorkflowWebhookMethod,
} from "./types";
import {
  WORKFLOW_INPUT_FIELD_TYPES,
  WORKFLOW_NODE_INPUT_TYPES,
  WORKFLOW_NODE_KINDS,
} from "./types";

// 最多保留的运行历史条数（与 Kun MAX_WORKFLOW_RUNS 对齐）。
export const MAX_WORKFLOW_RUNS = 20;
const MAX_WORKFLOW_CONNECTIONS = 512;
const MAX_WORKFLOW_HTTP_HEADERS = 50;
const MAX_SWITCH_RULES = 20;
const MAX_CLASSIFIER_CATEGORIES = 20;
const MAX_ENV_VARS = 100;
const MAX_NODE_INPUTS = 30;
const MAX_INPUT_SCHEMA = 50;

// ── 辅助：类型守护与强制转换 ──────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asTrimmed(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 将值钳制在 [min, max] 范围内，若不合法则返回 fallback。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < min || n > max) return fallback;
  return n;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

// ── 子结构规范化 ──────────────────────────────────────────────────────────────

const CONDITION_OPERATORS: readonly WorkflowConditionOperator[] = [
  "contains",
  "notContains",
  "equals",
  "notEquals",
  "startsWith",
  "endsWith",
  "isEmpty",
  "isNotEmpty",
  "gt",
  "gte",
  "lt",
  "lte",
];

const HTTP_METHODS: readonly WorkflowHttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function normalizeConditionOperator(value: unknown): WorkflowConditionOperator {
  return CONDITION_OPERATORS.includes(value as WorkflowConditionOperator)
    ? (value as WorkflowConditionOperator)
    : "contains";
}

function normalizeHttpMethod(value: unknown): WorkflowHttpMethod {
  return HTTP_METHODS.includes(value as WorkflowHttpMethod)
    ? (value as WorkflowHttpMethod)
    : "GET";
}

function normalizeWebhookMethod(value: unknown): WorkflowWebhookMethod {
  const WEBHOOK_METHODS: WorkflowWebhookMethod[] = [
    "ANY",
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
  ];
  return WEBHOOK_METHODS.includes(value as WorkflowWebhookMethod)
    ? (value as WorkflowWebhookMethod)
    : "ANY";
}

function normalizeWebhookPath(value: unknown): string {
  const raw = asTrimmed(value);
  if (!raw) return "/webhook";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeReasoningEffort(value: unknown): "auto" | "off" | "low" | "medium" | "high" | "max" {
  const EFFORTS = ["auto", "off", "low", "medium", "high", "max"] as const;
  return EFFORTS.includes(value as "auto") ? (value as (typeof EFFORTS)[number]) : "auto";
}

/** 规范化 ScheduleSpec（cortex 定时规则，非 Kun WorkflowScheduleV1）。
 *  schedule-trigger 的 schedule 字段使用 cortex-work 现有 ScheduleSpec 枚举种类。
 *  Kun 的 interval/at kind 在 DSL 导入兼容层（U15）处理，此处安全降级为 cron（空表达式）。 */
function normalizeScheduleSpec(
  value: unknown,
): import("./types").WorkflowScheduleTriggerConfig["schedule"] {
  const s = record(value);
  const kind = s.kind;
  if (kind === "hourly") {
    return { kind: "hourly", minute: clampInt(s.minute, 0, 0, 59) };
  }
  if (kind === "daily") {
    return {
      kind: "daily",
      hour: clampInt(s.hour, 9, 0, 23),
      minute: clampInt(s.minute, 0, 0, 59),
    };
  }
  if (kind === "weekdays") {
    return {
      kind: "weekdays",
      hour: clampInt(s.hour, 9, 0, 23),
      minute: clampInt(s.minute, 0, 0, 59),
    };
  }
  if (kind === "weekly") {
    return {
      kind: "weekly",
      weekday: clampInt(s.weekday, 1, 0, 6),
      hour: clampInt(s.hour, 9, 0, 23),
      minute: clampInt(s.minute, 0, 0, 59),
    };
  }
  if (kind === "once") {
    return {
      kind: "once",
      at: typeof s.at === "number" && s.at > 0 ? Math.floor(s.at) : Date.now(),
    };
  }
  // cron + Kun interval/at 降级（U15 再做完整兼容）。
  return { kind: "cron", expression: asTrimmed(s.expression) || asTrimmed(s.cron) };
}

function normalizePosition(value: unknown): { x: number; y: number } {
  const p = record(value);
  const x = typeof p.x === "number" && Number.isFinite(p.x) ? p.x : 0;
  const y = typeof p.y === "number" && Number.isFinite(p.y) ? p.y : 0;
  return { x, y };
}

function normalizeHttpHeaders(value: unknown): WorkflowHttpHeader[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const r = record(entry);
      return { key: asTrimmed(r.key), value: asText(r.value) };
    })
    .filter((h) => h.key.length > 0)
    .slice(0, MAX_WORKFLOW_HTTP_HEADERS);
}

function normalizeFields(value: unknown): WorkflowField[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const r = record(entry);
      return { key: asTrimmed(r.key), value: asText(r.value) };
    })
    .filter((f) => f.key.length > 0)
    .slice(0, MAX_WORKFLOW_HTTP_HEADERS);
}

function normalizeSwitchRules(value: unknown): WorkflowSwitchRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const r = record(entry);
      return {
        leftExpr: asText(r.leftExpr),
        operator: normalizeConditionOperator(r.operator),
        rightValue: asText(r.rightValue),
        caseSensitive: normalizeBoolean(r.caseSensitive, false),
      };
    })
    .slice(0, MAX_SWITCH_RULES);
}

function normalizeClassifierCategories(value: unknown): WorkflowClassifierCategory[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index): WorkflowClassifierCategory => {
      const c = record(entry);
      return {
        id: asTrimmed(c.id) || `cat-${index + 1}`,
        label: asTrimmed(c.label),
      };
    })
    .slice(0, MAX_CLASSIFIER_CATEGORIES);
}

function normalizeEnvVars(value: unknown): WorkflowEnvVar[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): WorkflowEnvVar => {
      const e = record(entry);
      const type = e.type;
      return {
        key: asTrimmed(e.key),
        value: asText(e.value),
        type:
          type === "number" || type === "boolean" || type === "secret" ? type : "string",
      };
    })
    .filter((e) => e.key.length > 0)
    .slice(0, MAX_ENV_VARS);
}

// ── 自定义模块规范化 ──────────────────────────────────────────────────────────

const MAX_MODULES = 50;
const MAX_MODULE_FIELDS = 30;
const MODULE_FIELD_TYPES = ["text", "textarea", "number", "boolean", "select"] as const;

function normalizeModuleField(value: unknown): WorkflowModuleField | null {
  const f = record(value);
  const key = asTrimmed(f.key);
  if (!key) return null;
  const type = MODULE_FIELD_TYPES.includes(f.type as (typeof MODULE_FIELD_TYPES)[number])
    ? (f.type as WorkflowModuleField["type"])
    : "text";
  return {
    key,
    label: asTrimmed(f.label) || key,
    type,
    defaultValue: asText(f.defaultValue),
    options: Array.isArray(f.options) ? f.options.map((o) => asText(o)).filter(Boolean) : [],
    placeholder: asText(f.placeholder),
  };
}

function normalizeModules(value: unknown): WorkflowCustomModule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .map((entry): WorkflowCustomModule | null => {
      const m = record(entry);
      const id = asTrimmed(m.id);
      if (!id) return null;
      const language = (["javascript", "python", "bash"] as const).includes(
        m.language as "javascript",
      )
        ? (m.language as WorkflowCustomModule["language"])
        : "javascript";
      return {
        id,
        name: asTrimmed(m.name) || id,
        description: asText(m.description),
        icon: asText(m.icon),
        language,
        fields: Array.isArray(m.fields)
          ? m.fields
              .map(normalizeModuleField)
              .filter((f): f is WorkflowModuleField => f !== null)
              .slice(0, MAX_MODULE_FIELDS)
          : [],
        code: asText(m.code),
      };
    })
    .filter((m): m is WorkflowCustomModule => m !== null)
    .slice(0, MAX_MODULES);
  return result.length > 0 ? result : undefined;
}

/** 规范化触发工作流时调用方提供的输入模式。 */
export function normalizeWorkflowInputSchema(value: unknown): WorkflowInputField[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): WorkflowInputField => {
      const f = record(entry);
      const type = f.type;
      return {
        key: asTrimmed(f.key),
        label: asTrimmed(f.label),
        type: WORKFLOW_INPUT_FIELD_TYPES.includes(type as WorkflowInputFieldType)
          ? (type as WorkflowInputFieldType)
          : "text",
        required: normalizeBoolean(f.required, false),
        options: Array.isArray(f.options)
          ? f.options
              .map((o) => asTrimmed(o))
              .filter((o) => o.length > 0)
              .slice(0, 50)
          : [],
        defaultValue: asText(f.defaultValue),
        description: asText(f.description),
      };
    })
    .filter((f) => f.key.length > 0)
    .slice(0, MAX_INPUT_SCHEMA);
}

/** 规范化节点的命名类型化输入（{{$input.key}} 绑定）。 */
function normalizeNodeInputs(value: unknown): WorkflowNodeInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const inputs = value
    .map((entry): WorkflowNodeInput => {
      const e = record(entry);
      const type = WORKFLOW_NODE_INPUT_TYPES.includes(e.type as WorkflowNodeInputType)
        ? (e.type as WorkflowNodeInputType)
        : "text";
      return { key: asTrimmed(e.key), type, source: asText(e.source) };
    })
    .filter((input) => input.key.length > 0)
    .slice(0, MAX_NODE_INPUTS);
  return inputs.length ? inputs : undefined;
}

/** 规范化节点的错误策略字段（onError/retries/retryDelayMs/fallbackJson）。 */
function normalizeNodeErrorFields(n: Record<string, unknown>): {
  onError?: "continue" | "fallback";
  retries?: number;
  retryDelayMs?: number;
  fallbackJson?: string;
} {
  const out: {
    onError?: "continue" | "fallback";
    retries?: number;
    retryDelayMs?: number;
    fallbackJson?: string;
  } = {};
  if (n.onError === "continue" || n.onError === "fallback") out.onError = n.onError;
  const retries = clampInt(n.retries, 0, 0, 10);
  if (retries > 0) out.retries = retries;
  const delay = clampInt(n.retryDelayMs, 0, 0, 600_000);
  if (delay > 0) out.retryDelayMs = delay;
  const fallback = asText(n.fallbackJson);
  if (fallback) out.fallbackJson = fallback;
  return out;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(record(value))) {
    if (count >= 100) break;
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;
    out[trimmedKey] =
      typeof raw === "string" ? raw : raw == null ? "" : String(raw);
    count += 1;
  }
  return out;
}

// ── 节点规范化（核心 switch）────────────────────────────────────────────────────

/**
 * 规范化一个节点原始对象为 WorkflowNode。
 * 若 type 未知或 value 损坏，返回 null（调用方过滤掉，不抛）。
 */
export function normalizeWorkflowNode(value: unknown, index: number): WorkflowNode | null {
  const n = record(value);
  const type = n.type;
  if (
    typeof type !== "string" ||
    !WORKFLOW_NODE_KINDS.includes(type as WorkflowNodeKind)
  ) {
    return null;
  }
  const kind = type as WorkflowNodeKind;
  const nodeInputs = normalizeNodeInputs(n.inputs);
  const base = {
    id: asTrimmed(n.id) || `node-${index + 1}`,
    name: asTrimmed(n.name),
    position: normalizePosition(n.position),
    disabled: normalizeBoolean(n.disabled, false),
    ...normalizeNodeErrorFields(n),
    ...(nodeInputs ? { inputs: nodeInputs } : {}),
  };
  const config = record(n.config);

  switch (kind) {
    case "manual-trigger": {
      const manualConfig: import("./types").WorkflowManualTriggerConfig = {
        workspaceRoot: asTrimmed(config.workspaceRoot),
        // 无 token 时自动生成，使 POST /workflow/run 鉴权始终可用（镜像 webhookToken）。
        // 已有 token（从磁盘加载）原样保留。
        runToken:
          typeof config.runToken === "string" && config.runToken
            ? config.runToken
            : randomUUID(),
      };
      const inputSchema = normalizeWorkflowInputSchema(config.inputSchema);
      if (inputSchema.length) manualConfig.inputSchema = inputSchema;
      return { ...base, type: "manual-trigger", config: manualConfig };
    }
    case "schedule-trigger":
      return {
        ...base,
        type: "schedule-trigger",
        config: {
          schedule: normalizeScheduleSpec(config.schedule),
          workspaceRoot: asTrimmed(config.workspaceRoot),
        },
      };
    case "webhook-trigger":
      return {
        ...base,
        type: "webhook-trigger",
        config: {
          path: normalizeWebhookPath(config.path),
          method: normalizeWebhookMethod(config.method),
          workspaceRoot: asTrimmed(config.workspaceRoot),
          // P2 Fix-12：无 token 时自动生成，防止未鉴权的任意 POST 触发工作流。
          // 已有 token（从磁盘加载）原样保留；新建工作流分配一个随机 UUID。
          webhookToken: typeof config.webhookToken === 'string' && config.webhookToken
            ? config.webhookToken
            : randomUUID(),
        },
      };
    case "ai-agent":
      return {
        ...base,
        type: "ai-agent",
        config: {
          prompt: asText(config.prompt),
          workspaceRoot: asTrimmed(config.workspaceRoot),
          providerId: asTrimmed(config.providerId),
          model: asTrimmed(config.model),
          reasoningEffort: normalizeReasoningEffort(config.reasoningEffort),
          mode: config.mode === "plan" ? "plan" : "agent",
        },
      };
    case "generate-image":
      return {
        ...base,
        type: "generate-image",
        config: {
          prompt: asText(config.prompt),
          providerId: asTrimmed(config.providerId),
          model: asTrimmed(config.model),
          size: asTrimmed(config.size),
          outputDir: asTrimmed(config.outputDir),
        },
      };
    case "condition":
      return {
        ...base,
        type: "condition",
        config: {
          leftExpr: asText(config.leftExpr),
          operator: normalizeConditionOperator(config.operator),
          rightValue: asText(config.rightValue),
          caseSensitive: normalizeBoolean(config.caseSensitive, false),
        },
      };
    case "switch":
      return {
        ...base,
        type: "switch",
        config: {
          rules: normalizeSwitchRules(config.rules),
          fallback: normalizeBoolean(config.fallback, true),
        },
      };
    case "filter":
      return {
        ...base,
        type: "filter",
        config: {
          leftExpr: asText(config.leftExpr),
          operator: normalizeConditionOperator(config.operator),
          rightValue: asText(config.rightValue),
          caseSensitive: normalizeBoolean(config.caseSensitive, false),
        },
      };
    case "set-fields":
      return {
        ...base,
        type: "set-fields",
        config: {
          fields: normalizeFields(config.fields),
          keepIncoming: normalizeBoolean(config.keepIncoming, false),
          scope: config.scope === "run" ? "run" : "payload",
        },
      };
    case "code":
      return {
        ...base,
        type: "code",
        config: {
          language:
            config.language === "python" || config.language === "bash"
              ? config.language
              : "javascript",
          code: asText(config.code),
        },
      };
    case "sort":
      return {
        ...base,
        type: "sort",
        config: {
          field: asTrimmed(config.field),
          order: config.order === "desc" ? "desc" : "asc",
          numeric: normalizeBoolean(config.numeric, false),
        },
      };
    case "limit":
      return {
        ...base,
        type: "limit",
        config: {
          count: clampInt(config.count, 10, 1, 100_000),
          from: config.from === "last" ? "last" : "first",
        },
      };
    case "aggregate":
      return {
        ...base,
        type: "aggregate",
        config: {
          mode:
            config.mode === "sum" ||
            config.mode === "collect" ||
            config.mode === "join"
              ? config.mode
              : "count",
          field: asTrimmed(config.field),
          separator: asText(config.separator),
        },
      };
    case "http-request":
      return {
        ...base,
        type: "http-request",
        config: {
          method: normalizeHttpMethod(config.method),
          url: asTrimmed(config.url),
          headers: normalizeHttpHeaders(config.headers),
          body: asText(config.body),
          timeoutMs: clampInt(config.timeoutMs, 30_000, 1_000, 600_000),
          parseJson: normalizeBoolean(config.parseJson, false),
        },
      };
    case "merge":
      return {
        ...base,
        type: "merge",
        config: { mode: config.mode === "object" ? "object" : "array" },
      };
    case "subworkflow":
      return {
        ...base,
        type: "subworkflow",
        config: { workflowId: asTrimmed(config.workflowId) },
      };
    case "loop":
      return {
        ...base,
        type: "loop",
        config: {
          workflowId: asTrimmed(config.workflowId),
          mode: config.mode === "foreach" ? "foreach" : "condition",
          arraySource: asText(config.arraySource),
          execution: config.execution === "parallel" ? "parallel" : "sequential",
          concurrency: clampInt(config.concurrency, 4, 1, 8),
          continueOnError: normalizeBoolean(config.continueOnError, false),
          maxIterations: clampInt(config.maxIterations, 10, 1, 100),
          leftExpr: asText(config.leftExpr),
          operator: normalizeConditionOperator(config.operator),
          rightValue: asText(config.rightValue),
          caseSensitive: normalizeBoolean(config.caseSensitive, false),
        },
      };
    case "delay":
      return {
        ...base,
        type: "delay",
        config: { delayMs: clampInt(config.delayMs, 1_000, 0, 86_400_000) },
      };
    case "template":
      return {
        ...base,
        type: "template",
        config: {
          template: asText(config.template),
          outputMode: config.outputMode === "json" ? "json" : "text",
        },
      };
    case "json":
      return {
        ...base,
        type: "json",
        config: {
          mode: config.mode === "stringify" ? "stringify" : "parse",
          strict: normalizeBoolean(config.strict, false),
        },
      };
    case "output":
      return {
        ...base,
        type: "output",
        config: {
          mode:
            config.mode === "text" || config.mode === "json" ? config.mode : "auto",
          textTemplate: asText(config.textTemplate),
          jsonPath: asTrimmed(config.jsonPath),
        },
      };
    case "parameter-extractor":
      return {
        ...base,
        type: "parameter-extractor",
        config: {
          source: asText(config.source),
          instruction: asText(config.instruction),
          fields: normalizeWorkflowInputSchema(config.fields),
          providerId: asTrimmed(config.providerId),
          model: asTrimmed(config.model),
          reasoningEffort: normalizeReasoningEffort(config.reasoningEffort),
        },
      };
    case "question-classifier":
      return {
        ...base,
        type: "question-classifier",
        config: {
          source: asText(config.source),
          instruction: asText(config.instruction),
          categories: normalizeClassifierCategories(config.categories),
          providerId: asTrimmed(config.providerId),
          model: asTrimmed(config.model),
          reasoningEffort: normalizeReasoningEffort(config.reasoningEffort),
        },
      };
    case "human-approval":
      return {
        ...base,
        type: "human-approval",
        config: {
          title: asText(config.title),
          instruction: asText(config.instruction),
          timeoutMs: clampInt(config.timeoutMs, 0, 0, 86_400_000),
          onTimeout: config.onTimeout === "approved" ? "approved" : "rejected",
        },
      };
    case "custom":
      return {
        ...base,
        type: "custom",
        config: {
          moduleId: asTrimmed(config.moduleId),
          values: normalizeStringRecord(config.values),
        },
      };
    case "sticky-note":
      // 便签：容错读取注释内容/颜色/尺寸。默认值与渲染层
      // packages/views/cortex-desktop/personal/workflow-sticky.ts 对齐（主进程为 core 镜像、
      // 不 import 渲染层，故此处内联，改默认时两侧同步）。
      return {
        ...base,
        type: "sticky-note",
        config: {
          content: asText(config.content),
          color:
            typeof config.color === "string" &&
            /^#[0-9a-fA-F]{3,8}$/.test(config.color)
              ? config.color
              : "#fde7ea",
          width: clampInt(config.width, 240, 120, 4_000),
          height: clampInt(config.height, 160, 80, 4_000),
        },
      };
    default:
      // TypeScript exhaustive check — 运行时不会进到这里
      return null;
  }
}

// ── 边（connection）规范化 ────────────────────────────────────────────────────

function normalizeConnections(
  value: unknown,
  nodeIds: Set<string>,
): WorkflowConnection[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: WorkflowConnection[] = [];
  value.forEach((entry, index) => {
    const r = record(entry);
    const source = asTrimmed(r.source);
    const target = asTrimmed(r.target);
    // 悬空边（引用不存在节点）丢弃，避免执行引擎引用到缺失节点。
    if (
      !source ||
      !target ||
      !nodeIds.has(source) ||
      !nodeIds.has(target)
    )
      return;
    const id = asTrimmed(r.id) || `edge-${index + 1}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      source,
      sourceHandle: asTrimmed(r.sourceHandle) || "out",
      target,
      targetHandle: asTrimmed(r.targetHandle) || "in",
    });
  });
  return out.slice(0, MAX_WORKFLOW_CONNECTIONS);
}

// ── 运行历史规范化 ────────────────────────────────────────────────────────────

function normalizeNodeRunStatus(value: unknown): WorkflowNodeRunStatus {
  if (
    value === "running" ||
    value === "success" ||
    value === "error" ||
    value === "skipped"
  )
    return value;
  return "pending";
}

function normalizeWorkflowRunStatus(value: unknown): WorkflowRunStatus {
  if (value === "running" || value === "success" || value === "error") return value;
  return "idle";
}

function normalizeNodeResult(value: unknown): WorkflowNodeRunResult {
  const r = record(value);
  return {
    nodeId: asTrimmed(r.nodeId),
    status: normalizeNodeRunStatus(r.status),
    startedAt: asTrimmed(r.startedAt),
    finishedAt: asTrimmed(r.finishedAt),
    message: asText(r.message),
    outputJson: asText(r.outputJson),
    threadId: asTrimmed(r.threadId),
    error: asText(r.error),
    ...(r.inputJson !== undefined ? { inputJson: asText(r.inputJson) } : {}),
    ...(r.retries !== undefined
      ? { retries: clampInt(r.retries, 0, 0, 100) }
      : {}),
  };
}

function normalizeRun(value: unknown, index: number): WorkflowRun {
  const r = record(value);
  return {
    id: asTrimmed(r.id) || `run-${index + 1}`,
    trigger: asTrimmed(r.trigger) || "manual",
    status: normalizeWorkflowRunStatus(r.status),
    startedAt: asTrimmed(r.startedAt),
    finishedAt: asTrimmed(r.finishedAt),
    message: asText(r.message),
    nodeResults: Array.isArray(r.nodeResults)
      ? r.nodeResults.map(normalizeNodeResult)
      : [],
  };
}

// ── 顶层工作流规范化 ──────────────────────────────────────────────────────────

/**
 * 规范化一个工作流原始对象为合法的 WorkflowDef。
 * `index` 用于 fallback id 生成，`now` 为当前 ISO 时间串（createdAt/updatedAt 兜底）。
 *
 * 任何损坏的节点（未知 kind、字段缺失）会被安全丢弃（filter null），
 * 悬空边会被过滤，所有越界数值会被钳制到合法范围。
 */
export function normalizeWorkflow(
  workflow: Partial<WorkflowDef>,
  index: number,
  now: string,
): WorkflowDef {
  const w = workflow ?? {};
  const nodes = Array.isArray(w.nodes)
    ? w.nodes
        .map((node, nodeIndex) => normalizeWorkflowNode(node, nodeIndex))
        .filter((node): node is WorkflowNode => node !== null)
    : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const connections = normalizeConnections(w.connections, nodeIds);
  const runs = Array.isArray(w.runs)
    ? w.runs
        .map((run, runIndex) => normalizeRun(run, runIndex))
        .slice(-MAX_WORKFLOW_RUNS)
    : [];

  const modules = normalizeModules((w as Record<string, unknown>).modules);

  return {
    id: asTrimmed(w.id) || `workflow-${index + 1}`,
    name: asTrimmed(w.name) || `Workflow ${index + 1}`,
    enabled: normalizeBoolean(w.enabled, true),
    callableByAgent: normalizeBoolean(w.callableByAgent, false),
    env: normalizeEnvVars(w.env),
    // modules 可选字段：有内容时包含，避免所有存量工作流多一个空数组字段
    ...(modules !== undefined ? { modules } : {}),
    nodes,
    connections,
    createdAt: asTrimmed(w.createdAt) || now,
    updatedAt: asTrimmed(w.updatedAt) || now,
    lastRunAt: asTrimmed(w.lastRunAt),
    nextRunAt: asTrimmed(w.nextRunAt),
    lastStatus: normalizeWorkflowRunStatus(w.lastStatus),
    lastMessage: asText(w.lastMessage),
    runs,
  };
}
