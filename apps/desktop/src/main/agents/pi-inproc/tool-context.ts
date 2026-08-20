// Pi 工具结果上下文投影：只在每次 provider 请求前构造模型可见副本，绝不回写 AgentSession、
// 事件流或 process archive。展示和持久化仍以原始 toolResult 为真源。
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type {
  AgentMessage,
  ShouldStopAfterTurnContext,
  ShouldStopAfterTurnDecision,
} from "@earendil-works/pi-agent-core";
import type { ContextUsage, ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

const SAFETY_RESERVE = 4_096;
const EXTERNAL_OUTPUT_ROOT = join(tmpdir(), "cortex-tool-context");
const EXTERNAL_OUTPUT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const CONTEXT_BLOCK_CODE = "PI_CONTEXT_BLOCKED";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type ToolResultText = Extract<ToolResultMessage["content"][number], { type: "text" }>;

export interface ToolContextProjectionReport {
  estimatedBefore: number | null;
  estimatedAfter: number | null;
  projectedResults: number;
  deduplicatedResults: number;
  externalizedResults: number;
  budgetExhausted: boolean;
}

export interface ToolContextProjector {
  /**
   * 返回仅供模型请求使用的消息副本。预算内直接返回输入引用；任何异常均 fail-open 到原消息，
   * 以免优化层影响会话可用性。
   */
  project(input: {
    messages: AgentMessage[];
    model: Model<any> | undefined;
    usage: ContextUsage | undefined;
    systemPrompt: string;
  }): Promise<{ messages: AgentMessage[]; report: ToolContextProjectionReport }>;
  /** 尽力删除该会话的临时全文；失败只由调用方诊断，不得中断 session shutdown。 */
  dispose(): Promise<void>;
}

/** 单个 Cortex user run 只触发一次 checkpoint，压缩后由同一 AgentSession 自动 continue。 */
export interface ContextCheckpointGuard {
  shouldStopAfterTurn(context: ShouldStopAfterTurnContext): ShouldStopAfterTurnDecision;
  reset(): void;
}

interface ToolOutputStore {
  put(key: string, content: string): Promise<string | undefined>;
  dispose(): Promise<void>;
}

/** 由本地 Pi fork 的 ExtensionRunner 识别；它在 convertToLlm 前中止本次 provider request。 */
class ToolContextBudgetError extends Error {
  readonly code = CONTEXT_BLOCK_CODE;

  constructor() {
    super("Tool context remains above the request budget after projection; compact the session before continuing.");
  }
}

/** 单测用的内存替身；生产投影不把完整输出留在进程日志或 renderer 状态。 */
export class MemoryToolOutputStore implements ToolOutputStore {
  readonly outputs = new Map<string, string>();

  async put(key: string, content: string): Promise<string> {
    this.outputs.set(key, content);
    return `memory://cortex-tool-context/${key}`;
  }

  async dispose(): Promise<void> {
    this.outputs.clear();
  }
}

/** 会话级本地全文存储；名称只有 hash，目录/文件权限分别固定为 0700/0600。 */
export class FileToolOutputStore implements ToolOutputStore {
  private readonly directory: string;
  private readonly entries = new Map<string, string>();
  private initialized = false;

  constructor(sessionId: string) {
    this.directory = join(EXTERNAL_OUTPUT_ROOT, shortHash(sessionId));
  }

  async put(key: string, content: string): Promise<string | undefined> {
    const contentHash = shortHash(content);
    const existing = this.entries.get(`${key}:${contentHash}`);
    if (existing) return existing;
    await this.ensureDirectory();
    const filename = `${shortHash(`${key}:${contentHash}`)}.txt`;
    const path = join(this.directory, filename);
    await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "w" });
    await chmod(path, 0o600);
    this.entries.set(`${key}:${contentHash}`, path);
    // manifest 故意不保存正文、原路径、命令或完整 hash；仅用于过期清理后的可观察性。
    await writeFile(
      join(this.directory, "manifest.json"),
      JSON.stringify({ entries: [...this.entries.values()].map((entry) => ({ file: entry.split("/").at(-1), bytes: Buffer.byteLength(content), createdAt: Date.now() })) }),
      { encoding: "utf8", mode: 0o600 },
    );
    return path;
  }

  async dispose(): Promise<void> {
    this.entries.clear();
    await rm(this.directory, { recursive: true, force: true });
  }

  private async ensureDirectory(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    this.initialized = true;
  }
}

