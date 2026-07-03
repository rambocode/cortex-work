// 对话级记忆蒸馏编排器：写回成功 →（学习开关开且 counterpart 可分桶）后台模型直连
// 蒸馏「关于对话对象的事实与偏好」→ 清洗 → 写回 conversation-store 的 summary。
//
// 独立于 ReplyDistiller（distill.ts）的原因：那边按 im/email 渠道分区学「用户怎么写」，
// 这边按对话分桶学「对这个人该怎么写」——采集目标、分桶键、持久化 sink 全都不同，
// 塞一起只会互相缠绕。单飞排队范式与其一致：进行中不并发，同 key 排队只留最新样本。
// 失败一律静默（学习锦上添花，不打扰主流程），下次写回再试。

import {
  buildConversationDistillPrompt,
  conversationKey,
} from "@cortex-work/core/reply/conversation-memory";
import { cleanDistilledRules, type DistillPrompt } from "@cortex-work/core/reply/memory";
import type { ReplySyncSnapshot } from "../ipc/reply-types";
// 仅类型：编译期擦除，不牵入 electron 依赖链（同 distill.ts 先例）。
import type { DraftAcceptedInfo } from "./controller";

/** 蒸馏产出的持久化参数（sink 由 index.ts 注入，落 conversation-store.setSummary）。 */
export interface ConversationSummaryUpdate {
  appBundleId: string;
  appName: string;
  counterpart: string;
  summary: string;
}

export interface ConversationLearnerDeps {
  /** 读渲染端最近推送的设置快照（学习开关门控）。 */
  getSnapshot: () => ReplySyncSnapshot | null;
  /** 后台跑蒸馏 prompt（模型直连单发，温度 0.2；未配置模型时 throw，被本模块静默捕获）。 */
  generate: (prompt: DistillPrompt) => Promise<string>;
  /** 读该对话已蒸馏的旧摘要（合并进 prompt，累积而非覆写认知）。 */
  getExistingSummary: (appBundleId: string, counterpart: string) => Promise<string>;
  /** 持久化 sink：清洗后的摘要写回 conversation-store。 */
  persistSummary: (update: ConversationSummaryUpdate) => Promise<void> | void;
  logger?: { warn(...args: unknown[]): void };
}

export class ConversationLearner {
  private readonly deps: ConversationLearnerDeps;
  // 单飞：是否有蒸馏在途。在途时新写回只更新 pending，不并发起第二个。
  private running = false;
  // 待蒸馏队列：key → 最新写回信息。同 key 重复写回只保留最新（排队合并，蒸馏最新样本即可）。
  private readonly pending = new Map<string, DraftAcceptedInfo>();

  constructor(deps: ConversationLearnerDeps) {
    this.deps = deps;
  }

  /** 写回成功回调入口。学习开关关闭或 counterpart 不可分桶 → 零副作用。 */
  onDraftAccepted(info: DraftAcceptedInfo): void {
    const snapshot = this.deps.getSnapshot();
    if (!snapshot?.settings.learningEnabled) return;
    const key = conversationKey(info.appBundleId, info.counterpart);
    if (!key) return;
    this.pending.set(key, info);
    if (this.running) return;
    void this.drain();
  }

  /** 串行消费 pending（同一时刻只有一个蒸馏在途）。 */
  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending.size > 0) {
        const key = this.pending.keys().next().value as string;
        const info = this.pending.get(key)!;
        this.pending.delete(key);
        await this.learn(info);
      }
    } finally {
      this.running = false;
    }
  }

  /** 蒸馏单个对话：合并旧摘要 → 模型直连 → 清洗 → 持久化。任一环节不满足则静默放弃。 */
  private async learn(info: DraftAcceptedInfo): Promise<void> {
    // 排队期间用户可能关掉学习开关：起跑前再确认一次。
    const snapshot = this.deps.getSnapshot();
    if (!snapshot?.settings.learningEnabled) return;

    try {
      const existing = await this.deps.getExistingSummary(info.appBundleId, info.counterpart);
      const prompt = buildConversationDistillPrompt({
        appName: info.appName,
        counterpart: info.counterpart,
        conversation: info.conversation,
        acceptedDraft: info.draft,
        existingSummary: existing,
      });
      const output = await this.deps.generate(prompt);
      const summary = cleanDistilledRules(output);
      // 清洗后为空（模型只吐解释）→ 保留旧摘要，不覆盖。
      if (summary.length === 0) return;
      await this.deps.persistSummary({
        appBundleId: info.appBundleId,
        appName: info.appName,
        counterpart: info.counterpart,
        summary,
      });
    } catch (err) {
      this.deps.logger?.warn("[reply] 对话记忆蒸馏失败", err);
    }
  }
}
