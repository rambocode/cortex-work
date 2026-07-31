// 语气蒸馏接线（U10 / R10、R11）：写回成功 → 采样 →（学习开关开）后台模型直连蒸馏（温度 0.2）→
// 清洗 → 覆盖分区 auto 区 → 持久化（仅要点落盘，样本不落盘，KTD8）。
// KTD6 修订：持久化 sink 已从「回推渲染端 store 落盘」改为直写 main-owned memory-store
// （persistLearned 由 index.ts 注入直写 + reply:memoryChanged 推送渲染端刷新缓存）。
//
// 与源项目（ReplyClone AppState.learnFromAcceptedDraft / distillMemory）的差异：
//   - 样本采集扩充为「当次对话『我：』侧样本 + 已接受草稿」（源项目只采纳草稿一条）；
//   - 样本仅内存驻留、不落盘（KTD8 隐私边界收紧），只有蒸馏产出的 auto 要点经 store 分片持久化；
//   - 单飞：蒸馏进行中再次写回 → 排队合并（把新样本并进队列，当前轮结束后再蒸馏），绝不并发；
//   - 蒸馏失败 / 生成模型未配置 / 清洗后为空 → 一律静默（学习是锦上添花，不打扰主流程），下次写回再试。
//
// 分区路由（channelScopeForCapturedApp）与 prompt 注入路由一致：自动样本只落 im/email 两个分区，
// publicVoice 本期不自动命中（Scope Boundaries）。

import {
  appendSample,
  buildDistillPrompt,
  channelScopeForCapturedApp,
  cleanDistilledRules,
  type DistillPrompt,
  type MemoryScope,
} from "@cortex-work/core/reply/memory";
import type { ReplySyncSnapshot } from "../ipc/reply-types";
// 仅类型：DraftAcceptedInfo 随 controller 写回成功回调传入（type import 编译期擦除，不牵入 electron 依赖链）。
import type { DraftAcceptedInfo } from "./controller";

/** 会话文稿里「我：」侧消息的前缀（与 ConversationLayoutBuilder 渲染契约一致，全角冒号）。 */
const MINE_PREFIX = "我：";

/**
 * 从会话文稿抽取「我：」侧样本：逐行取以 `我：` 开头的行、剥前缀、去空白，空行丢弃。
 * AX 原文（无「我/对方」结构）自然抽不出样本，此时只有被采纳草稿入队——安全降级。
 */
export function extractMineSamples(conversation: string): string[] {
  const out: string[] = [];
  for (const raw of conversation.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(MINE_PREFIX)) continue;
    const body = line.slice(MINE_PREFIX.length).trim();
    if (body.length > 0) out.push(body);
  }
  return out;
}

/** 蒸馏器依赖注入口（单测注入假 generate / persist / snapshot，隔离 electron 与网络）。 */
export interface ReplyDistillerDeps {
  /** 读渲染端最近推送的设置快照（学习开关 / userProfile；KTD6 修订后不再携带 memory）。 */
  getSnapshot: () => ReplySyncSnapshot | null;
  /** 读某分区已学到的 auto 要点（KTD6 修订：main-owned memory-store，蒸馏合并旧规则用）。 */
  getExistingAuto: (scope: MemoryScope) => Promise<string>;
  /**
   * 后台跑蒸馏 prompt（模型直连单发，返回原始文本）。
   * 由 index.ts 注入的闭包内部解析生成模型（resolveReplyModel）并经 Pi Model Gateway 出站（温度 0.2）；
   * 生成模型未配置时应 throw（被本模块 catch 后静默跳过，不打扰）。
   */
  generate: (prompt: DistillPrompt) => Promise<string>;
  /** 持久化 sink：把某分区蒸馏产出的 auto 要点直写 memory-store（并推送渲染端刷新缓存）。 */
  persistLearned: (scope: MemoryScope, auto: string) => void;
  logger?: { warn(...args: unknown[]): void };
}

/**
 * 语气蒸馏编排器。controller.onDraftAccepted → onDraftAccepted：采样入队 → 触发后台蒸馏。
 * 单飞由 running 标志 + pending 分区集合保证：进行中不并发，结束后自动续跑仍有待办的分区。
 */
