import { readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const MAX_TITLE_CHARS = 160;
const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_TARGET_CHARS = 2_000;
const MAX_ITEM_CHARS = 4_000;
const MAX_CONTEXT_ITEM_CHARS = 12_000;
const MAX_LIST_ITEMS = 32;
const MAX_TARGET_PATHS = 24;
const MAX_DELEGATION_PROMPT_CHARS = 32_000;

const MAX_CONTRACT_TOOL_CALLS = 200;
const MAX_CONTRACT_DURATION_MINUTES = 30;

function requiredText(label: string, maxChars: number) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(maxChars, `${label} must be at most ${maxChars} characters`);
}

function requiredList(label: string, options?: { allowEmpty?: boolean; maxItemChars?: number }) {
  const schema = z
    .array(requiredText(`${label} item`, options?.maxItemChars ?? MAX_ITEM_CHARS))
    .max(MAX_LIST_ITEMS, `${label} must contain at most ${MAX_LIST_ITEMS} items`);
  return options?.allowEmpty ? schema : schema.min(1, `${label} must contain at least one item`);
}

const delegationTargetSchema = z.object({
  description: requiredText("target.description", MAX_TARGET_CHARS).describe(
    "The exact repository, module, file set, document, URL, or other object the child must work on.",
  ),
  rootPath: requiredText("target.rootPath", MAX_TARGET_CHARS)
    .optional()
    .describe("Absolute workspace root when the target is filesystem-backed."),
  paths: z
    .array(requiredText("target.paths item", MAX_TARGET_CHARS))
    .max(MAX_TARGET_PATHS, `target.paths must contain at most ${MAX_TARGET_PATHS} items`)
    .describe("Specific files or directories within the target. Use an empty array when not applicable."),
});

const repositoryTargetSchema = delegationTargetSchema.extend({
  rootPath: requiredText("target.rootPath", MAX_TARGET_CHARS)
    .refine((value) => isAbsolute(value), "target.rootPath must be an absolute path")
    .describe("Absolute repository or project root. Never guess by walking parent or home directories."),
});

const delegationConstraintsSchema = z.object({
  maxToolCalls: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONTRACT_TOOL_CALLS)
    .describe("Hard maximum number of child tool calls for this task."),
  maxDurationMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONTRACT_DURATION_MINUTES)
    .describe("Hard wall-clock limit in minutes for this child task."),
  additional: requiredList("constraints.additional", { allowEmpty: true }).describe(
    "Additional execution constraints. Access mode is enforced by the selected role and must not be restated here.",
  ),
});

/**
 * 所有用户可见子代理工具共用的结构化任务合同。
 *
 * 访问模式不由调用模型填写，而由角色的 toolPolicy 强制生成；否则只读角色可以通过参数把自己
 * 提升为可写。其余字段全部必填，即便是“无额外上下文”也要显式传空数组，避免独立 child
 * 把缺失信息误当成可以自行猜测或扩大搜索范围。
 */
export const delegationContractSchema = z.object({
  title: requiredText("title", MAX_TITLE_CHARS).describe(
    "Short task title used by the child-session card, ideally 2-6 words.",
  ),
  objective: requiredText("objective", MAX_OBJECTIVE_CHARS).describe(
    "One concrete, measurable objective. State the outcome, not merely a topic.",
  ),
  target: delegationTargetSchema,
  inScope: requiredList("inScope").describe("Work the child must perform."),
  outOfScope: requiredList("outOfScope").describe(
    "Explicitly forbidden work and boundaries the child must not cross.",
  ),
  constraints: delegationConstraintsSchema,
  context: requiredList("context", { allowEmpty: true, maxItemChars: MAX_CONTEXT_ITEM_CHARS }).describe(
    "Facts, evidence, paths, or source material required to work independently. Use [] only when none is needed.",
  ),
  deliverable: requiredText("deliverable", MAX_OBJECTIVE_CHARS).describe(
    "Exact output format and level of detail expected from the child.",
  ),
  doneWhen: requiredList("doneWhen").describe("Observable completion criteria."),
  blockedWhen: requiredList("blockedWhen").describe(
    "Conditions that require the child to stop and report the blocker instead of guessing or expanding scope.",
  ),
});

/** Repository Explorer 必须额外提供绝对根目录，运行时还会检查目录存在且非空。 */
export const repositoryDelegationContractSchema = delegationContractSchema.extend({
  target: repositoryTargetSchema,
});

export const delegationContractInputShape = delegationContractSchema.shape;
export const repositoryDelegationContractInputShape = repositoryDelegationContractSchema.shape;

export type DelegationContract = z.infer<typeof delegationContractSchema>;
export type RepositoryDelegationContract = z.infer<typeof repositoryDelegationContractSchema>;
export type DelegationAccess = "readOnly" | "inherit";

export interface DelegationBudgetTrip {
  kind: "tool-call-limit" | "duration-limit";
  limit: number;
  observed?: number;
  message: string;
}

/**
 * 单个 child 的合同预算守卫。调用方只需在开始时 `start()`、每个 tool-start 调
 * `recordToolCall()`、结束时 `dispose()`；计数与定时器的实现细节不会泄露到两个运行时 adapter。
 */
