// ResearchEngineFacade 的 main 侧实现（spec §7.2、§16）：Session 注册表 + 事件广播 +
// Worker 生命周期。
//
// 定位：这是 CRE 对所有 Consumer 的**唯一入口**。它刻意不暴露任意 URL fetch、任意 Worker
// method、数据库句柄或本地路径——IPC 层只能调这 8 个方法。
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
  ModelDataPolicy,
  ResearchConsumer,
  ResearchDetailLevel,
  ResearchEngineFacade,
  ResearchEvent,
  ResearchRequest,
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
import type { ResearchRepository, ResearchSessionQuery } from "./research-repository";
import { SessionStateWriter } from "./session-state";

/// 推送事件的 IPC 通道名。preload 侧订阅同一个名字（spec §16 的 onEvent）。
export const RESEARCH_EVENT_CHANNEL = "research:event";

/// 功能未开启。IPC 层据此回一个明确的提示，而不是让用户看到一条底层报错。
export class ResearchDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchDisabledError";
  }
}

/// 搜索服务未配置。与"未开启"分开：前者要去设置页填地址，后者只需打开开关。
export class SearchServerNotConfiguredError extends Error {
  constructor() {
    super("尚未配置研究搜索服务，请在设置中填写地址与凭据");
    this.name = "SearchServerNotConfiguredError";
  }
}

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
  llmHooks?: (input: {
    summary: ResearchSessionSummary;
    modelDataPolicy: ModelDataPolicy;
  }) => ResearchLlmHooks | null;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

/// 记不住 Session 策略时的**fail-closed 兜底**。
///
/// 兜底策略：**只在仓储也读不到时**才用（会话行已被删、或库损坏）。
///
/// 选 local_only 是 fail-closed：宁可 LLM 能力降级为确定性摘要，也不把用户当初只允许留在
/// 本机的正文发去云端。注意这条路径现在应当**极少**触发——正常读回走
/// repository.getSessionModelDataPolicy。曾经它是「进程重启后」的常规路径，
/// 副作用远超预期：用户选的 metadata_only 被当成 local_only，选型只在 loopback provider 里挑，
/// 挑中一个不是 chat 模型的本地模型，调用秒失败，Planner 与报告双双静默降级。
const FALLBACK_MODEL_DATA_POLICY: ModelDataPolicy = "local_only";

/// 各 Consumer 对应的灰度开关。coding / knowledge 暂无独立开关，跟随总开关（U9/U10 再拆）。
const CONSUMER_SWITCHES: Partial<Record<ResearchConsumer, keyof ResearchEngineSettings>> = {
  chat: "chatEnabled",
  deep_research: "deepResearchEnabled",
  slides: "slidesEnabled",
  writing: "writingEnabled",
};

/// 一次在途编排。
interface RunEntry {
  controller: AbortController;
  /// 中止意图：cancel 收敛到 cancelled，pause 收敛到 paused。
  intent: "cancel" | "pause";
  promise: Promise<void>;
}

