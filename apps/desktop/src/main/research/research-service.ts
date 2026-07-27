// ResearchEngineFacade 的 main 侧实现（spec §7.2、§16）：Session 注册表 + 事件广播 +
// Worker 生命周期。
//
// 定位：这是 CRE 对所有 Consumer 的**唯一入口**。它刻意不暴露任意 URL fetch、任意 Worker
// method、数据库句柄或本地路径——IPC 层只能调这 9 个方法。
//
// 三条设计约束：
// 1. **一个 Session 同时只有一个编排在跑**（单飞）。并发 run 返回同一个 Promise，
//    否则两个编排会争抢同一个 roundIndex 与 operation id。
// 2. **Worker 按需拉起**：总开关关闭时一个进程都不起（spec §16 的灰度开关就是为此存在）。
//    崩溃后是否重拉由本层决定（process-manager 明确不自动重启，避免重启风暴）。
// 3. **事件推送必须防悬挂 sender**：renderer 只 reload 不关窗时旧 WebContents 会被销毁，
//    继续 send 会抛错并让整轮广播中断（照 ipc/pty.ts 的 isDestroyed + once("destroyed") 做法）。
import type { ResearchEngineSettings } from "@cortex-work/core/research/settings";
import { clampResearchBudget } from "@cortex-work/core/research/budget";
import { TERMINAL_RESEARCH_STATUSES } from "@cortex-work/core/research/session-status";
import type {
  ResearchConsumer,
  ResearchDetailLevel,
  ResearchEngineFacade,
  ResearchEvent,
  ResearchRequest,
  ResearchReport,
  ResearchSessionFilter,
  ResearchSessionSummary,
  ResearchSessionView,
} from "@cortex-work/core/research/types";
import type { ResearchLlmHooks } from "./planner/llm-hooks";
import {
  ResearchOrchestrator,
  buildSeedPlan,
  type BlobWriterLike,
  type ResearchWorkerLike,
  type SearchClientLike,
  type StealthFetchLike,
} from "./research-orchestrator";
import type { MemoryCandidate } from "@cortex-work/core/research/knowledge";
import { assertResearchEnabled, SearchServerNotConfiguredError } from "./consumer-gate";
import { extractKnowledgeFromReport } from "./knowledge-extractor";
import type {
  MemoryCandidateView,
  ResearchRepository,
  ResearchSessionQuery,
} from "./research-repository";
import { SessionStateWriter } from "./session-state";
import { validateResearchReport } from "./citation-validator";

/// 推送事件的 IPC 通道名。preload 侧订阅同一个名字（spec §16 的 onEvent）。
export const RESEARCH_EVENT_CHANNEL = "research:event";

// 准入闸与两个错误类型已移到 ./consumer-gate（QuickRetrieval 与本服务共用一份判定，
// 两份拷贝漂移的后果是「某条路径绕过了用户明确关掉的开关」）。此处原样 re-export，
// 既有 import 路径不变。
export {
  ResearchDisabledError,
  SearchServerNotConfiguredError,
} from "./consumer-gate";

/// 事件接收方的最小面。真实类型是 Electron.WebContents，
/// 收窄成三个方法是为了让测试用 20 行的手写替身就能覆盖广播与回收逻辑。
export interface ResearchEventSender {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", listener: () => void): void;
}

/// Worker 提供方。ensure 负责"没起就起、起了就复用"，stop 负责优雅停机。
export interface ResearchWorkerProvider {
  ensure(): Promise<ResearchWorkerLike>;
  stop(): Promise<void>;
}

/// 可选的 blob GC 能力（删 Session 后回收无引用正文，spec §19.3.4）。
export interface BlobStoreLike extends BlobWriterLike {
  gcOrphanBlobs?(referencedHashes: ReadonlySet<string>): Promise<number>;
}