export class ReplyDistiller {
  private readonly deps: ReplyDistillerDeps;
  // 各分区内存样本队列（KTD8：不落盘，进程退出即弃）。仅 im/email 会被写入。
  private readonly samples = new Map<MemoryScope, string[]>();
  // 本地最新 auto 覆盖：蒸馏成功后即时记下，供下一轮合并——无需等渲染端回推快照，保证连续蒸馏正确累积。
  private readonly localAuto = new Map<MemoryScope, string>();
  // 单飞：是否有蒸馏正在进行。进行中的新写回只把分区标记进 pending，不并发起第二个蒸馏。
  private running = false;
  // 待蒸馏分区集合（去重）；drain 逐个消费，消费时读队列最新样本，实现「排队合并」。
  private readonly pending = new Set<MemoryScope>();

  constructor(deps: ReplyDistillerDeps) {
    this.deps = deps;
  }

  /**
   * 失效本地 auto 覆盖（「立即重新学习」整体重建 auto 后调用）：否则下一轮后台蒸馏会以
   * 重学前的陈旧 localAuto 作为 existingAuto 合并，静默吞掉重学产出。
   */
  resetLocalAuto(): void {
    this.localAuto.clear();
  }

  /**
   * 写回成功回调入口（controller.onDraftAccepted）。学习开关关闭 → 直接返回，零副作用（不采样、不蒸馏）。
   * 开启时按捕获应用类别路由分区，采「我：」侧样本 + 已接受草稿入队，随后触发（或排队）后台蒸馏。
   */
  onDraftAccepted(info: DraftAcceptedInfo): void {
    const snapshot = this.deps.getSnapshot();
    // 学习开关关闭（或快照缺失）→ 零副作用。这是 R11 隐私开关的硬门控。
    if (!snapshot || !snapshot.settings.learningEnabled) return;

    const scope = channelScopeForCapturedApp({
      bundleId: info.appBundleId,
      name: info.appName,
    });
    let queue = this.samples.get(scope) ?? [];
    // 先并入本次对话「我：」侧样本，再并入被采纳草稿（appendSample 内含空白过滤 + FIFO 上限）。
    for (const sample of extractMineSamples(info.conversation)) {
      queue = appendSample(queue, sample);
    }
    queue = appendSample(queue, info.draft);
    this.samples.set(scope, queue);

    this.enqueue(scope);
  }

  /** 把分区标记为待蒸馏；无进行中任务则启动 drain，否则等当前轮结束自动续跑（单飞）。 */
  private enqueue(scope: MemoryScope): void {
    this.pending.add(scope);
    if (this.running) return;
    void this.drain();
  }

  /** 串行消费 pending 分区，逐个蒸馏（同一时刻只有一个蒸馏在途）。 */
  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending.size > 0) {
        // 取集合中任意一个（插入序），消费前移除；期间新写回会把它重新加回 pending 触发再蒸馏。
        const scope = this.pending.values().next().value as MemoryScope;
        this.pending.delete(scope);
        await this.distillScope(scope);
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * 蒸馏单个分区：读队列样本 + 现有 auto → 蒸馏 prompt → 模型直连 → 清洗 → 覆盖 auto 并持久化。
   * 任一环节不满足（无样本 / 开关已关 / 生成失败 / 清洗后为空）→ 静默保留旧规则，不抛。
   */
  private async distillScope(scope: MemoryScope): Promise<void> {
    const samples = this.samples.get(scope) ?? [];
    if (samples.length === 0) return;

    // 蒸馏可能排队若干秒，期间用户可能关掉学习开关：起跑前再确认一次，关了就停（尊重隐私开关）。
    const snapshot = this.deps.getSnapshot();
    if (!snapshot || !snapshot.settings.learningEnabled) return;

    try {
      // 现有 auto 以本地覆盖优先（连续蒸馏时无需等落盘往返即可累积），回落 memory-store 读取。
      const existingAuto = this.localAuto.get(scope) ?? (await this.deps.getExistingAuto(scope));
      const prompt = buildDistillPrompt(scope, samples, existingAuto);
      const output = await this.deps.generate(prompt);
      const rules = cleanDistilledRules(output);
      // 清洗后为空（模型只吐解释 / 空白）→ 保留旧规则，不覆盖。
      if (rules.length === 0) return;
      this.localAuto.set(scope, rules);
      this.deps.persistLearned(scope, rules);
    } catch (err) {
      // 生成失败 / 生成模型未配置：静默放弃（学习锦上添花），下次写回再试。
      this.deps.logger?.warn("[reply] 语气蒸馏失败", err);
    }
  }
}