/// CRE 的 main 侧门面。
export class ResearchService implements ResearchEngineFacade {
  private readonly running = new Map<string, RunEntry>();
  private readonly senders = new Set<ResearchEventSender>();
  /// sessionId → 本 Session 的出站策略。见 FALLBACK_MODEL_DATA_POLICY 的说明。
  private readonly policyBySession = new Map<string, ModelDataPolicy>();

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
      modelDataPolicy: request.modelDataPolicy,
      sourceScopes: request.sourceScopes,
      output: request.output,
      budget,
      userScope: this.deps.userScope(),
      createdAt: this.nowIso(),
    });

    // 立刻落一份种子计划：ResearchPlan 是**预算的持久化载体**（仓储的 getSession 不返回
    // session 行上的预算），没有它，应用重启后就拿不回用户这次的预算覆盖。
    // P7 的 Initial Planner 落地后会直接覆盖这份计划。
    await this.deps.repository.savePlan(
      sessionId,
      buildSeedPlan({ objective: request.objective, mode: request.mode, budget }),
    );
    this.policyBySession.set(sessionId, request.modelDataPolicy);
    return summary;
  }

  /// 用同一批参数新建一个会话（终态会话的「重跑」）。
  ///
  /// **为什么是克隆而不是就地重置**：session-status 的转移表刻意把三个终态设成无出口，
  /// 理由写在那里——「想重跑只能新建 Session，这样报告与证据的因果链才不会被就地改写」。
  /// 就地擦掉 rounds / documents / report 再退回 created 会拆掉那条不变量：旧报告引用的
  /// 证据凭空消失，而那份报告可能已经被导出、被别处引用过。克隆则两全，旧会话原样留着。
  ///
  /// 参数**逐项继承**而不是取默认值：来源范围、出站策略、输出要求、预算任一项悄悄换掉，
  /// 都会让「重跑」变成「跑了个不一样的东西」，而用户完全看不出来。
  async rerun(sessionId: string): Promise<ResearchSessionSummary> {
    const view = await this.deps.repository.getSession(sessionId, "full");
    if (!view) throw new Error(`未知的研究 Session：${sessionId}`);

    const status = view.summary.status;
    if (!TERMINAL_RESEARCH_STATUSES.includes(status as (typeof TERMINAL_RESEARCH_STATUSES)[number])) {
      // 还在跑（或已暂停）的会话没有「重跑」的语义：该用 cancel / resume。
      throw new Error(`只有已结束的研究才能重跑，当前状态：${status}`);
    }

    const policy =
      (await this.deps.repository.getSessionModelDataPolicy(sessionId)) ?? FALLBACK_MODEL_DATA_POLICY;

    return this.create({
      consumer: view.summary.consumer,
      objective: view.summary.objective,
      mode: view.summary.mode,
      // 来源范围缺失只可能是旧数据；退回 public_web 是这里唯一的猜测，
      // 且它是最小权限的那一档（不含 memory / 本地文件）。
      sourceScopes: [...(view.sourceScopes ?? [{ kind: "public_web" as const }])],
      modelDataPolicy: policy,
      output: view.output ?? { format: "report", requireCitations: true },
      // 预算存在 plan 上（session 行不回传预算，见 create 里的注释）。
      ...(view.plan?.budget ? { budget: view.plan.budget } : {}),
    });
  }

  async run(sessionId: string): Promise<void> {
    const summary = await this.requireSummary(sessionId);
    this.assertEnabled(summary.consumer);

    // 单飞：并发调用共享同一个 Promise，不会起第二个编排。
    const existing = this.running.get(sessionId);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const entry: RunEntry = { controller, intent: "cancel", promise: Promise.resolve() };
    // 先入注册表再启动：否则"启动过程中的第二次 run"会看到空注册表而重复起一轮。
    this.running.set(sessionId, entry);

    entry.promise = this.execute(summary, entry).finally(() => {
      // 竞态守卫：只有仍是自己这一轮时才摘条目，避免把后来者的注册表项误删
      //（照 capabilities/agent-browser/runtime.ts 的 this.controller === controller 写法）。
      if (this.running.get(sessionId) === entry) this.running.delete(sessionId);
    });
    return entry.promise;
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
    this.policyBySession.delete(sessionId);
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
    await Promise.allSettled([...this.running.values()].map((entry) => entry.promise));
    await this.deps.workerProvider.stop();
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  /// 真正跑一轮编排。Worker 与搜索客户端都在这里按需装配——
  /// 总开关关闭时根本走不到这里，因此"不起 worker"是结构性保证而不是靠 if 记得写。
  private async execute(summary: ResearchSessionSummary, entry: RunEntry): Promise<void> {
    const sessionId = summary.sessionId;
    const searchClient = this.deps.createSearchClient();
    if (!searchClient) throw new SearchServerNotConfiguredError();
    const worker = await this.deps.workerProvider.ensure();

    // LLM 注入项按 Session 装配：策略与 provider 快照在一次编排内保持稳定。
    // 策略优先取本进程缓存（本次运行内最快），缓存缺失（典型：重启后恢复一个已有 Session）
    // 时回仓储读回真值，两者都没有才 fail-closed —— 见 FALLBACK_MODEL_DATA_POLICY。
    const modelDataPolicy =
      this.policyBySession.get(sessionId) ??
      (await this.deps.repository.getSessionModelDataPolicy(sessionId)) ??
      FALLBACK_MODEL_DATA_POLICY;
    const hooks = this.deps.llmHooks?.({ summary, modelDataPolicy }) ?? null;

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

  /// 总开关 + Consumer 灰度开关。两者都通过才允许发起研究。
  private assertEnabled(consumer: ResearchConsumer): void {
    const settings = this.deps.settings();
    if (!settings.enabled) {
      throw new ResearchDisabledError("研究引擎未开启，请在设置中启用");
    }
    const key = CONSUMER_SWITCHES[consumer];
    if (key && settings[key] !== true) {
      throw new ResearchDisabledError(`该场景的研究能力未开启：${consumer}`);
    }
  }

  private async requireSummary(sessionId: string): Promise<ResearchSessionSummary> {
    const view = await this.deps.repository.getSession(sessionId, "summary");
    if (!view) throw new Error(`未知的研究 Session：${sessionId}`);
    return view.summary;
  }

  private async stateWriter(sessionId: string): Promise<SessionStateWriter> {
    const summary = await this.requireSummary(sessionId);
    return new SessionStateWriter(this.deps.repository, sessionId, summary.status, {
      ...(this.deps.now ? { now: this.deps.now } : {}),
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
