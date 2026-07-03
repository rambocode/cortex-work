// 回复历史存储（不依赖 electron）——照搬 notes-store.ts 的单文件三件套：
//   单 Promise 链 writeQueue（读-改-写整段串行,并发不交错、不丢更新）
//   + 内存镜像 cached（成功读/写后建镜像）
//   + 原子写（mkdir + 写 .tmp + rename）。
// 文件 ~/.cortex-desktop/reply/history.json,结构 {version:1, entries:[]}（newest-first）。
// 路径经 deps 注入（主进程注入 paths.replyHistoryPath;测试注入临时文件）,
// electron 绑定（ipcMain.handle）裹在 ipc/reply.ts 外层。
//
// KTD8 边界修订（经用户确认）：本文件把对话原文与候选草稿明文落盘,受
// replySettings.historyEnabled 门控（默认开）,设置页「数据清理」可整体清空。
// 损坏处理：解析失败把原文件隔离为 .corrupt 后回空态重建——历史属锦上添花,
// 不采用 tasks-store 的永久拒写（丢历史可接受,拒写反而拖累主流程）。

import { promises as fsp } from "fs";
import { dirname } from "path";
import {
  appendHistoryEntry,
  HISTORY_KEEP,
  type ReplyHistoryEntry,
} from "@cortex-work/core/reply/history";

// id 生成：rh-<base36 时间>-<seq>-<random>（仿 automation/store.ts:uid，字符集恒落 [\w-]）。
let seq = 0;
export function newReplyHistoryId(): string {
  seq += 1;
  return `rh-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/// 落盘文件结构（version 字段留扩展余地）。
interface HistoryFileData {
  version: 1;
  entries: ReplyHistoryEntry[];
}

export interface ReplyHistoryStoreDeps {
  /// 历史单文件路径解析（主进程注入 paths.replyHistoryPath；测试注入临时文件）。
  historyPath: () => string;
  /// 保留上限（默认 HISTORY_KEEP；测试可缩小验证截断）。
  keep?: number;
  logger?: { warn(...args: unknown[]): void };
}

export class ReplyHistoryStore {
  private cached: HistoryFileData | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReplyHistoryStoreDeps) {}

  // 读（优先缓存）。ENOENT=安全空态；解析失败=隔离 .corrupt 后回空态（见文件头取舍）。
  private async getData(): Promise<HistoryFileData> {
    if (this.cached) return this.cached;
    const path = this.deps.historyPath();
    let raw: string;
    try {
      raw = await fsp.readFile(path, "utf8");
    } catch {
      return { version: 1, entries: [] }; // 首次使用,文件还不存在
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
        this.cached = parsed;
        return parsed;
      }
      throw new Error("结构不符");
    } catch (err) {
      this.deps.logger?.warn("[reply] history.json 损坏,隔离为 .corrupt 重建", err);
      // 隔离现场（best-effort,rename 失败不阻断——空态重建照常进行）
      try {
        await fsp.rename(path, path + ".corrupt");
      } catch {
        // 忽略：并发隔离或权限问题,不影响回空态
      }
      return { version: 1, entries: [] };
    }
  }

  // 原子写：mkdir + 写 .tmp + rename。成功后建内存镜像。
  private async save(data: HistoryFileData): Promise<void> {
    const path = this.deps.historyPath();
    await fsp.mkdir(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, path);
    this.cached = data;
  }

  /// 读全部历史（newest-first）。
  async list(): Promise<ReplyHistoryEntry[]> {
    return (await this.getData()).entries;
  }

  /// 历史条数（设置页摘要用）。
  async count(): Promise<number> {
    return (await this.list()).length;
  }

  /// 追加一条（读-改-写整段挂 writeQueue 串行；核心追加/截断规则在 core/reply/history）。
  append(entry: ReplyHistoryEntry): Promise<void> {
    return this.enqueue(async () => {
      const data = await this.getData();
      await this.save({
        version: 1,
        entries: appendHistoryEntry(data.entries, entry, this.deps.keep ?? HISTORY_KEEP),
      });
    });
  }

  /// 清空全部历史（设置页数据清理）。
  clear(): Promise<void> {
    return this.enqueue(() => this.save({ version: 1, entries: [] }));
  }

  /// 启动物化：文件缺失时写入空结构，让数据目录启动即自解释（已存在则不动）。
  ensureMaterialized(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await fsp.access(this.deps.historyPath());
      } catch {
        await this.save({ version: 1, entries: [] });
      }
    });
  }

  // 串行化写操作；单条失败只警告,不让队列断链（后续写照常）。
  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(job).catch((err) => {
      this.deps.logger?.warn("[reply] 历史写入失败", err);
    });
    this.writeQueue = next;
    return next;
  }
}