/// 服务依赖。全部注入，没有任何模块级单例——同一进程里可以并存多个实例（测试正是如此）。
export interface ResearchServiceDeps {
  repository: ResearchRepository;
  blobStore: BlobStoreLike;
  /// 读当前设置快照（每次调用都重读，设置页改动立即生效）。
  settings: () => ResearchEngineSettings;
  /// 按当前设置构造搜索客户端；未配置返回 null。
  createSearchClient: () => SearchClientLike | null;
  workerProvider: ResearchWorkerProvider;
  /// KTD9 的隔离键（当前用户/工作区）。
  userScope: () => string;
  now?: () => Date;
  newId?: () => string;
  blockedDomains?: () => readonly string[];
  agentBrowserBinary?: () => string | null;
  /// 服务端 stealth 抓取客户端的工厂。**每次现取**：用户可能在两次研究之间改了
  /// Search Server 配置（地址 / 令牌），缓存一个实例会让新配置到下次重启才生效。
  /// 返回 null = 该路径不可用，编排层行为与从前一致（只发一轮 fetch_prepare）。
  createStealthFetchClient?: () => StealthFetchLike | null;
  /// P7：按 Session 装配 LLM 能力（Planner / Report Generator）。返回 null 表示不接 LLM，
  /// 编排层沿用确定性的种子计划 + 单轮 + 证据摘要。
  ///
  /// **为什么由外部注入而不是 service 自己 new**：provider 配置与 apiKey 属于设置层，
  /// service 不该知道它们；装配点见 planner/llm-hooks.ts 的 createResearchLlmHooks。
  llmHooks?: (input: { summary: ResearchSessionSummary }) => ResearchLlmHooks | null;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
  /// U10：把已批准的候选落进用户记忆的 research 段（实现见 main/memory/research-memory.ts）。
  ///
  /// 注入而非直接 import：service 不该知道记忆文件在哪、长什么样；
  /// 也让测试可以只验「批准时调了 approve、拒绝/撤销时调了 revoke」而不碰文件系统。
  researchMemorySink?: {
    approve(
      candidate: MemoryCandidate,
      chunkIds: readonly string[],
      approvedAt: string,
    ): Promise<void>;
    revoke(candidateId: string): Promise<boolean>;
  };
  /// 报告归档：会话跑完后把报告写进所选项目目录（无项目落 Documents）。
  ///
  /// 与 researchMemorySink 同一注入范式：service 不该知道项目目录在哪、文件怎么命名。
  /// **入参只有 projectId 没有路径**——id → 目录的解析由注入实现在写盘时刻现查完成，
  /// 项目已被删除时自动退回 Documents（见 research/runtime.ts 与 report-archive.ts）。
  reportArchive?: {
    write(input: {
      sessionId: string;
      objective: string;
      markdown: string;
      projectId?: string;
    }): Promise<string>;
  };
}

/// 一次在途编排。
interface RunEntry {
  controller: AbortController;
  /// 中止意图：cancel 收敛到 cancelled，pause 收敛到 paused。
  intent: "cancel" | "pause";
  promise: Promise<void>;
}

interface ReportRegenerationEntry {
  controller: AbortController;
  promise: Promise<ResearchReport>;
}

/// CRE 的 main 侧门面。
export class ResearchService implements ResearchEngineFacade {
  private readonly running = new Map<string, RunEntry>();
  private readonly regeneratingReports = new Map<string, ReportRegenerationEntry>();
  private readonly senders = new Set<ResearchEventSender>();

  constructor(private readonly deps: ResearchServiceDeps) {}

  // ── Facade ───────────────────────────────────────────────────────────────

  async create(request: ResearchRequest): Promise<ResearchSessionSummary> {
    this.assertEnabled(request.consumer);
    const sessionId = this.newId();
    const budget = clampResearchBudget(request.mode, request.budget);

    const summary = await this.deps.repository.createSession({
      sessionId,
      consumer: request.consumer,
      objective: request.objective,
      mode: request.mode,
      sourceScopes: request.sourceScopes,
      output: request.output,
      budget,
      userScope: this.deps.userScope(),
      // 归属项目随会话落库：报告归档发生在几分钟后，那时用户可能已经切走了当前项目，
      // 所以必须记在会话上，而不是归档时再去问「现在选的是哪个项目」。
      ...(request.projectId ? { projectId: request.projectId } : {}),
      createdAt: this.nowIso(),
    });

    // 立刻落一份种子计划：ResearchPlan 是**预算的持久化载体**（仓储的 getSession 不返回
    // session 行上的预算），没有它，应用重启后就拿不回用户这次的预算覆盖。
    // P7 的 Initial Planner 落地后会直接覆盖这份计划。
    await this.deps.repository.savePlan(
      sessionId,
      buildSeedPlan({ objective: request.objective, mode: request.mode, budget }),
    );
    return summary;
  }

