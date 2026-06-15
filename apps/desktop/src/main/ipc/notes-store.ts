// 闪记存储核心（不依赖 electron）——照搬 store.ts 的单文件三件套：
//   单 Promise 链 writeQueue（串行,并发不交错）
//   + 内存镜像 cached（失败不缓存,首次成功 save 才建镜像）
//   + 原子写（mkdir + 写 .tmp + rename,JSON.stringify(data, null, 2)）。
// notes.json 是单文件全量（元数据 + 正文内联）,故用单 writeQueue 而非
// timeline 的 Map<id,Promise>。add/update/delete 是「读-改-写」,整段挂到同一
// writeQueue 上串行,既避免磁盘写交错、又避免两次并发 add 读到同一旧值丢更新。
// 免 assertAllowed / 免 SAFE_ID / 免 ensureMigrated（路径固定 notes.json,renderer
// 只能传 content/projectId,无可变 id 段拼进文件名,且为全新文件无旧位置迁移历史）。
// 路径解析经 deps 注入,使核心逻辑可在 vitest 里以临时文件测试;真正的主进程
// 入口（ipc/notes.ts）注入 paths.notesStorePath 并把 electron 绑定（ipcMain.handle /
// broadcast）裹在外层。

import { promises as fsp } from "fs";
import { dirname } from "path";
import type { NoteInput, NoteMeta, NotesFileData } from "./types";

// id 生成：note-<base36 时间>-<seq>-<random>（仿 automation/store.ts:uid）。
let seq = 0;
export function newNoteId(): string {
  seq += 1;
  return `note-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface NotesStoreDeps {
  // 闪记单文件全量路径解析（主进程注入 paths.notesStorePath;测试注入临时文件）。
  notesStorePath: () => string;
}

export class NotesStore {
  private cached: NotesFileData | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NotesStoreDeps) {}

  // 读（优先缓存 + version/结构校验 + 失败不缓存）。复制 store.ts:23-37 的语义：
  // 故意不缓存空状态（首次成功 save 才建镜像）。
  private async getNotes(): Promise<NotesFileData> {
    if (this.cached) return this.cached;
    try {
      const raw = await fsp.readFile(this.deps.notesStorePath(), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && Array.isArray(parsed.notes)) {
        this.cached = parsed;
        return parsed;
      }
    } catch {
      // 文件不存在/损坏
    }
    return { version: 1, notes: [] };
  }

  // 原子写（mkdir + 写 .tmp + rename）,JSON.stringify(data, null, 2)（2 空格,
  // 人类可读、便于 diff）。
  private async saveNotesFile(data: NotesFileData): Promise<void> {
    const path = this.deps.notesStorePath();
    await fsp.mkdir(dirname(path), { recursive: true }); // 首次写兜底,目录不存在 ENOENT
    const tmp = path + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, path);
  }

  // 串行执行一次「读-改-写」：在 writeQueue 上排队,确保后一个 mutation 看到前一个
  // 已落进内存镜像的最新数组（避免并发 add 都读空文件丢更新）。
  // fn 返回 [新文件数据, 给调用方的结果]。写盘失败只 console.error（与
  // store/timeline/chat 一致,v1 不向 renderer 上报）。
  private mutate<T>(fn: (data: NotesFileData) => [NotesFileData, T]): Promise<T> {
    const run = this.writeQueue.then(async () => {
      const data = await this.getNotes();
      const [next, result] = fn(data);
      this.cached = next; // 立即建镜像,后续 mutation 与 list 即时可见
      await this.saveNotesFile(next);
      return result;
    });
    // writeQueue 自身吞错保持链不中断；返回给调用方的 promise 仍可拿到结果/错误。
    this.writeQueue = run.then(
      () => undefined,
      (err) => {
        console.error("[notes-store] save failed:", err);
      },
    );
    return run;
  }

  // 无 projectId → 返回全部；有 projectId → 仅返回该 projectId（严格相等,不含 undefined）。
  // 排在 writeQueue 之后,保证读到此前所有 mutation 的结果。
  async list(projectId?: string): Promise<NoteMeta[]> {
    await this.writeQueue;
    const data = await this.getNotes();
    if (projectId === undefined) return data.notes.slice();
    return data.notes.filter((n) => n.projectId === projectId);
  }

  // main 生成 id/status="draft"/createdAt/updatedAt,写盘后返回完整 NoteMeta。
  add(input: NoteInput): Promise<NoteMeta> {
    return this.mutate((data) => {
      const now = Date.now();
      const meta: NoteMeta = {
        id: newNoteId(),
        projectId: input.projectId,
        status: "draft",
        content: input.content,
        tags: input.tags,
        sourceSessionId: input.sourceSessionId,
        createdAt: now,
        updatedAt: now,
      };
      return [{ version: 1, notes: [...data.notes, meta] }, meta];
    });
  }

  // 找不到 id 返回 null；命中则字段级合并 + 刷新 updatedAt（id/createdAt 不可改）。
  // conversationIds/docPaths 由调用方传完整数组（main 不做数组 merge）。
  update(
    id: string,
    patch: Partial<Omit<NoteMeta, "id" | "createdAt">>,
  ): Promise<NoteMeta | null> {
    return this.mutate<NoteMeta | null>((data) => {
      const idx = data.notes.findIndex((n) => n.id === id);
      if (idx < 0) return [data, null];
      const next: NoteMeta = {
        ...data.notes[idx],
        ...patch,
        id: data.notes[idx].id,
        createdAt: data.notes[idx].createdAt,
        updatedAt: Date.now(),
      };
      const notes = data.notes.slice();
      notes[idx] = next;
      return [{ version: 1, notes }, next];
    });
  }

  // 删除该 id（仅删自身,不触碰文档/会话）。
  delete(id: string): Promise<void> {
    return this.mutate<void>((data) => [
      { version: 1, notes: data.notes.filter((n) => n.id !== id) },
      undefined,
    ]);
  }

  // 测试 / 退出收尾用：等当前写队列落盘完成。
  flush(): Promise<void> {
    return this.writeQueue;
  }
}
