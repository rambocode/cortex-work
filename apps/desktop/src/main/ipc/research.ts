// Cortex Research Engine 的 IPC 域（spec §16）。
//
// 每个 handler 的顺序是固定的三步，缺一不可：
//   1. assertResearchSender —— 校验调用方确实是本应用的渲染进程；
//   2. zod 校验入参 —— renderer 的一切输入都不可信；
//   3. 调 ResearchService。
//
// **入参里刻意没有这些字段**（spec §16 明确禁止）：模型 API key、Search token、Worker 路径、
// 任意本地输出路径。它们全部由 main 从设置与 paths.ts 自行解析，renderer 连提及的能力都没有。
// 因此本文件的 schema 是一份"能力清单"：想加字段前先问一句「它会不会让 renderer 指挥
// 主进程去读写一个它本来碰不到的位置」。
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type {
  ResearchDetailLevel,
  ResearchRequest,
  ResearchSessionFilter,
} from "@cortex-work/core/research/types";
import { createLogger } from "../log";
import { assertResearchSender } from "../research/ipc-guard";
import { redactResearchLog } from "../research/redact-research";
import { getResearchService, setSearchServerCredential, testSearchServer } from "../research/runtime";
import type { ResearchEventSender, ResearchService } from "../research/research-service";

const log = createLogger("research-ipc");

/// 目标文本上限。远大于一句正常的研究目标，又不至于让 IPC 载荷失控。
const MAX_OBJECTIVE_CHARS = 2000;

/// Session id 的形状：main 自己铸造的 uuid，长度设上限只为挡住畸形超长字符串。
const sessionIdSchema = z.string().min(1).max(128);

/// 允许 renderer 指定的来源范围。
///
/// **只开放 public_web 与 memory**：local_file / enterprise 需要携带本地目录或租户 id，
/// 那等于让 renderer 指定主进程要读哪些路径。等 U9 的目录授权流程（main 侧弹目录选择器、
/// 把授权结果存进设置）落地后，再由 main 自行注入，而不是从 IPC 入参里读。
const sourceScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("public_web") }),
  z.object({ kind: z.literal("memory") }),
]);

/// 预算覆盖。**只允许收窄不允许放宽**这件事由 core 的 clampResearchBudget 保证，
/// 这里只做形状与量级的兜底（负数、NaN、天文数字直接拒）。
const budgetOverrideSchema = z
  .object({
    maxRounds: z.number().int().min(1).max(100).optional(),
    maxQueries: z.number().int().min(1).max(1000).optional(),
    maxCandidates: z.number().int().min(1).max(5000).optional(),
    maxDocuments: z.number().int().min(1).max(1000).optional(),
    maxBrowserFetches: z.number().int().min(0).max(100).optional(),
    maxDurationMs: z.number().min(1000).max(24 * 3600 * 1000).optional(),
    maxEvidenceCharsToModel: z.number().int().min(1).max(2_000_000).optional(),
  })
  .strict();

const researchRequestSchema = z
  .object({
    consumer: z.enum(["chat", "deep_research", "slides", "writing", "coding", "knowledge"]),
    objective: z.string().trim().min(1).max(MAX_OBJECTIVE_CHARS),
    mode: z.enum(["quick", "standard", "deep"]),
    sourceScopes: z.array(sourceScopeSchema).min(1).max(4),
    modelDataPolicy: z.enum(["local_only", "metadata_only", "evidence_allowed"]),
    output: z
      .object({
        format: z.enum(["report", "evidence_package", "answer"]),
        maxWords: z.number().int().min(1).max(50_000).optional(),
        requireCitations: z.boolean(),
      })
      .strict(),
    budget: budgetOverrideSchema.optional(),
  })
  // strict：未知字段直接拒绝而不是静默剥离。渲染端若开始往请求里塞 token 之类的东西，
  // 我们要在第一时间炸出来，而不是让它"看起来能用"。
  .strict();

const detailSchema = z.enum(["summary", "full", "evidence"]);

const filterSchema = z
  .object({
    consumer: z.enum(["chat", "deep_research", "slides", "writing", "coding", "knowledge"]).optional(),
    status: z
      .enum([
        "created",
        "planning",
        "searching",
        "fetching",
        "evaluating",
        "reporting",
        "completed",
        "paused",
        "cancelled",
        "failed",
        "interrupted",
      ])
      .optional(),
    limit: z.number().int().min(1).max(200).optional(),
    before: z.string().max(64).optional(),
  })
  .strict();

