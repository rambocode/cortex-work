// 回复历史存储（不依赖 electron）——借鉴 Reply.app 的 events 目录形态（经用户确认）：
//   events/<bundleId>__<appName>/<id>.json    每次「已采纳写回」一个事件文件,按应用分目录
// 事件体 = ReplyHistoryEntry + schemaVersion。按应用分目录让用户在 Finder 里按来源应用
// 直接翻阅;单事件单文件也免去整表读-改-写。每应用保留最近 KEEP 条,超出按 ts 淘汰最旧。
//
// KTD8 边界修订（经用户确认）：事件含对话原文与全部候选,明文本地,受
// replySettings.historyEnabled 门控（默认开）,设置页「数据清理」可整体清空。
// 迁移：上一版单文件 history.json 存在时,ensureMaterialized 拆分为事件文件后改名 .migrated。
// 路径经 deps 注入（主进程注入 paths.replyEventsDir;测试注入临时目录）。

import { promises as fsp } from "fs";
import { join } from "path";
import { HISTORY_KEEP, type ReplyHistoryEntry } from "@cortex-work/core/reply/history";

// id 生成：rh-<base36 时间>-<seq>-<random>（字符集恒落 [\w-]，可安全作文件名）。
let seq = 0;
export function newReplyHistoryId(): string {
  seq += 1;
  return `rh-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

const SAFE_ID = /^[\w-]+$/;

/// 应用事件目录名：`<bundleId>__<appName>`（对齐源项目,如 com.tencent.xinWeChat__微信）。
/// 两段各自净化：路径分隔符/冒号/控制字符替换为 `-`、剥前导点（防 `..` 穿越与隐藏目录）,
/// 空段回落 unknown。CJK 等合法文件名字符原样保留。
export function eventDirName(appBundleId: string, appName: string): string {
  const clean = (s: string): string => {
    // 先替换分隔符再剥前导点/横杠（`../etc` → `..-etc` → `etc`）,防穿越与隐藏目录。
    // eslint-disable-next-line no-control-regex -- 控制字符本就是净化目标
    const cleaned = s.replace(/[/\\:\u0000-\u001f]/g, "-").replace(/^[-.]+/, "").trim();
    return cleaned.length > 0 ? cleaned : "unknown";
  };
  return `${clean(appBundleId)}__${clean(appName)}`;
}

/// 落盘事件体：历史条目 + schema 版本（对齐源项目字段风格,留升级余地）。
interface EventFileData extends ReplyHistoryEntry {
  schemaVersion: 1;
}

export interface ReplyHistoryStoreDeps {
  /// events 根目录解析（主进程注入 paths.replyEventsDir；测试注入临时目录）。
  eventsDir: () => string;
  /// 迁移源：上一版单文件 history.json 路径（存在则拆分迁移后改名 .migrated）。
  legacyJsonPath?: () => string;
  /// 每应用保留上限（默认 HISTORY_KEEP；测试可缩小验证淘汰）。
  keepPerApp?: number;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

export class ReplyHistoryStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReplyHistoryStoreDeps) {}

  // 列出全部应用子目录（events 目录缺失 → 空）。
  private async appDirs(): Promise<string[]> {
    try {
      const entries = await fsp.readdir(this.deps.eventsDir(), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => join(this.deps.eventsDir(), e.name));
    } catch {
      return [];
    }
  }

  // 读单个事件文件；损坏/结构不符返回 null（list 时静默跳过,不因一条坏数据废全部）。
  private async readEvent(path: string): Promise<ReplyHistoryEntry | null> {
    try {
      const parsed = JSON.parse(await fsp.readFile(path, "utf8"));
      if (parsed && typeof parsed.id === "string" && typeof parsed.ts === "number") {
        return parsed as ReplyHistoryEntry;
      }
    } catch {
      // 坏文件：跳过
    }
    return null;
  }

  /// 读全部历史（跨应用聚合,newest-first）。
  async list(): Promise<ReplyHistoryEntry[]> {
    const all: ReplyHistoryEntry[] = [];
    for (const dir of await this.appDirs()) {
      let files: string[];
      try {
        files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      const events = await Promise.all(files.map((f) => this.readEvent(join(dir, f))));
      for (const event of events) {
        if (event) all.push(event);
      }
    }
    return all.sort((a, b) => b.ts - a.ts);
  }

  /// 历史总条数（设置页摘要用；只数文件,不解析内容）。
  async count(): Promise<number> {
    let total = 0;
    for (const dir of await this.appDirs()) {
      try {
        total += (await fsp.readdir(dir)).filter((f) => f.endsWith(".json")).length;
      } catch {
        // 目录读取失败：跳过
      }
    }
    return total;
  }

  /// 追加一个事件：写入对应应用目录 + 超出每应用上限时按 ts 淘汰最旧。
  append(entry: ReplyHistoryEntry): Promise<void> {
    return this.enqueue(async () => {
      if (!SAFE_ID.test(entry.id)) throw new Error(`非法事件 id: ${entry.id}`);
      const dir = join(this.deps.eventsDir(), eventDirName(entry.appBundleId, entry.appName));
      await this.writeEvent(dir, entry);
      await this.pruneDir(dir);
    });
  }

  /// 清空全部历史：整个 events 目录删除重建。
  clear(): Promise<void> {
    return this.enqueue(async () => {
      await fsp.rm(this.deps.eventsDir(), { recursive: true, force: true });
      await fsp.mkdir(this.deps.eventsDir(), { recursive: true });
    });
  }

  /// 启动物化 + 一次性迁移：建 events 目录;上一版单文件 history.json 存在则逐条拆分为
  /// 事件文件后改名 .migrated（防重复迁移）。
  ensureMaterialized(): Promise<void> {
    return this.enqueue(async () => {
      await fsp.mkdir(this.deps.eventsDir(), { recursive: true });
      const legacyPath = this.deps.legacyJsonPath?.();
      if (!legacyPath) return;
      let entries: ReplyHistoryEntry[];
      try {
        const parsed = JSON.parse(await fsp.readFile(legacyPath, "utf8"));
        entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      } catch {
        return; // 无旧文件或损坏：无需迁移
      }
      for (const entry of entries) {
        if (typeof entry?.id !== "string" || !SAFE_ID.test(entry.id)) continue;
        const dir = join(this.deps.eventsDir(), eventDirName(entry.appBundleId ?? "", entry.appName ?? ""));
        await this.writeEvent(dir, entry);
      }
      this.deps.logger?.info?.(`[reply] 历史已迁移为 events 目录（${entries.length} 条）`);
      try {
        await fsp.rename(legacyPath, legacyPath + ".migrated");
      } catch {
        // 改名失败不阻断（下次仍会尝试；事件写入幂等——同 id 覆盖同名文件）
      }
    });
  }

  // 原子写单事件文件（mkdir + tmp + rename）。
  private async writeEvent(dir: string, entry: ReplyHistoryEntry): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
    const path = join(dir, `${entry.id}.json`);
    const tmp = path + ".tmp";
    const data: EventFileData = { schemaVersion: 1, ...entry };
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, path);
  }

  // 每应用上限淘汰：超出 keep 时按 ts 升序删除最旧的事件文件（仅超限时才逐个解析）。
  private async pruneDir(dir: string): Promise<void> {
    const keep = this.deps.keepPerApp ?? HISTORY_KEEP;
    let files: string[];
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    if (files.length <= keep) return;
    const dated = await Promise.all(
      files.map(async (f) => ({ f, ts: (await this.readEvent(join(dir, f)))?.ts ?? 0 })),
    );
    dated.sort((a, b) => a.ts - b.ts);
    for (const { f } of dated.slice(0, dated.length - keep)) {
      try {
        await fsp.rm(join(dir, f));
      } catch {
        // 删除失败：留待下次淘汰
      }
    }
  }

  // 写操作串行；单条失败只警告，不断链。
  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(job).catch((err) => {
      this.deps.logger?.warn("[reply] 历史写入失败", err);
    });
    this.writeQueue = next;
    return next;
  }
}