  /// 用同一批参数新建一个会话（终态会话的「重跑」）。
  ///
  /// **为什么是克隆而不是就地重置**：session-status 的转移表刻意把三个终态设成无出口，
  /// 理由写在那里——「想重跑只能新建 Session，这样报告与证据的因果链才不会被就地改写」。
  /// 就地擦掉 rounds / documents / report 再退回 created 会拆掉那条不变量：旧报告引用的
  /// 证据凭空消失，而那份报告可能已经被导出、被别处引用过。克隆则两全，旧会话原样留着。
  ///
  /// 参数**逐项继承**而不是取默认值：来源范围、输出要求、预算任一项悄悄换掉，
  /// 都会让「重跑」变成「跑了个不一样的东西」，而用户完全看不出来。
  async rerun(sessionId: string): Promise<ResearchSessionSummary> {
    const view = await this.deps.repository.getSession(sessionId, "full");
    if (!view) throw new Error(`未知的研究 Session：${sessionId}`);

    const status = view.summary.status;
    if (!TERMINAL_RESEARCH_STATUSES.includes(status as (typeof TERMINAL_RESEARCH_STATUSES)[number])) {
      // 还在跑（或已暂停）的会话没有「重跑」的语义：该用 cancel / resume。
      throw new Error(`只有已结束的研究才能重跑，当前状态：${status}`);
    }

    return this.create({
      consumer: view.summary.consumer,
      objective: view.summary.objective,
      mode: view.summary.mode,
      // 来源范围缺失只可能是旧数据；退回 public_web 是这里唯一的猜测，
      // 且它是最小权限的那一档（不含 memory / 本地文件）。
      sourceScopes: [...(view.sourceScopes ?? [{ kind: "public_web" as const }])],
      output: view.output ?? { format: "report", requireCitations: true },
      // 预算存在 plan 上（session 行不回传预算，见 create 里的注释）。
      ...(view.plan?.budget ? { budget: view.plan.budget } : {}),
      // 归属项目同样逐项继承：漏了它，重跑的报告会归档到别处（多半是 Documents），
      // 用户在项目目录里只能看到第一次的那份。
      ...(view.projectId ? { projectId: view.projectId } : {}),
    });
  }

  async regenerateReport(sessionId: string): Promise<ResearchReport> {
    const existing = this.regeneratingReports.get(sessionId);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const promise = this.generateReplacementReport(sessionId, controller.signal)
      .finally(() => {
        // Session 本身始终保持 completed；复用 done 事件让所有 renderer 清掉流式草稿并
        // 重拉 full 详情。失败时重拉到的仍是旧报告。
        this.broadcast({ type: "done", sessionId, status: "completed" });
      })
      .finally(() => {
        if (this.regeneratingReports.get(sessionId)?.controller === controller) {
          this.regeneratingReports.delete(sessionId);
        }
      });
    this.regeneratingReports.set(sessionId, { controller, promise });
    return promise;
  }

