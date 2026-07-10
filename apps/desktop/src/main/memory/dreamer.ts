// 做梦编排器（Dreamer）：用户记忆的后台整理管线,模仿人类睡眠记忆固化——
//   采样（未消化的会话情景）→ 逐分区 LLM 蒸馏（提炼/合并/遗忘）→ 清洗 → 覆盖 auto 区
//   → 推进水位 → 记历史 → 通知渲染端刷新。
// 单飞语义平移 reply/distill.ts：进行中再次触发 → 置 pending,当前轮结束后自动补跑一轮,
// 绝不并发（防两轮做梦交错覆盖 auto 区与水位）。
//
// 失败与降级（核心不变量:失败绝不破坏现有记忆、绝不推进水位）：
//   - 记忆开关关闭 / 无新内容 → 静默返回,不动任何状态;
//   - LLM 供应商未配置（generate 抛错）→ 返回 model-not-configured,水位不动,下次再试;
//   - 任一分区蒸馏失败 → 整轮按失败处理（已成功写入的分区保留——蒸馏 prompt 的合并语义
//     使重复消化幂等）,水位不推进,记一条失败历史;
//   - 清洗后为空 → 该分区跳过（保留旧 auto）,不算失败。

import {
  USER_MEMORY_SCOPES,
  type DreamTrigger,
  type MemoryDreamResult,
  type UserMemoryScope,
} from "@cortex-work/core/memory/memory";
import {
  sampleUndigestedEpisodes,
  type EpisodicSessionInput,
} from "@cortex-work/core/memory/episodic";
import {
  buildDreamPrompt,
  cleanDreamedFacts,
  type DreamPrompt,
} from "@cortex-work/core/memory/dream-prompt";
import type { DreamStateStore } from "./dream-state";

/** 依赖注入口（单测注入假 generate / 存储,隔离 electron 与网络）。 */
export interface DreamerDeps {
  /// 记忆总开关（generalSettings.memoryEnabled,显式 false 才关）。关闭 → 做梦零副作用。
  isEnabled: () => Promise<boolean>;
  /// 读全部会话情景输入（main 侧 episodic-source 读盘）。
  getEpisodes: () => Promise<EpisodicSessionInput[]>;
  /// 读某分区当前 auto 区（蒸馏合并旧记忆用）。
  getExistingAuto: (scope: UserMemoryScope) => Promise<string>;
  /// 后台跑蒸馏 prompt（LLM 直连单发,温度 0.2）。供应商未配置时应 throw。
  generate: (prompt: DreamPrompt) => Promise<string>;
  /// 持久化 sink：把分区蒸馏产出写入 memory-store 的 auto 区。
  persistLearned: (scope: UserMemoryScope, auto: string) => Promise<void>;
  /// 水位与历史存储。
  stateStore: DreamStateStore;
  /// 做梦成功写入后通知（index.ts 注入 webContents.send("memory:changed")）。
  onMemoryChanged?: () => void;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

export class Dreamer {
  // 单飞：进行中标志 + 待补跑标记。触发来源不区分优先级,补跑一律按 idle 语义执行。
  private running = false;
  private pending = false;
  // 本地最新 auto 覆盖：同一轮内 persistLearned 尚未落盘完成时,下一分区合并以此为准
  // (同 reply distill 的 localAuto,防串行落盘的时间差导致旧值合并)。
  private readonly localAuto = new Map<UserMemoryScope, string>();

  constructor(private readonly deps: DreamerDeps) {}

  /**
   * 触发一次做梦整理。进行中再次触发 → 置 pending 并立即返回 in-flight
   * （当前轮结束后自动补跑,调用方无需重试）。
   */
  async dreamNow(trigger: DreamTrigger): Promise<MemoryDreamResult> {
    if (this.running) {
      this.pending = true;
      return { ok: false, error: "in-flight" };
    }
    this.running = true;
    try {
      return await this.runOnce(trigger);
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        // 补跑：fire-and-forget（触发方早已拿到 in-flight 返回）。
        void this.dreamNow(trigger);
      }
    }
  }

  // 单轮做梦全流程。见文件头的失败不变量。
  private async runOnce(trigger: DreamTrigger): Promise<MemoryDreamResult> {
    if (!(await this.deps.isEnabled())) return { ok: false, error: "disabled" };

    const state = await this.deps.stateStore.load();
    const inputs = await this.deps.getEpisodes();
    const { episodes, watermarks } = sampleUndigestedEpisodes(inputs, state.sources);
    if (episodes.length === 0) {
      // 没有新正文内容：纯噪音会话的水位仍要推进（否则每次做梦都重扫）,不记历史不刷 lastDreamAt。
      if (Object.keys(watermarks).length > 0) {
        await this.deps.stateStore.commit({ watermarks });
      }
      return { ok: true, sessionsScanned: 0, learnedScopes: 0 };
    }

    this.localAuto.clear();
    let learnedScopes = 0;
    try {
      for (const scope of USER_MEMORY_SCOPES) {
        const existingAuto = this.localAuto.get(scope) ?? (await this.deps.getExistingAuto(scope));
        const prompt = buildDreamPrompt(scope, episodes, existingAuto);
        const output = await this.deps.generate(prompt);
        const facts = cleanDreamedFacts(output);
        // 清洗后为空（该分区无可提炼信息 / 模型只吐解释）→ 保留旧 auto,不覆盖。
        if (facts.length === 0 || facts === existingAuto.trim()) continue;
        this.localAuto.set(scope, facts);
        await this.deps.persistLearned(scope, facts);
        learnedScopes += 1;
      }
    } catch (err) {
      // 任一分区失败 → 整轮失败：水位不推进（下次重试同批内容,合并语义幂等）,记失败历史。
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger?.warn("[memory] 做梦整理失败", err);
      await this.deps.stateStore.commit({
        watermarks: {},
        record: { at: Date.now(), trigger, sessionsScanned: episodes.length, learnedScopes, ok: false, error: message },
      });
      if (learnedScopes > 0) this.deps.onMemoryChanged?.();
      return { ok: false, sessionsScanned: episodes.length, learnedScopes, error: message };
    }

    // 全分区成功：推进水位 + 记成功历史 + 刷 lastDreamAt + 通知渲染端。
    await this.deps.stateStore.commit({
      watermarks,
      record: { at: Date.now(), trigger, sessionsScanned: episodes.length, learnedScopes, ok: true },
    });
    if (learnedScopes > 0) this.deps.onMemoryChanged?.();
    this.deps.logger?.info?.(
      `[memory] 做梦完成(${trigger}): 消化 ${episodes.length} 段会话,更新 ${learnedScopes} 个分区`,
    );
    return { ok: true, sessionsScanned: episodes.length, learnedScopes };
  }
}