/** worker 启动时可调用：删除崩溃遗留的会话目录，不扫描或读取任何工具正文。 */
export async function cleanupExpiredToolContextDirectories(now = Date.now()): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(EXTERNAL_OUTPUT_ROOT);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(EXTERNAL_OUTPUT_ROOT, entry);
      try {
        const metadata = await stat(path);
        if (metadata.isDirectory() && now - metadata.mtimeMs > EXTERNAL_OUTPUT_MAX_AGE_MS) {
          await rm(path, { recursive: true, force: true });
        }
      } catch {
        // 清理是 best-effort；并发 session 正在退出/创建时不把 races 当作运行错误。
      }
    }),
  );
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** pi 允许 app 扩展 AgentMessage；未知自定义消息不属于工具正文，估算时按零处理且绝不裁剪。 */
function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
  return message.role === "toolResult" && "toolCallId" in message && "toolName" in message && "content" in message;
}

function messageCharacters(message: AgentMessage): number {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content.length
      : message.content.reduce((sum, content) => sum + (content.type === "text" ? content.text.length : 0), 0);
  }
  if (message.role === "assistant") {
    return message.content.reduce((sum, content) => {
      if (content.type === "text") return sum + content.text.length;
      if (content.type === "thinking") return sum + content.thinking.length;
      return sum + content.name.length + JSON.stringify(content.arguments).length;
    }, 0);
  }
  return isToolResultMessage(message)
    ? message.content.reduce((sum, content) => sum + (content.type === "text" ? content.text.length : 0), 0)
    : 0;
}

function estimateCharacters(messages: AgentMessage[], systemPrompt: string): number {
  return Math.ceil((systemPrompt.length + messages.reduce((sum, message) => sum + messageCharacters(message), 0)) / 4);
}

/**
 * 为原始 AgentSession 安装 run 内 checkpoint 判定。它故意基于未投影的上下文：投影决定本次
 * provider 请求载荷，checkpoint 决定长驻历史是否必须压缩，两者不能互相掩盖。
 */
export function createContextCheckpointGuard(input: {
  model: Model<any> | undefined;
  reserveTokens: number;
}): ContextCheckpointGuard {
  let checkpointed = false;
  return {
    reset: () => {
      checkpointed = false;
    },
    shouldStopAfterTurn: ({ message, toolResults, context }) => {
      if (checkpointed || toolResults.length === 0 || message.stopReason !== "toolUse") return false;
      const model = input.model;
      if (!model || input.reserveTokens <= 0 || input.reserveTokens >= model.contextWindow) return false;
      const estimatedTokens = estimateCharacters(context.messages, context.systemPrompt);
      if (estimatedTokens <= model.contextWindow - input.reserveTokens) return false;
      checkpointed = true;
      return { reason: "context-checkpoint" };
    },
  };
}

/** 模型窗口连 answer + safety reserve 都容不下时，继续 open 只会在 provider 侧退化成 1 token。 */
export function assertToolContextBudget(model: Model<any> | undefined): void {
  if (!model) return;
  const answerReserve = clamp(model.maxTokens, 1_024, 8_192);
  if (model.contextWindow <= answerReserve + SAFETY_RESERVE) {
    throw new Error(
      `模型 contextWindow=${model.contextWindow} 无法保留 ${answerReserve} answer tokens 与 ${SAFETY_RESERVE} safety tokens`,
    );
  }
}

function report(estimatedBefore: number | null, estimatedAfter: number | null): ToolContextProjectionReport {
  return { estimatedBefore, estimatedAfter, projectedResults: 0, deduplicatedResults: 0, externalizedResults: 0, budgetExhausted: false };
}

function textContent(message: ToolResultMessage): { text: string; hasImages: boolean } {
  return {
    text: message.content.filter((content): content is ToolResultText => content.type === "text").map((content) => content.text).join("\n"),
    hasImages: message.content.some((content) => content.type === "image"),
  };
}

function toolArguments(messages: AgentMessage[], resultIndex: number, toolCallId: string): Record<string, unknown> | undefined {
  for (let index = resultIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const match = message.content.find((content) => content.type === "toolCall" && content.id === toolCallId);
    if (match?.type === "toolCall") return match.arguments;
  }
  return undefined;
}