  /// 启动一次编排。**启动即返回，不等编排跑完**。
  ///
  /// 为什么不能 await 到底（真实踩过）：renderer 的「新建 → 开始」是一次 ipcRenderer.invoke，
  /// 挂到编排结束才 resolve 的话，会话在那几分钟里根本进不了渲染端的列表，而 ui-store 会把
  /// 「不在列表里的会话」的事件全部丢弃——用户看到的就是「点了开始，页面毫无反应」。
  ///
  /// 代价是启动之后的失败没人 await 得到，因此分成两段：
  /// **启动前能判定的失败**（未开启 / 搜索服务未配置 / 未知会话）在这里同步抛回 renderer；
  /// **启动后的失败**由 execute 兜底，转成 error(terminal) + done(failed) 事件广播。
  async run(sessionId: string): Promise<void> {
    const summary = await this.requireSummary(sessionId);
    this.assertEnabled(summary.consumer);

    // 单飞：已有在途编排就直接返回（不再 await 别人那一轮，语义同样是「已启动」）。
    if (this.running.has(sessionId)) return;

    // 搜索客户端在这里现取而不是留给 execute：它是「配置没填」这一类可预判失败的唯一来源，
    // 放到后台去抛的话，用户点完开始只会得到一个静静停在 created 的会话。
    const searchClient = this.deps.createSearchClient();
    if (!searchClient) throw new SearchServerNotConfiguredError();

    const controller = new AbortController();
    const entry: RunEntry = { controller, intent: "cancel", promise: Promise.resolve() };
    // 先入注册表再启动：否则"启动过程中的第二次 run"会看到空注册表而重复起一轮。
    this.running.set(sessionId, entry);

    entry.promise = this.execute(summary, entry, searchClient).finally(() => {
      // 竞态守卫：只有仍是自己这一轮时才摘条目，避免把后来者的注册表项误删
      //（照 capabilities/agent-browser/runtime.ts 的 this.controller === controller 写法）。
      if (this.running.get(sessionId) === entry) this.running.delete(sessionId);
    });
    // 没人 await 这个 promise 时，它的 rejection 会变成 unhandledRejection 把主进程刷屏。
    // execute 内部已经把失败转成事件了，这里只需要标记为「已处理」。
    entry.promise.catch(() => undefined);
  }

  /// 等某个 Session 当前这一轮编排收敛（无在途则立即返回）。
  /// 给关停流程与测试用；**产品代码不要用它来等研究结束**，那是 onEvent 的职责。
  async settled(sessionId: string): Promise<void> {
    await this.running.get(sessionId)?.promise.catch(() => undefined);
  }

  async pause(sessionId: string): Promise<void> {
    const entry = this.running.get(sessionId);
    if (entry) {
      entry.intent = "pause";
      entry.controller.abort();
      await entry.promise.catch(() => undefined);
      return;
    }
    // 没有在途编排时只做状态转移；非法转移（例如对 created 暂停）由状态机拒绝。
    const state = await this.stateWriter(sessionId);
    await state.to("paused");
  }

  async resume(sessionId: string): Promise<void> {
    const summary = await this.requireSummary(sessionId);
    this.assertEnabled(summary.consumer);
    // paused 只能先回到 interrupted（core 的转移表如此），再由 run 从 interrupted 续跑。
    // 这样"暂停后恢复"与"崩溃后恢复"共用同一段续跑代码，不留第二条容易漏测的路径。
    if (summary.status === "paused") {
      const state = await this.stateWriter(sessionId);
      await state.to("interrupted");
    }
    await this.run(sessionId);
  }

  async cancel(sessionId: string): Promise<void> {
    const entry = this.running.get(sessionId);
    if (entry) {
      entry.intent = "cancel";
      entry.controller.abort();
      // 等编排自己收尾：终态由它写（spec §19.1.3 要求终态一定是 cancelled）。
      await entry.promise.catch(() => undefined);
      return;
    }
    const state = await this.stateWriter(sessionId);
    await state.forceTo("cancelled");
    this.broadcast({ type: "done", sessionId, status: "cancelled" });
  }

  async get(sessionId: string, detail: ResearchDetailLevel): Promise<ResearchSessionView> {
    // summary 层级直接透传仓储的单行查询路径：**不读正文、不读 blob**（spec §19.3.2、§19.4）。
    const view = await this.deps.repository.getSession(sessionId, detail);
    if (!view) throw new Error(`未知的研究 Session：${sessionId}`);
    return view;
  }

