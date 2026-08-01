// 消息中心存储核心（不依赖 electron，可单测）——照搬 notes-store.ts 的三件套：
//   单 Promise 链 writeQueue（串行,并发不交错）
//   + 内存镜像 cached（失败不缓存）
//   + 原子写（mkdir + 写 .tmp + rename）。
//
// 与闪记的差别只在两条**保留策略**，它们是本文件存在的理由：
//   ① 60 天过期：消息是一次性消费的历史,留太久既没用又拖慢冷启动读盘。
//   ② 条数上限：过期只按时间裁,挡不住「一天跑一千次自动化」这种量;上限按时间倒序保留最新。
// 两条都在 mutate 内落盘时执行,list() 再做一次纯内存过滤——因为可能整天没有任何写入,
// 光靠写时裁剪的话,一条 59 天的记录会在第 61 天仍被读出来。
//
// 路径解析经 deps 注入,主进程入口（ipc/notification-center.ts）注入 paths + electron 绑定。

import { promises as fsp } from "fs";
import { dirname } from "path";
import type { NotificationInput, NotificationRecord, NotificationsFileData } from "./types";
import { createLogger } from "../log";

const log = createLogger("notification-center");

// 保留 60 天（产品约定）。超期记录在下一次写入时被剔除,读取时也不会返回。
export const NOTIFICATION_TTL_MS = 60 * 24 * 60 * 60 * 1000;

// 条数硬上限：按 createdAt 倒序保留最新的这么多条。
// 60 天 × 每天几十条自动化仍会到几千条,列表全量过桥 + 渲染会明显变卡。
export const NOTIFICATION_MAX_ITEMS = 500;

// 正文截断长度。埋点方（如自动化）可能塞进整段 agent 输出，
// 而列表里每条只显示两行——全文既撑爆 notifications.json 也没人看。
export const NOTIFICATION_BODY_MAX = 300;

// id 生成：ntf-<base36 时间>-<seq>-<random>（仿 notes-store.ts:newNoteId）。
let seq = 0;
export function newNotificationId(): string {
  seq += 1;
  return `ntf-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

// 保留策略的纯函数实现（先按时间裁,再按条数裁,最后统一按 createdAt 倒序）。
// 单独导出以便直接单测边界,不必绕文件 IO。
export function pruneNotifications(items: NotificationRecord[], now: number): NotificationRecord[] {
  const cutoff = now - NOTIFICATION_TTL_MS;
  return items
    .filter((n) => n.createdAt > cutoff)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, NOTIFICATION_MAX_ITEMS);
}

export interface NotificationStoreDeps {
  // notifications.json 路径解析（主进程注入 paths.notificationsStorePath;测试注入临时文件）。
  notificationsStorePath: () => string;
  // 当前时间注入,让过期裁剪可在测试里跨 60 天而不必真的等。
  now?: () => number;
}

export class NotificationStore {
  private cached: NotificationsFileData | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NotificationStoreDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // 读（优先缓存 + version/结构校验 + 失败不缓存）。故意不缓存空状态,与 notes-store 一致。
  private async read(): Promise<NotificationsFileData> {
    if (this.cached) return this.cached;
    try {
      const raw = await fsp.readFile(this.deps.notificationsStorePath(), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && Array.isArray(parsed.items)) {
        this.cached = parsed;
        return parsed;
      }
    } catch {
      // 文件不存在/损坏 → 当作空
    }
    return { version: 1, items: [] };
  }

  private async save(data: NotificationsFileData): Promise<void> {
    const path = this.deps.notificationsStorePath();
    await fsp.mkdir(dirname(path), { recursive: true }); // 首次写兜底,目录不存在 ENOENT
    const tmp = path + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, path);
  }

  // 串行「读-改-写」：写盘前统一跑一次保留策略,所以任何 mutation 都会顺带清理过期记录
  //（不必额外起定时器——用户只要用这个 app,自动化/提醒就会持续产生写入）。
  private mutate<T>(fn: (items: NotificationRecord[]) => [NotificationRecord[], T]): Promise<T> {
    const run = this.writeQueue.then(async () => {
      const data = await this.read();
      const [nextItems, result] = fn(data.items);
      const next: NotificationsFileData = { version: 1, items: pruneNotifications(nextItems, this.now()) };
      this.cached = next;
      await this.save(next);
      return result;
    });
    this.writeQueue = run.then(
      () => undefined,
      (err) => {
        log.error("save failed:", err);
      },
    );
    return run;
  }

  // 全量列表（已按 createdAt 倒序,最新在前）。
  // 这里再裁一次过期：长时间无写入时,写时裁剪不会发生,不能把超期记录交给 UI。
  async list(): Promise<NotificationRecord[]> {
    await this.writeQueue;
    const data = await this.read();
    return pruneNotifications(data.items, this.now());
  }

  // 追加一条。命中 dedupeKey 且已存在**未读**同 key 记录时跳过（返回既有那条）。
  // 幂等键刻意只比对未读：用户已读过「有新版本」之后，下一轮再提醒是合理的。
  add(input: NotificationInput): Promise<NotificationRecord> {
    return this.mutate((items) => {
      if (input.dedupeKey) {
        const dup = items.find((n) => n.readAt == null && dedupeKeyOf(n) === input.dedupeKey);
        if (dup) return [items, dup];
      }
      const record: NotificationRecord = {
        id: input.dedupeKey ? `${DEDUPE_PREFIX}${input.dedupeKey}` : newNotificationId(),
        source: input.source,
        level: input.level ?? "info",
        title: input.title,
        body: input.body,
        refId: input.refId,
        createdAt: this.now(),
      };
      return [[record, ...items], record];
    });
  }

  // 标记已读。传 ids 标记指定几条;不传则全部标已读（列表头部的「全部已读」）。
  markRead(ids?: string[]): Promise<void> {
    const target = ids ? new Set(ids) : null;
    return this.mutate<void>((items) => {
      const now = this.now();
      return [
        items.map((n) =>
          n.readAt == null && (target === null || target.has(n.id)) ? { ...n, readAt: now } : n,
        ),
        undefined,
      ];
    });
  }

  // 清空全部（用户主动清理;不做二次确认,由 UI 侧决定是否确认）。
  clear(): Promise<void> {
    return this.mutate<void>(() => [[], undefined]);
  }

  // 测试 / 退出收尾用：等当前写队列落盘完成。
  flush(): Promise<void> {
    return this.writeQueue;
  }
}

// dedupeKey 编码进 id 前缀,免得为它单开一个持久化字段（记录本身不需要对外暴露这个键）。
const DEDUPE_PREFIX = "ntf-key-";
function dedupeKeyOf(n: NotificationRecord): string | undefined {
  return n.id.startsWith(DEDUPE_PREFIX) ? n.id.slice(DEDUPE_PREFIX.length) : undefined;
}