function textBlocks(message: ToolResultMessage, text: string): ToolResultMessage["content"] {
  let inserted = false;
  const output: ToolResultMessage["content"] = [];
  for (const content of message.content) {
    if (content.type !== "text") output.push(content);
    else if (!inserted) {
      output.push({ type: "text", text });
      inserted = true;
    }
  }
  return output;
}

function formatRead(text: string, args: Record<string, unknown> | undefined, limit: number): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > limit) break;
    kept.push(line);
    length += line.length + 1;
  }
  const path = typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "requested file";
  const offset = typeof args?.offset === "number" ? args.offset : 0;
  const nextOffset = offset + kept.length;
  return `${kept.join("\n")}\n\n[Read result truncated: ${path}; kept ${kept.length}/${lines.length} lines. Continue with offset=${nextOffset}.]`;
}

function headTail(text: string, limit: number, suffix: string): string {
  if (text.length <= limit) return text;
  const head = Math.max(256, Math.floor(limit * 0.55));
  const tail = Math.max(256, limit - head);
  return `${text.slice(0, head)}\n…\n${text.slice(-tail)}\n\n${suffix}`;
}

function compactWrite(toolName: string, args: Record<string, unknown> | undefined, isError: boolean): string {
  const path = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "target file";
  return isError
    ? `[${toolName} failed for ${path}; inspect the original error details before retrying.]`
    : `[${toolName} completed for ${path}; the requested content is already present in the prior tool call.]`;
}

function projectText(input: {
  text: string;
  toolName: string;
  args: Record<string, unknown> | undefined;
  isError: boolean;
  softLimit: number;
  fullOutputRef?: string;
}): string {
  const normalized = input.toolName.toLowerCase();
  if (normalized === "read" || normalized === "read_file") return formatRead(input.text, input.args, input.softLimit);
  if (normalized === "edit" || normalized === "write" || normalized === "write_file") {
    return compactWrite(input.toolName, input.args, input.isError);
  }
  if (normalized === "todo_write") return "[Task list snapshot compacted; the latest task state remains available in the conversation UI.]";
  if (normalized === "bash" && input.isError) {
    return headTail(input.text, Math.max(1_024, input.softLimit), "[Command failed; stderr tail retained.]");
  }
  if (normalized === "bash" && input.text.trim().length === 0) return "(no output; exit 0)";
  const reference = input.fullOutputRef ? ` Full output is available locally at ${input.fullOutputRef}.` : "";
  return headTail(input.text, input.softLimit, `[Tool output truncated.${reference}]`);
}