/// handler 的统一外壳：sender 校验 → 订阅事件 → 执行 → 失败时脱敏记日志后原样抛回。
///
/// 为什么在这里订阅：spec §16 的 onEvent 没有独立通道，renderer 一旦调用任意研究 IPC
/// 就意味着它需要接收事件。addEventSender 幂等，重复调用不会让同一个窗口收到多份。
function handle<T>(
  channel: string,
  run: (service: ResearchService, args: unknown[], event: IpcMainInvokeEvent) => Promise<T>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    assertResearchSender(event);
    try {
      const service = await getResearchService();
      service.addEventSender(event.sender as unknown as ResearchEventSender);
      return await run(service, args, event);
    } catch (err) {
      // 日志走 CRE 脱敏：入参里含研究目标（用户意图原文），不能原样落盘。
      log.warn(`[${channel}] 失败`, redactResearchLog({ payload: args[0], error: describe(err) }));
      throw err;
    }
  });
}

/// 注册研究引擎的全部 IPC 通道。
export function registerResearchHandlers(): void {
  handle("research:create", async (service, [raw]) =>
    service.create(researchRequestSchema.parse(raw) as ResearchRequest),
  );

  handle("research:rerun", async (service, [rawId]) => service.rerun(sessionIdSchema.parse(rawId)));

  handle("research:run", async (service, [rawId]) => service.run(sessionIdSchema.parse(rawId)));

  handle("research:pause", async (service, [rawId]) => service.pause(sessionIdSchema.parse(rawId)));

  handle("research:resume", async (service, [rawId]) => service.resume(sessionIdSchema.parse(rawId)));

  handle("research:cancel", async (service, [rawId]) => service.cancel(sessionIdSchema.parse(rawId)));

  handle("research:get", async (service, [rawId, rawDetail]) =>
    service.get(sessionIdSchema.parse(rawId), detailSchema.parse(rawDetail) as ResearchDetailLevel),
  );

  handle("research:list", async (service, [rawFilter]) =>
    service.list(
      rawFilter === undefined || rawFilter === null
        ? undefined
        : (filterSchema.parse(rawFilter) as ResearchSessionFilter),
    ),
  );

  handle("research:delete", async (service, [rawId]) => service.delete(sessionIdSchema.parse(rawId)));

  // ── 设置页的两个 channel（不经 ResearchService）────────────────────────────────
  // 刻意不走上面的 handle()：那个外壳会 getResearchService()，为保存一个令牌就建 SQLite 连接、
  // fork Worker，纯属浪费；而且总开关关闭时服务根本拉不起来，会让用户没法先配好再开启。
  // 返回落盘后的切片（含密文、不含明文）：renderer 要拿它更新 store，
  // 否则它那份缺 encryptedToken 的副本会在下一次全量写回时把刚存的令牌抹掉。
  handleSettings("research:setSearchServerCredential", async ([raw]) =>
    setSearchServerCredential(searchCredentialSchema.parse(raw)),
  );

  handleSettings("research:testSearchServer", async () => testSearchServer());
}

/// 保存凭据的入参。
///
/// strict + 只有三个字段：renderer 能表达的东西到此为止，塞不进「写到哪个文件」之类的参数。
/// token 上限 4096 足够任何形态的 PAT/JWT，又能挡住把整份文件当令牌粘进来的误操作。
const searchCredentialSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(2048),
    workspaceId: z.string().trim().min(1).max(128),
    /// 明文 PAT。省略 = 只改地址/工作区，保留已存密文。
    token: z.string().min(1).max(4096).optional(),
  })
  .strict();

/// 设置类 handler 的外壳：sender 校验 → 执行 → 失败记日志后原样抛回。
///
/// 与 handle() 的关键差别有二：不碰 ResearchService；**永不记录入参**——
/// 这两个 channel 的入参含明文 PAT，即便 redactResearchLog 会脱敏，也不该让明文
/// 有机会流经日志格式化函数（spec §19.3.1 的凭据红线）。
function handleSettings<T>(channel: string, run: (args: unknown[]) => Promise<T>): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    assertResearchSender(event);
    try {
      return await run(args);
    } catch (err) {
      log.warn(`[${channel}] 失败`, describe(err));
      throw err;
    }
  });
}

/// 异常的可读描述（不含正文、不含凭据）。
function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