  async list(filter?: ResearchSessionFilter): Promise<ResearchSessionSummary[]> {
    return this.deps.repository.listSessions(filter as ResearchSessionQuery | undefined);
  }

  async delete(sessionId: string): Promise<void> {
    const entry = this.running.get(sessionId);
    if (entry) {
      entry.controller.abort();
      await entry.promise.catch(() => undefined);
    }
    const regeneration = this.regeneratingReports.get(sessionId);
    if (regeneration) {
      regeneration.controller.abort();
      await regeneration.promise.catch(() => undefined);
    }
    await this.deps.repository.deleteSession(sessionId);
    await this.collectGarbage();
  }

  // ── 事件广播 ─────────────────────────────────────────────────────────────

  /// 注册一个渲染进程接收方。**幂等**：同一个 sender 重复注册只保留一份，
  /// 否则窗口每次订阅都会让它多收一份事件。
  addEventSender(sender: ResearchEventSender): void {
    if (sender.isDestroyed() || this.senders.has(sender)) return;
    this.senders.add(sender);
    // renderer 只 reload 不关窗时，旧 WebContents 会被销毁但引用还挂在这里；
    // 监听 destroyed 主动回收，避免注册表随刷新次数无限增长。
    sender.once("destroyed", () => this.senders.delete(sender));
  }

  /// 广播一条研究事件（不含正文，spec §16）。
  broadcast(event: ResearchEvent): void {
    for (const sender of [...this.senders]) {
      if (sender.isDestroyed()) {
        this.senders.delete(sender);
        continue;
      }
      try {
        sender.send(RESEARCH_EVENT_CHANNEL, event);
      } catch (err) {
        // 单个 sender 失败不能中断整轮广播（它可能正处于销毁竞态中）。
        this.deps.logger?.warn("[research] 事件推送失败", err);
      }
    }
  }

