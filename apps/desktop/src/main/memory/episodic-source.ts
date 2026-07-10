// 情景记忆读盘层：遍历 ~/.cortex-desktop/chats/*.json（会话消息历史,即情景记忆）,
// 归一 v1/v2 两种文件形态,附上会话标题（personal-workspace.json 的 SessionMeta）与
// 文件 mtime（最近活动排序依据）,交给 core 纯函数采样（core/memory/episodic.ts）。
//
// 注:写作(writing-<threadId>)/设计(design-<docId>)回合不经 chat:save 落盘,不在 chats/
// 目录中——它们的上下文由各自工作台的磁盘文件承载,暂不纳入做梦来源（后续可扩展）。

import { promises as fsp } from "fs";
import { join } from "path";
import type { EpisodicSessionInput } from "@cortex-work/core/memory/episodic";

export interface EpisodicSourceDeps {
  chatsDir: () => string;
  /// 读会话元数据（sessionId → 标题）,来自 getPersistedState().sessions;失败返回空表。
  getSessionTitles: () => Promise<Map<string, string>>;
  logger?: { warn(...args: unknown[]): void };
}

/// 归一会话文件形态：v1 裸数组 / v2 {version:2, messages}（契约见 ipc/chat.ts）;其余按空处理。
function normalizeChatFile(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { messages?: unknown }).messages)) {
    return (parsed as { messages: unknown[] }).messages;
  }
  return [];
}

/// 读全部会话历史为采样输入。单文件读失败只跳过（损坏的会话不阻断整体做梦）。
export async function readEpisodicInputs(deps: EpisodicSourceDeps): Promise<EpisodicSessionInput[]> {
  let names: string[];
  try {
    names = await fsp.readdir(deps.chatsDir());
  } catch {
    return []; // 目录不存在 = 尚无任何会话
  }
  const titles = await deps.getSessionTitles().catch(() => new Map<string, string>());

  const inputs: EpisodicSessionInput[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const sessionId = name.slice(0, -".json".length);
    const path = join(deps.chatsDir(), name);
    try {
      const [raw, stat] = await Promise.all([fsp.readFile(path, "utf8"), fsp.stat(path)]);
      const messages = normalizeChatFile(JSON.parse(raw));
      if (messages.length === 0) continue;
      inputs.push({
        sessionId,
        title: titles.get(sessionId),
        // 文件 mtime 即最近活动时刻（chat:save 每轮落盘,足够精确）。
        lastActivity: stat.mtimeMs,
        messages,
      });
    } catch (err) {
      deps.logger?.warn(`[memory] 读会话历史失败,跳过 ${name}`, err);
    }
  }
  return inputs;
}
