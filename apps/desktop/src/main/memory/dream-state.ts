// 做梦水位与历史的持久化（memory/dream-state.json,main-owned,不依赖 electron）。
// 记录每会话已消化的消息数水位（增量消化的依据）、上次成功整理时刻与最近若干次历史。
// 写经串行队列 + tmp+rename 原子写;读损坏/缺失一律回落空状态（做梦会从头消化,幂等安全）。

import { promises as fsp } from "fs";
import { dirname } from "path";
import type { DreamSources, MemoryDreamRecord } from "@cortex-work/core/memory/memory";

/// dream-state.json 的落盘结构。
export interface DreamStateFile {
  version: 1;
  lastDreamAt: number | null;
  sources: DreamSources;
  history: MemoryDreamRecord[];
}

/// 历史保留条数上限（设置页只展示最近几次,无需无限增长）。
const HISTORY_LIMIT = 10;

export function emptyDreamState(): DreamStateFile {
  return { version: 1, lastDreamAt: null, sources: {}, history: [] };
}

export interface DreamStateStoreDeps {
  statePath: () => string;
  logger?: { warn(...args: unknown[]): void };
}

export class DreamStateStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DreamStateStoreDeps) {}

  /// 读全量状态；缺失/损坏回落空状态（不抛）。
  async load(): Promise<DreamStateFile> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.deps.statePath(), "utf8"));
      if (parsed?.version === 1 && typeof parsed === "object") {
        return {
          version: 1,
          lastDreamAt: typeof parsed.lastDreamAt === "number" ? parsed.lastDreamAt : null,
          sources: parsed.sources && typeof parsed.sources === "object" ? parsed.sources : {},
          history: Array.isArray(parsed.history) ? parsed.history : [],
        };
      }
    } catch {
      // 首次或文件损坏：按空状态处理
    }
    return emptyDreamState();
  }

  /// 做梦后的状态推进：合并新水位 +（可选）记录历史（截断到上限）+ 成功时刷新 lastDreamAt。
  /// record 缺省 = 只推进水位不记历史（纯噪音会话的水位推进,不值得占历史条目）。
  /// 读-改-写经串行队列,防并发做梦交错覆盖（Dreamer 单飞下实际不会并发,双保险）。
  commit(params: { watermarks: Record<string, number>; record?: MemoryDreamRecord }): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.load();
      const now = params.record?.at ?? Date.now();
      for (const [sessionId, count] of Object.entries(params.watermarks)) {
        state.sources[sessionId] = { digestedMsgCount: count, digestedAt: now };
      }
      if (params.record) {
        if (params.record.ok) state.lastDreamAt = now;
        state.history = [params.record, ...state.history].slice(0, HISTORY_LIMIT);
      }
      await this.write(state);
    });
  }

  private async write(state: DreamStateFile): Promise<void> {
    const path = this.deps.statePath();
    await fsp.mkdir(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fsp.rename(tmp, path);
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(job).catch((err) => {
      this.deps.logger?.warn("[memory] dream-state 写入失败", err);
    });
    this.writeQueue = next;
    return next;
  }
}
