// 闪记（Flash Notes）主进程存储域。main 是 owner：notes.json 单文件全量
//（元数据 + 正文内联）,经 notes: 域做 CRUD,变更经 notes:changed 事件推回渲染端。
// 全局浮层（独立窗口,够不到主窗口 Zustand）与主窗口缺席时也能落盘——这是
// 「主窗口关到托盘也能记」的关键（KTD1）。
// 存储核心（writeQueue + cached + 原子写 + 过滤/合并）抽在 notes-store.ts（不依赖
// electron,可单测）;本文件只负责注入 paths.notesStorePath + 注册 ipcMain.handle
// + broadcast。免 assertAllowed / 免 SAFE_ID / 免 ensureMigrated。

import { ipcMain } from "electron";
import { broadcastSyncInvalidate } from "./sync-invalidate";
import { notesStorePath } from "../paths";
import { NotesStore, newNoteId } from "./notes-store";
import type { NoteInput, NoteMeta, NoteStatus } from "./types";

// 单例存储（注入主进程的路径解析）。
const store = new NotesStore({ notesStorePath });

// 信封归一 P1:笔记变更改发纯失效信号(渲染端本就只 invalidate 重拉,从不消费旧快照载荷)。
function broadcastNotesChanged(_list: NoteMeta[]): void {
  broadcastSyncInvalidate("notes");
}

// CRUD 后统一推一份全量快照。
async function emitChanged(): Promise<void> {
  broadcastNotesChanged(await store.list());
}

export function registerNotesHandlers(): void {
  // 无 projectId → 返回全部；有 projectId → 仅返回该 projectId（严格相等）。
  ipcMain.handle("notes:list", (_e, projectId?: string): Promise<NoteMeta[]> => store.list(projectId));

  // main 生成 id/status="draft"/createdAt/updatedAt,写盘后 broadcast,返回完整 NoteMeta。
  ipcMain.handle("notes:add", async (_e, input: NoteInput): Promise<NoteMeta> => {
    const meta = await store.add(input);
    await emitChanged();
    return meta;
  });

  // 找不到 id 返回 null；命中则字段级合并 + 刷新 updatedAt,写盘后 broadcast,返回更新后 meta。
  ipcMain.handle(
    "notes:update",
    async (
      _e,
      id: string,
      patch: Partial<Omit<NoteMeta, "id" | "createdAt">>,
    ): Promise<NoteMeta | null> => {
      const meta = await store.update(id, patch);
      if (meta) await emitChanged();
      return meta;
    },
  );

  // 删除该 id（仅删自身,不触碰文档/会话）,写盘后 broadcast。
  ipcMain.handle("notes:delete", async (_e, id: string): Promise<void> => {
    await store.delete(id);
    await emitChanged();
  });
}

export { newNoteId };
export type { NoteStatus };