  /// 停掉 Worker（应用退出 / 用户关闭总开关时调用）。
  async shutdown(): Promise<void> {
    for (const entry of this.running.values()) entry.controller.abort();
    for (const entry of this.regeneratingReports.values()) entry.controller.abort();
    await Promise.allSettled([...this.running.values()].map((entry) => entry.promise));
    await Promise.allSettled([...this.regeneratingReports.values()].map((entry) => entry.promise));
    await this.deps.workerProvider.stop();
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private async generateReplacementReport(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<ResearchReport> {
    const view = await this.deps.repository.getSession(sessionId, "evidence");
    if (!view) throw new Error(`未知的研究 Session：${sessionId}`);
    this.assertEnabled(view.summary.consumer);
    if (view.summary.status !== "completed") {
      throw new Error(`只有已完成的研究才能重新生成报告，当前状态：${view.summary.status}`);
    }
    if (!view.plan) throw new Error("研究计划缺失，无法重新生成报告");
    if (!view.chunks || view.chunks.length === 0 || !view.documents) {
      throw new Error("研究证据缺失，无法重新生成报告");
    }

    const hooks = this.deps.llmHooks?.({ summary: view.summary }) ?? null;
    if (!hooks) throw new Error("研究模型不可用，已保留原报告");
    const spent = await this.deps.repository.getBudgetSpend(sessionId);
    const remainingEvidenceChars =
      view.plan.budget.maxEvidenceCharsToModel - spent.evidenceCharsToModel;
    if (remainingEvidenceChars <= 0) {
      throw new Error("本次研究的证据出站预算已用尽，已保留原报告");
    }
    const regenerationPlan = {
      ...view.plan,
      budget: {
        ...view.plan.budget,
        maxEvidenceCharsToModel: remainingEvidenceChars,
      },
    };
    const generatedAt = this.nowIso();
    const generated = await hooks.generateReport({
      plan: regenerationPlan,
      chunks: view.chunks,
      documents: view.documents,
      coverage: view.coverage ?? [],
      rounds: view.rounds ?? [],
      signal,
      onDelta: (delta) =>
        this.broadcast({ type: "report_delta", sessionId, delta }),
    });
    const output = typeof generated === "string" ? { markdown: generated } : generated;
    if (output.generationStats?.usedFallback) {
      const promptEvidenceChars = output.generationStats.promptEvidenceChars;
      if (promptEvidenceChars > 0) {
        // 模型调用失败也可能已经把证据发出去了。报告必须保留旧版，但隐私预算按实际
        // 出站量记账，否则反复点击可不断复用同一份“剩余额度”绕过 Session 硬上限。
        const failedOperationId = `op_${this.newId()}_report_regenerate_failed`;
        await this.deps.repository.beginOperation({
          operationId: failedOperationId,
          sessionId,
          kind: "report",
          requestPayloadHash: `regenerate-failed:${sessionId}:${generatedAt}`,
          createdAt: generatedAt,
        });
        await this.deps.repository.commitOperation(
          failedOperationId,
          (tx) => tx.consumeBudget({ evidenceCharsToModel: promptEvidenceChars }),
          generatedAt,
        );
      }
      throw new Error("报告模型调用失败，已保留原报告");
    }
    const validated = validateResearchReport({
      markdown: output.markdown,
      chunks: view.chunks,
      documents: view.documents,
      generatedAt,
    }).report;
    const report: ResearchReport = {
      ...validated,
      ...(output.generationStats ? { generationStats: output.generationStats } : {}),
    };

    const operationId = `op_${this.newId()}_report_regenerate`;
    await this.deps.repository.beginOperation({
      operationId,
      sessionId,
      kind: "report",
      requestPayloadHash: `regenerate:${sessionId}:${generatedAt}`,
      createdAt: generatedAt,
    });
    await this.deps.repository.commitOperation(
      operationId,
      (tx) => {
        tx.insertReport(report);
        tx.insertCitations(report.citations);
        tx.consumeBudget({
          evidenceCharsToModel: report.generationStats?.promptEvidenceChars ?? 0,
        });
      },
      generatedAt,
    );
    return report;
  }

  /// 真正跑一轮编排。Worker 按需装配——总开关关闭时根本走不到这里，
  /// 因此"不起 worker"是结构性保证而不是靠 if 记得写。
  ///
  /// **失败必须自己收口**：run 已经返回，没有任何调用方在 await 这个 promise，
  /// 异常若只是往上抛就等于凭空消失，会话会永远停在 created/planning 且界面上零线索。
  private async execute(
    summary: ResearchSessionSummary,
    entry: RunEntry,
    searchClient: SearchClientLike,
  ): Promise<void> {
    try {
      await this.orchestrate(summary, entry, searchClient);
      // 报告归档（D8）：编排成功返回即代表报告已落库，此时才有正文可写盘。
      // 放在记忆沉淀之前——归档是用户直接感知的产物，沉淀是可选的派生物，
      // 前者不该排在后者后面等着。同样自带 try/catch（见方法内注释）。
      await this.archiveReport(summary.sessionId);
      // 记忆沉淀（U10）：编排成功返回即代表会话已 completed，此时报告已落库。
      //
      // **必须包在自己的 try 里**：沉淀是可选的派生产物（候选可再生），
      // 它失败绝不能把一次成功的研究翻成失败——那会让用户丢掉真正想要的报告。
      await this.distillMemoryCandidates(summary.sessionId);
    } catch (err) {
      await this.failSession(summary.sessionId, err);
    }
  }

  /// 把已完成会话的报告归档到所选项目目录（D8）。
  ///
  /// **整个方法自己吞掉异常**：归档最常见的失败是项目目录被删或没有写权限，
  /// 而此刻用户真正想要的报告已经安全落在 SQLite 里了。让归档失败把会话翻成 failed，
  /// 等于因为一个副产物丢掉主产物——所以这里只 warn，绝不向上抛。
  ///
  /// 只在 completed 时归档：pause / cancel 收敛的会话没有成品报告，
  /// 把半成品写进用户的项目目录是噪音。
  private async archiveReport(sessionId: string): Promise<void> {
    const archive = this.deps.reportArchive;
    if (!archive) return;
    try {
      const view = await this.deps.repository.getSession(sessionId, "full");
      if (!view || view.summary.status !== "completed") return;
      const markdown = view.report?.markdown;
      if (!markdown) return;

      const path = await archive.write({
        sessionId,
        objective: view.summary.objective,
        markdown,
        ...(view.projectId ? { projectId: view.projectId } : {}),
      });
      this.deps.logger?.info?.("[research] 报告已归档", sessionId, path);
    } catch (err) {
      this.deps.logger?.warn("[research] 报告归档失败（不影响会话状态）", sessionId, err);
    }
  }

  // ── U10：记忆候选的读取与审阅 ─────────────────────────────────────────────

  /// 列出记忆候选（可按状态筛选）。
  async listMemoryCandidates(status?: MemoryCandidate["status"]): Promise<MemoryCandidateView[]> {
    return this.deps.repository.listMemoryCandidates(status);
  }

  /// 审阅一条候选。**这里是 KTD10 的唯一执行点**。
  ///
  /// 三个动作与状态的对应刻意收窄（renderer 传不了任意 status，见 ipc/research.ts 的 schema）：
  ///   - approve：pending/rejected/revoked → approved，**并真正写进 Memory**；
  ///   - reject ：→ rejected，不碰 Memory；
  ///   - revoke ：→ revoked，**按 candidateId 精确删除**已写入的那条（不做文本模糊匹配）。
  ///
  /// 先流转状态再写 Memory：写入函数会核对 status === "approved"，
  /// 顺序反过来的话那道核对就永远不成立，等于把红线检查写成了死代码。
  async reviewMemoryCandidate(
    candidateId: string,
    action: "approve" | "reject" | "revoke",
  ): Promise<void> {
    const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "revoked";
    const at = this.nowIso();
    await this.deps.repository.updateMemoryCandidateStatus(candidateId, status, at);

    const sink = this.deps.researchMemorySink;
    // 没有 sink（测试替身 / 记忆模块未初始化）时只流转状态，不写盘。
    if (!sink) return;

    if (action === "approve") {
      const view = (await this.deps.repository.listMemoryCandidates("approved")).find(
        (item) => item.candidate.candidateId === candidateId,
      );
      if (!view) return;
      await sink.approve(view.candidate, view.candidate.citationChunkIds, at);
      return;
    }
    // reject 与 revoke 都要确保它不在 Memory 里：用户可能先批准、再拒绝。
    await sink.revoke(candidateId);
  }

  /// 从已完成会话的报告归纳待批记忆候选。
  ///
  /// 开关关闭（默认）时什么都不做——这是**默认不产生副作用**的能力，
  /// 用户没打开「记忆沉淀」就不该有任何东西被提议写进他的长期记忆。
  private async distillMemoryCandidates(sessionId: string): Promise<void> {
    if (this.deps.settings().memoryEnabled !== true) return;
    try {
      // evidence 级别：collectTrustZones 需要 chunk 的信任区。
      const view = await this.deps.repository.getSession(sessionId, "evidence");
      if (!view) return;
      const { items, candidates } = extractKnowledgeFromReport({ view });
      if (candidates.length === 0) return;
      await this.deps.repository.saveKnowledgeAndCandidates({ sessionId, items, candidates });
      this.deps.logger?.info?.(`[research] 沉淀 ${candidates.length} 条待批记忆候选`, sessionId);
    } catch (err) {
      this.deps.logger?.warn("[research] 记忆沉淀失败（不影响报告）", sessionId, err);
    }
  }

  /// 装配编排器并跑一轮。编排器内部的失败由它自己 settle（写 failed + 发事件）后再抛出，
  /// 抛到 execute 的多是**编排开始之前**的失败（Worker 拉不起来、LLM 装配失败等）。
  private async orchestrate(
    summary: ResearchSessionSummary,
    entry: RunEntry,
    searchClient: SearchClientLike,
  ): Promise<void> {
    const sessionId = summary.sessionId;
    const worker = await this.deps.workerProvider.ensure();

    // LLM 注入项按 Session 装配：provider 快照在一次编排内保持稳定，
    // 用户中途改设置不会让同一个 Session 的前后两次调用发往不同供应商。
    const hooks = this.deps.llmHooks?.({ summary }) ?? null;

    const orchestrator = new ResearchOrchestrator({
      repository: this.deps.repository,
      blobStore: this.deps.blobStore,
      searchClient,
      worker,
      userScope: this.deps.userScope(),
      emit: (event) => this.broadcast(event),
      abortIntent: () => entry.intent,
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.newId ? { newId: this.deps.newId } : {}),
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      ...(this.deps.blockedDomains ? { blockedDomains: this.deps.blockedDomains() } : {}),
      ...(this.deps.agentBrowserBinary?.()
        ? { agentBrowserBinary: this.deps.agentBrowserBinary()! }
        : {}),
      ...(() => {
        const stealth = this.deps.createStealthFetchClient?.();
        return stealth ? { stealthFetch: stealth } : {};
      })(),
      ...(hooks
        ? {
            planInitial: hooks.planInitial,
            planGap: hooks.planGap,
            generateReport: hooks.generateReport,
          }
        : {}),
    });
    await orchestrator.run(sessionId, entry.controller.signal);
  }

  /// 把一次「没人 await 得到」的失败落成终态并广播出去。
  ///
  /// 已经是终态的会话（编排器自己 settle 过）不重复写：forceTo 会因终态无出口而抛错，
  /// 那正好说明状态已经落定，此时只补事件是错的——会话可能已经 cancelled，不该再报 failed。
  private async failSession(sessionId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.deps.logger?.warn("[research] 编排启动失败", sessionId, message);
    try {
      const view = await this.deps.repository.getSession(sessionId, "summary");
      const status = view?.summary.status;
      if (!status || TERMINAL_RESEARCH_STATUSES.includes(status as (typeof TERMINAL_RESEARCH_STATUSES)[number])) {
        return;
      }
      const state = await this.stateWriter(sessionId);
      await state.forceTo("failed", message);
      this.broadcast({ type: "error", sessionId, code: "research_failed", message, terminal: true });
      this.broadcast({ type: "done", sessionId, status: "failed" });
    } catch (settleError) {
      this.deps.logger?.warn("[research] 失败收尾写入失败", sessionId, settleError);
    }
  }

  /// 总开关 + Consumer 灰度开关。判定实现在 ./consumer-gate（与 QuickRetrieval 共用）。
  private assertEnabled(consumer: ResearchConsumer): void {
    assertResearchEnabled(this.deps.settings(), consumer);
  }

  private async requireSummary(sessionId: string): Promise<ResearchSessionSummary> {
    const view = await this.deps.repository.getSession(sessionId, "summary");
    if (!view) throw new Error(`未知的研究 Session：${sessionId}`);
    return view.summary;
  }

  /// 构造一个「每次状态落库都会广播」的状态写入器。
  ///
  /// onStatus 是状态变更广播的**唯一单点**：漏传它的那条路径（此前的 pause）就会出现
  /// 「main 已经改了状态，renderer 却要等下一次 list() 才知道」的漂移。
  private async stateWriter(sessionId: string): Promise<SessionStateWriter> {
    const summary = await this.requireSummary(sessionId);
    return new SessionStateWriter(this.deps.repository, sessionId, summary.status, {
      ...(this.deps.now ? { now: this.deps.now } : {}),
      onStatus: (status) => this.broadcast({ type: "status", sessionId, status }),
    });
  }

  /// 回收无引用的正文 blob（best-effort：GC 失败不该让删除操作失败）。
  private async collectGarbage(): Promise<void> {
    if (!this.deps.blobStore.gcOrphanBlobs) return;
    try {
      const referenced = await this.deps.repository.listReferencedContentHashes();
      await this.deps.blobStore.gcOrphanBlobs(referenced);
    } catch (err) {
      this.deps.logger?.warn("[research] blob 回收失败", err);
    }
  }

  private newId(): string {
    return this.deps.newId ? this.deps.newId() : globalThis.crypto.randomUUID();
  }

  private nowIso(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }
}
