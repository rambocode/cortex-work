// DSL（Deep loop Schema）导出/导入纯函数（U15）。
// 参考 Kun src/shared/workflow-dsl.ts，适配 cortex WorkflowDef 类型。
//
// 设计约束：
//   - 纯函数：不触碰 Date、crypto 等副作用（由调用方注入）
//   - 脱敏：导出时 secret env value 置空，保留 key 与 type
//   - 安全：明文存盘（settings JSON 同款信任模型），DSL 导出脱敏即可
//     不引入 keychain，保持与项目其他配置一致的本机信任取舍。
//     TODO：如未来需跨机迁移 secret，可在此处加 AES-256 加密层。
//   - 幂等：normalize 兜底任何格式损坏

import type { WorkflowDef } from "./types";
import { normalizeWorkflow } from "./normalize";

// ── DSL 文档类型 ───────────────────────────────────────────────────────────────

/**
 * 可移植 loop 文档格式 V1（DSV = "Deep loop Schema Version"）。
 * 对齐 Kun WorkflowDslV1，字段语义相同。
 */
export interface WorkflowDslV1 {
  /** Schema 版本，目前固定为 1。 */
  dsv: 1;
  kind: "workflow";
  /** 导出来源 App 名（Cortex Desktop）。 */
  app: string;
  /** 导出时间戳（ISO 8601，由调用方注入）。 */
  exportedAt: string;
  /** 脱敏后的工作流定义（不含运行历史与调度状态）。 */
  workflow: WorkflowDef;
}

/** parseWorkflowDsl 的返回联合类型。 */
export type WorkflowImportResult =
  | { ok: true; workflow: WorkflowDef }
  | { ok: false; error: "invalid-json" | "unsupported" | "empty" };

// ── 导出 ───────────────────────────────────────────────────────────────────────

/**
 * 把工作流快照为可移植 DSL 文档（纯函数）。
 *
 * 脱敏规则（与 Kun exportWorkflowDsl 对齐）：
 *   - env 中 type==="secret" 的条目：value 置空（key 与 type 保留，方便导入后重填）
 *   - enabled / callableByAgent 强制 false（导入后由用户手动启用）
 *   - runs / lastRunAt / nextRunAt / lastStatus / lastMessage 清空（历史无需携带）
 *
 * @param workflow  工作流定义（原始，不修改）
 * @param exportedAt ISO 8601 导出时间戳（由 IPC 层传入 new Date().toISOString()）
 */
export function exportWorkflowDsl(workflow: WorkflowDef, exportedAt: string): WorkflowDslV1 {
  // 脱敏 env：secret 条目 value 置空，普通条目原样保留
  const sanitizedEnv = workflow.env.map((entry) =>
    entry.type === "secret" ? { ...entry, value: "" } : entry,
  );

  return {
    dsv: 1,
    kind: "workflow",
    app: "Cortex Desktop",
    exportedAt,
    workflow: {
      ...workflow,
      env: sanitizedEnv,
      // 导入后不自动启用，避免未经用户确认就触发定时器/webhook
      enabled: false,
      callableByAgent: false,
      // 运行历史与调度元数据不跨实例迁移
      lastRunAt: "",
      nextRunAt: "",
      lastStatus: "idle",
      lastMessage: "",
      runs: [],
    },
  };
}

// ── 导入 ───────────────────────────────────────────────────────────────────────

/**
 * 解析并校验 DSL JSON（纯函数）。
 *
 * 支持两种格式：
 *   1. Wrapped 格式：{ kind:'workflow', workflow:{...} }（标准 DSL V1）
 *   2. 裸工作流格式：{ nodes:[...], ... }（兼容直接粘贴工作流 JSON）
 *
 * 过规范化器后仍无节点 → 返回 { ok:false, error:'empty' }。
 * 导入后强制：enabled=false, callableByAgent=false, runs=[]（同 exportWorkflowDsl）。
 *
 * 注意：不分配新 id，id 分配由 IPC 层（newWorkflowId()）完成，保持职责分离。
 *
 * @param raw  任意未知输入（来自 JSON.parse 或用户粘贴）
 * @param now  当前时间戳（ISO 8601，供 normalizeWorkflow 使用）
 */
export function parseWorkflowDsl(raw: unknown, now: string): WorkflowImportResult {
  // 基础结构检查
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "unsupported" };
  }

  const doc = raw as Record<string, unknown>;

  // 判断格式：wrapped DSL 还是裸工作流
  let candidate: Record<string, unknown> | null = null;

  if (doc["kind"] === "workflow" && doc["workflow"] && typeof doc["workflow"] === "object") {
    // 标准 wrapped DSL 格式
    candidate = doc["workflow"] as Record<string, unknown>;
  } else if (Array.isArray(doc["nodes"])) {
    // 裸工作流格式（有 nodes 数组）
    candidate = doc;
  }

  if (!candidate) {
    return { ok: false, error: "unsupported" };
  }

  // normalizeWorkflow 契约：任何输入（包括损坏数据）都不抛出，返回合法 WorkflowDef
  const normalized = normalizeWorkflow(candidate as Partial<WorkflowDef>, 0, now);

  // 导入空工作流无意义（至少要有触发器）
  if (normalized.nodes.length === 0) {
    return { ok: false, error: "empty" };
  }

  return {
    ok: true,
    workflow: {
      ...normalized,
      // 导入后强制安全默认值（与导出脱敏对称）
      enabled: false,
      callableByAgent: false,
      lastRunAt: "",
      nextRunAt: "",
      lastStatus: "idle",
      lastMessage: "",
      runs: [],
    },
  };
}

/**
 * 检测工作流是否含有可执行代码类节点（code / custom）。
 * 导入时 UI 应展示安全提示，让用户确认来源可信。
 */
export function hasCodeNodes(workflow: WorkflowDef): boolean {
  return workflow.nodes.some((n) => n.type === "code" || n.type === "custom");
}