export function createToolContextProjector(options: {
  sessionId: string;
  store?: ToolOutputStore;
}): ToolContextProjector {
  const store = options.store ?? new FileToolOutputStore(options.sessionId);

  return {
    async project(input) {
      const model = input.model;
      if (!model) return { messages: input.messages, report: report(null, null) };
      const answerReserve = clamp(model.maxTokens, 1_024, 8_192);
      const requestInputBudget = model.contextWindow - answerReserve - SAFETY_RESERVE;
      if (requestInputBudget <= 0) {
        // 模型配置异常时不擅自改写消息；open 路径会在模型解析后做响亮失败。
        return { messages: input.messages, report: { ...report(null, null), budgetExhausted: true } };
      }

      const fallbackBefore = estimateCharacters(input.messages, input.systemPrompt);
      // Pi 在刚完成 compaction、faux provider 或未上报 usage 时会给 0/null；0 不是可信的
      // “空上下文”，必须退回字符估算，否则巨型 toolResult 会被错误地当作预算内直通。
      const estimatedBefore =
        input.usage?.tokens !== null && input.usage?.tokens !== undefined && input.usage.tokens > 0
          ? input.usage.tokens
          : fallbackBefore;
      if (estimatedBefore <= requestInputBudget) return { messages: input.messages, report: report(estimatedBefore, estimatedBefore) };

      try {
        const softLimit = clamp(Math.floor(model.contextWindow * 0.08), 1_024, 8_192);
        const seenRead = new Map<string, number>();
        const candidates = input.messages.flatMap((message, index) => {
          if (!isToolResultMessage(message)) return [];
          const { text, hasImages } = textContent(message);
          if (!text || hasImages) return [];
          const args = toolArguments(input.messages, index, message.toolCallId);
          const normalized = message.toolName.toLowerCase();
          const path = typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : undefined;
          const readKey = (normalized === "read" || normalized === "read_file") && path ? `${path}:${shortHash(text)}:${String(args?.offset ?? 0)}:${String(args?.limit ?? "")}` : undefined;
          const duplicateOf = readKey ? seenRead.get(readKey) : undefined;
          if (readKey && duplicateOf === undefined) seenRead.set(readKey, index);
          const recent = index >= input.messages.length - 4;
          return [{ index, message, text, args, duplicateOf, rank: duplicateOf !== undefined ? 0 : message.isError ? 5 : recent ? 4 : normalized === "bash" ? 2 : normalized === "read" ? 3 : 1 }];
        }).sort((a, b) => a.rank - b.rank || a.index - b.index);

        const projected = [...input.messages];
        const projectionReport = report(estimatedBefore, estimatedBefore);
        let estimatedAfter = estimatedBefore;
        for (const candidate of candidates) {
          if (estimatedAfter <= requestInputBudget) break;
          const originalTokens = Math.ceil(candidate.text.length / 4);
          let replacement: string;
          if (candidate.duplicateOf !== undefined) {
            const path = typeof candidate.args?.file_path === "string" ? candidate.args.file_path : "requested file";
            replacement = `[Unchanged file result: ${path}, same content as previous read, sha256=${shortHash(candidate.text)}]`;
            projectionReport.deduplicatedResults += 1;
          } else {
            const needsExternal = candidate.text.length > softLimit * 4;
            const fullOutputRef = needsExternal ? await store.put(candidate.message.toolCallId, candidate.text) : undefined;
            if (fullOutputRef) projectionReport.externalizedResults += 1;
            replacement = projectText({
              text: candidate.text,
              toolName: candidate.message.toolName,
              args: candidate.args,
              isError: candidate.message.isError,
              softLimit: candidate.message.isError ? Math.max(1_024, softLimit) : softLimit,
              ...(fullOutputRef ? { fullOutputRef } : {}),
            });
          }
          if (replacement.length >= candidate.text.length) continue;
          projected[candidate.index] = { ...candidate.message, content: textBlocks(candidate.message, replacement) };
          estimatedAfter = Math.max(0, estimatedAfter - Math.max(0, originalTokens - Math.ceil(replacement.length / 4)));
          projectionReport.projectedResults += 1;
        }
        projectionReport.estimatedAfter = estimatedAfter;
        projectionReport.budgetExhausted = estimatedAfter > requestInputBudget;
        return { messages: projectionReport.projectedResults > 0 ? projected : input.messages, report: projectionReport };
      } catch {
        // 投影模块不携带正文到日志，异常必须降级为原消息，不能断掉 agent loop。
        return { messages: input.messages, report: { ...report(estimatedBefore, estimatedBefore), budgetExhausted: true } };
      }
    },
    dispose: () => store.dispose(),
  };
}

/**
 * 在 pi 的 context hook 注册投影器。hook 的输入是 runner 已 clone 的消息；这里仍坚持不原地修改，
 * 使多 extension 串联时每一方都能安全保留上一方的输入。
 */
export function createToolContextExtension(options: {
  sessionId: string;
  onReport?: (report: ToolContextProjectionReport) => void;
  store?: ToolOutputStore;
}): InlineExtension {
  const projector = createToolContextProjector(options);
  return {
    name: "cortex-tool-context",
    factory: (pi: ExtensionAPI) => {
      pi.on("context", async (event, ctx) => {
        const result = await projector.project({
          messages: event.messages,
          model: ctx.model,
          usage: ctx.getContextUsage(),
          systemPrompt: ctx.getSystemPrompt(),
        });
        if (result.report.projectedResults > 0 || result.report.budgetExhausted) options.onReport?.(result.report);
        // 不能让 provider 自己把 max_tokens 夹到 1：本地 fork 识别该错误并在 convertToLlm 前
        // 收尾为明确失败，原始 AgentMessage 与 process archive 都保持不变。
        if (result.report.budgetExhausted) throw new ToolContextBudgetError();
        // 预算内返回 undefined，保留 extension runner 当前的消息引用；避免无谓 clone/漂移。
        return result.messages === event.messages ? undefined : { messages: result.messages };
      });
      pi.on("session_shutdown", async () => {
        try {
          await projector.dispose();
        } catch {
          // shutdown 期间清理失败只留给宿主诊断，不能阻止 pi 自身资源释放。
        }
      });
    },
  };
}
