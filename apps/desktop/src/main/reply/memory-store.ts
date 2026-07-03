// 全局 5 分区记忆存储（不依赖 electron）——同 history-store.ts 的单文件三件套。
// 文件 ~/.cortex-desktop/reply/memory.json,结构 {version:1, memory: MemoryState}。
//
// KTD6 修订（借鉴源项目 ReplyClone 的数据目录形态,经用户确认）：记忆从
// personal-workspace.json 的 replyMemory 分片迁出,改为 main-owned 独立文件——
// main 成为记忆唯一写者,蒸馏产出直写本存储（消除原先 main→renderer→store:save 的
// 回推迂回）,渲染端设置页改经 reply:getMemory / reply:setMemoryFile IPC 读写。
// 首启迁移：memory.json 缺失时经 deps.loadLegacy 读旧分片搬运一次并落盘;
// 旧分片本版保留只读兜底,不再由渲染端写入。
// 损坏处理：隔离 .corrupt 后回空态,刻意**不**回落旧分片（旧分片是迁移前快照,
// 复活它会静默丢掉迁移后学到的全部要点,不如从空重学）。

import { promises as fsp } from "fs";
import { dirname } from "path";
import {
  emptyMemoryState,
  MEMORY_SCOPES,
  type MemoryFile,
  type MemoryScope,
  type MemoryState,
} from "@cortex-work/core/reply/memory";

/// 落盘文件结构。
interface MemoryFileData {
  version: 1;
  memory: MemoryState;
}

/// 字段级兜底归一：scope 缺失补空分区、manual/auto 缺失补空串
///（下游 composeUserProfile 直接 .trim()，undefined 会抛，契约同 store/reply.ts mergeMemory）。
function normalizeMemory(memory: Partial<MemoryState> | undefined): MemoryState {
  const base = emptyMemoryState();
  if (!memory) return base;
  for (const scope of MEMORY_SCOPES) {
    const file = memory[scope] as Partial<MemoryFile> | undefined;
    if (file) {
      base[scope] = { manual: file.manual ?? "", auto: file.auto ?? "" };
    }
  }
  return base;
}

export interface ReplyMemoryStoreDeps {
  /// 单文件路径解析（主进程注入 paths.replyMemoryPath；测试注入临时文件）。
  storePath: () => string;
  /// 首启迁移源：读 personal-workspace.json 的 replyMemory 旧分片（无则 undefined）。
  loadLegacy?: () => Promise<MemoryState | undefined>;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

export class ReplyMemoryStore {
  private cached: MemoryState | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  // 迁移单飞：并发 getMemory 只触发一次 loadLegacy（Promise 复用）。
  private loading: Promise<MemoryState> | null = null;

  constructor(private readonly deps: ReplyMemoryStoreDeps) {}

  /// 读全部分区（含首启迁移）。恒返回字段完整的 MemoryState。
  getMemory(): Promise<MemoryState> {
    if (this.cached) return Promise.resolve(this.cached);
    this.loading ??= this.loadOnce();
    return this.loading;
  }

  // 三分支：文件在 → 归一读入;损坏 → 隔离回空态;缺失 → 旧分片搬运（有则落盘固化）。
  private async loadOnce(): Promise<MemoryState> {
    const path = this.deps.storePath();
    let raw: string | null = null;
    try {
      raw = await fsp.readFile(path, "utf8");
    } catch {
      raw = null; // 文件还不存在 → 走迁移分支
    }

    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.version === 1 && parsed.memory && typeof parsed.memory === "object") {
          this.cached = normalizeMemory(parsed.memory);
          return this.cached;
        }
        throw new Error("结构不符");
      } catch (err) {
        this.deps.logger?.warn("[reply] memory.json 损坏,隔离为 .corrupt 回空态", err);
        try {
          await fsp.rename(path, path + ".corrupt");
        } catch {
          // 隔离失败不阻断
        }
        this.cached = emptyMemoryState();
        return this.cached;
      }
    }

    // 首启迁移：读旧分片（读失败视为无旧数据）,有内容才落盘固化。
    let legacy: MemoryState | undefined;
    try {
      legacy = await this.deps.loadLegacy?.();
    } catch (err) {
      this.deps.logger?.warn("[reply] 读取旧记忆分片失败,按空记忆初始化", err);
    }
    const memory = normalizeMemory(legacy);
    this.cached = memory;
    if (legacy) {
      this.deps.logger?.info?.("[reply] 记忆已从 personal-workspace.json 分片迁移到 memory.json");
      await this.enqueue(() => this.save(memory));
    }
    return memory;
  }

  /// 写单分区的手写区/自动区（其余分区不动）。
  setFile(scope: MemoryScope, patch: Partial<MemoryFile>): Promise<void> {
    return this.mutate((memory) => ({
      ...memory,
      [scope]: { ...memory[scope], ...patch },
    }));
  }

  /// 清空全部记忆（手写 + 自动）。
  clearAll(): Promise<void> {
    return this.mutate(() => emptyMemoryState());
  }

  /// 只清全部分区的自动学习要点，保留手写笔记。
  clearAuto(): Promise<void> {
    return this.mutate((memory) => {
      const next = emptyMemoryState();
      for (const scope of MEMORY_SCOPES) {
        next[scope] = { manual: memory[scope].manual, auto: "" };
      }
      return next;
    });
  }

  // 读-改-写整段串行。
  private mutate(fn: (memory: MemoryState) => MemoryState): Promise<void> {
    return this.enqueue(async () => {
      const memory = await this.getMemory();
      const next = fn(memory);
      await this.save(next);
    });
  }

  // 原子写 + 刷新缓存。
  private async save(memory: MemoryState): Promise<void> {
    const path = this.deps.storePath();
    await fsp.mkdir(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, memory } satisfies MemoryFileData, null, 2), "utf8");
    await fsp.rename(tmp, path);
    this.cached = memory;
  }

  // 单条失败只警告，不断链。
  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(job).catch((err) => {
      this.deps.logger?.warn("[reply] 记忆写入失败", err);
    });
    this.writeQueue = next;
    return next;
  }
}
