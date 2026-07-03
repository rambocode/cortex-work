// 对话级记忆存储（不依赖 electron）——同 history-store.ts 的单文件三件套
// （writeQueue 串行 + 内存镜像 + tmp+rename 原子写 + 损坏隔离 .corrupt 回空态）。
// 文件 ~/.cortex-desktop/reply/conversation-memory.json,结构 {version:1, conversations:{}},
// 按 conversationKey（`<bundleId>|<counterpart>`）索引,LRU 淘汰见 core capConversations。
// key 归一 / 追加 / 裁剪 / 组装的纯逻辑全部在 core/reply/conversation-memory.ts。
//
// 隐私边界：只存「我发出的已采纳回复」与蒸馏要点,不存对方消息原文（对话原文只进
// history.json,受 historyEnabled 独立门控）;本存储整体受 learningEnabled 门控（接线在 index.ts）。

import { promises as fsp } from "fs";
import { dirname } from "path";
import {
  appendRecentReply,
  capConversations,
  composeConversationMemory,
  conversationKey,
  MAX_CONVERSATIONS,
  type ConversationMemoryMap,
} from "@cortex-work/core/reply/conversation-memory";

/// 落盘文件结构。
interface ConversationFileData {
  version: 1;
  conversations: ConversationMemoryMap;
}

export interface ReplyConversationStoreDeps {
  /// 单文件路径解析（主进程注入 paths.replyConversationMemoryPath；测试注入临时文件）。
  storePath: () => string;
  /// 对话桶上限（默认 MAX_CONVERSATIONS；测试可缩小验证 LRU）。
  maxConversations?: number;
  logger?: { warn(...args: unknown[]): void };
}

export class ReplyConversationStore {
  private cached: ConversationFileData | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReplyConversationStoreDeps) {}

  // 读（优先缓存）。ENOENT=空态；解析失败=隔离 .corrupt 回空态（同 history-store 取舍）。
  private async getData(): Promise<ConversationFileData> {
    if (this.cached) return this.cached;
    const path = this.deps.storePath();
    let raw: string;
    try {
      raw = await fsp.readFile(path, "utf8");
    } catch {
      return { version: 1, conversations: {} };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && parsed.conversations && typeof parsed.conversations === "object") {
        this.cached = parsed;
        return parsed;
      }
      throw new Error("结构不符");
    } catch (err) {
      this.deps.logger?.warn("[reply] conversation-memory.json 损坏,隔离为 .corrupt 重建", err);
      try {
        await fsp.rename(path, path + ".corrupt");
      } catch {
        // 隔离失败不阻断（并发 rename / 权限），空态重建照常
      }
      return { version: 1, conversations: {} };
    }
  }

  // 原子写 + 建内存镜像。
  private async save(data: ConversationFileData): Promise<void> {
    const path = this.deps.storePath();
    await fsp.mkdir(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, path);
    this.cached = data;
  }

  /// 组装某对话的注入段（summary 优先 / few-shot 回退）；key 无效或无记录 → 空串。
  async getComposed(appBundleId: string, counterpart: string): Promise<string> {
    const key = conversationKey(appBundleId, counterpart);
    if (!key) return "";
    const memory = (await this.getData()).conversations[key];
    return memory ? composeConversationMemory(memory) : "";
  }

  /// 读某对话已蒸馏的摘要（learner 合并旧要点用）；无则空串。
  async getSummary(appBundleId: string, counterpart: string): Promise<string> {
    const key = conversationKey(appBundleId, counterpart);
    if (!key) return "";
    return (await this.getData()).conversations[key]?.summary ?? "";
  }

  /// 对话桶数量（设置页摘要用）。
  async count(): Promise<number> {
    return Object.keys((await this.getData()).conversations).length;
  }

  /// 采纳写回后记录：更新该对话的最近回复队列与 updatedAt，超上限 LRU 裁剪。
  /// counterpart 为空（key null）→ no-op（不分桶，见 core 文件头取舍）。
  recordAccepted(params: {
    appBundleId: string;
    appName: string;
    counterpart: string;
    draft: string;
    now: number;
  }): Promise<void> {
    const key = conversationKey(params.appBundleId, params.counterpart);
    if (!key) return Promise.resolve();
    return this.mutate((conversations) => {
      const existing = conversations[key];
      return {
        ...conversations,
        [key]: {
          appName: params.appName,
          counterpart: params.counterpart.trim(),
          summary: existing?.summary ?? "",
          recentReplies: appendRecentReply(existing?.recentReplies ?? [], params.draft),
          updatedAt: params.now,
        },
      };
    });
  }

  /// 写入蒸馏摘要（learner 产出）。桶不存在则新建（recentReplies 空）；key null → no-op。
  setSummary(params: {
    appBundleId: string;
    appName: string;
    counterpart: string;
    summary: string;
    now: number;
  }): Promise<void> {
    const key = conversationKey(params.appBundleId, params.counterpart);
    if (!key) return Promise.resolve();
    return this.mutate((conversations) => {
      const existing = conversations[key];
      return {
        ...conversations,
        [key]: {
          appName: params.appName,
          counterpart: params.counterpart.trim(),
          summary: params.summary,
          recentReplies: existing?.recentReplies ?? [],
          updatedAt: params.now,
        },
      };
    });
  }

  /// 清空全部对话记忆（设置页数据清理）。
  clear(): Promise<void> {
    return this.enqueue(() => this.save({ version: 1, conversations: {} }));
  }

  /// 启动物化：文件缺失时写入空结构，让数据目录启动即自解释（已存在则不动）。
  ensureMaterialized(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await fsp.access(this.deps.storePath());
      } catch {
        await this.save({ version: 1, conversations: {} });
      }
    });
  }

  // 读-改-写整段串行；改后统一过 LRU 裁剪。
  private mutate(fn: (conversations: ConversationMemoryMap) => ConversationMemoryMap): Promise<void> {
    return this.enqueue(async () => {
      const data = await this.getData();
      const next = capConversations(fn(data.conversations), this.deps.maxConversations ?? MAX_CONVERSATIONS);
      await this.save({ version: 1, conversations: next });
    });
  }

  // 单条失败只警告，不断链。
  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(job).catch((err) => {
      this.deps.logger?.warn("[reply] 对话记忆写入失败", err);
    });
    this.writeQueue = next;
    return next;
  }
}