export class DelegationBudgetGuard {
  private toolCalls = 0;
  private tripValue: DelegationBudgetTrip | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly constraints: DelegationContract["constraints"]) {}

  start(onTrip: (trip: DelegationBudgetTrip) => void): void {
    if (this.timer || this.tripValue) return;
    this.timer = setTimeout(() => {
      const trip = this.tripOnce({
        kind: "duration-limit",
        limit: this.constraints.maxDurationMinutes,
        message: `子 Agent 超过合同约定的 ${this.constraints.maxDurationMinutes} 分钟执行上限。`,
      });
      if (trip) onTrip(trip);
    }, this.constraints.maxDurationMinutes * 60_000);
    this.timer.unref?.();
  }

  recordToolCall(): DelegationBudgetTrip | undefined {
    if (this.tripValue) return this.tripValue;
    this.toolCalls += 1;
    if (this.toolCalls <= this.constraints.maxToolCalls) return undefined;
    return this.tripOnce({
      kind: "tool-call-limit",
      limit: this.constraints.maxToolCalls,
      observed: this.toolCalls,
      message: `子 Agent 超过合同约定的 ${this.constraints.maxToolCalls} 次工具调用上限（已尝试 ${this.toolCalls} 次）。`,
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private tripOnce(next: DelegationBudgetTrip): DelegationBudgetTrip | undefined {
    if (this.tripValue) return undefined;
    this.tripValue = next;
    return next;
  }
}

function escapedContractJson(value: unknown): string {
  // 防止字段文本伪造外层关闭标签；JSON 仍保持人和模型都易读。
  return JSON.stringify(value, null, 2).replaceAll("</delegation_contract>", "<\\/delegation_contract>");
}

/**
 * 把结构化参数渲染成唯一的 child prompt。访问语义来自角色策略，调用模型不能覆盖。
 * @throws 合同异常膨胀时拒绝执行，避免一次委派直接耗尽小上下文模型。
 */
export function renderDelegationContract(
  contract: DelegationContract,
  options: { access: DelegationAccess; roleLabel: string },
): string {
  const access = options.access === "readOnly"
    ? "Read-only. Runtime tools physically prevent workspace mutation."
    : "Inherit the parent session's runtime permission and approval policy.";
  const payload = {
    title: contract.title,
    objective: contract.objective,
    target: contract.target,
    inScope: contract.inScope,
    outOfScope: contract.outOfScope,
    constraints: {
      access,
      maxToolCalls: contract.constraints.maxToolCalls,
      maxDurationMinutes: contract.constraints.maxDurationMinutes,
      additional: contract.constraints.additional,
    },
    context: contract.context,
    deliverable: contract.deliverable,
    doneWhen: contract.doneWhen,
    blockedWhen: contract.blockedWhen,
  };
  const prompt = [
    "<delegation_contract>",
    `You are the delegated child agent for role "${options.roleLabel}".`,
    "You cannot see the parent conversation. Treat every field below as authoritative and complete.",
    "Do only in-scope work, never perform out-of-scope work, and stop immediately when a blockedWhen condition is met.",
    "Do not guess missing targets, walk parent/home directories, or broaden the task to compensate for missing context.",
    escapedContractJson(payload),
    "Return only the requested deliverable plus a concise blocker report when blocked.",
    "</delegation_contract>",
  ].join("\n");
  if (prompt.length > MAX_DELEGATION_PROMPT_CHARS) {
    throw new Error(`委派合同过长（>${MAX_DELEGATION_PROMPT_CHARS} 字符）`);
  }
  return prompt;
}

/**
 * 校验文件系统目标，并保证显式子路径不会通过绝对路径或 `..` 逃出 rootPath。
 * Repository Explorer 还要求根目录非空：空目录没有可探索内容，应把路径问题返回父会话，而不是
 * 自行向父目录或用户主目录扩散。
 */
export async function validateDelegationTarget(
  contract: DelegationContract,
  options: { requireRootPath: boolean; requireNonEmptyRoot: boolean },
): Promise<string | null> {
  const rootPath = contract.target.rootPath?.trim();
  if (!rootPath) {
    return options.requireRootPath ? "仓库探索必须提供 target.rootPath" : null;
  }
  if (!isAbsolute(rootPath)) return "target.rootPath 必须是绝对路径";

  let info;
  try {
    info = await stat(rootPath);
  } catch {
    return `target.rootPath 不存在：${rootPath}`;
  }
  if (!info.isDirectory()) return `target.rootPath 不是目录：${rootPath}`;

  if (options.requireNonEmptyRoot) {
    try {
      if ((await readdir(rootPath)).length === 0) return `target.rootPath 是空目录：${rootPath}`;
    } catch {
      return `target.rootPath 无法读取：${rootPath}`;
    }
  }

  for (const targetPath of contract.target.paths) {
    const resolvedPath = resolve(rootPath, targetPath);
    const rel = relative(rootPath, resolvedPath);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return `目标路径越出 target.rootPath：${targetPath}`;
    }
  }
  return null;
}
