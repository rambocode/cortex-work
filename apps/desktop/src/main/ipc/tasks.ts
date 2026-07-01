// 真任务系统主进程存储域（替换 doc 聚合 Tasks）。main 是 owner：tasks.json 单文件全量。
// 三类写者——renderer 编辑、后台结构化回写(U6)、agent 委派回写(U12)——共用同一
// TasksStore.mutate 串行队列（KTD1，防后台/委派写被 renderer 整表覆盖 clobber）。
// 存储核心在 tasks-store.ts（不依赖 electron，可单测）；本文件注入路径 + 绑 ipcMain + broadcast。
// 单例 store 导出，供 tasks-migrate.ts（迁移）与 tasks-delegate-observer.ts（委派回写）共用。

import { BrowserWindow, ipcMain } from "electron";
import { tasksJsonPath } from "../paths";
import { TasksStore } from "./tasks-store";
import type { ArchivedTask, TaskInput, TaskMeta, TaskProject } from "./types";

// 单例存储（迁移/委派观察者与 handlers 共用同一实例）。
export const tasksStore = new TasksStore({ tasksStorePath: tasksJsonPath });

// 推全量快照给所有存活窗口（窗口可能已关，事件丢失不影响落盘，renderer 重获焦点补拉）。
export function broadcastTasksChanged(list: TaskMeta[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("tasks:changed", list);
  }
}

// 任务或项目变更后统一推一份任务全量快照（项目变更也可能改任务归属，故一并刷新）。
async function emitChanged(): Promise<void> {
  broadcastTasksChanged(await tasksStore.list());
}

export function registerTasksHandlers(): void {
  ipcMain.handle("tasks:list", (_e, projectId?: string): Promise<TaskMeta[]> => tasksStore.list(projectId));
  ipcMain.handle("tasks:listProjects", (): Promise<TaskProject[]> => tasksStore.listProjects());

  ipcMain.handle("tasks:add", async (_e, input: TaskInput): Promise<TaskMeta> => {
    const meta = await tasksStore.add(input);
    await emitChanged();
    return meta;
  });

  ipcMain.handle(
    "tasks:update",
    async (_e, id: string, patch: Partial<Omit<TaskMeta, "id" | "createdAt">>): Promise<TaskMeta | null> => {
      const meta = await tasksStore.update(id, patch);
      if (meta) await emitChanged();
      return meta;
    },
  );

  // 物理删除（不可恢复，区别于 dropped 软标记，见 U13）。
  ipcMain.handle("tasks:delete", async (_e, id: string): Promise<void> => {
    await tasksStore.delete(id);
    await emitChanged();
  });

  ipcMain.handle("tasks:addProject", async (_e, name: string): Promise<TaskProject> => {
    const p = await tasksStore.addProject(name);
    await emitChanged();
    return p;
  });

  // 删除 task-project：其下任务 reparent 到 Inbox（不删任务，KTD10）。
  ipcMain.handle("tasks:deleteProject", async (_e, projectId: string): Promise<void> => {
    await tasksStore.deleteProject(projectId);
    await emitChanged();
  });

  // 归档 done/dropped 任务（摘要落 archived[]，从活动列表移除，U13/R27）。
  ipcMain.handle("tasks:archive", async (_e, id: string, summary: string): Promise<boolean> => {
    const ok = await tasksStore.archive(id, summary);
    if (ok) await emitChanged();
    return ok;
  });
  ipcMain.handle("tasks:listArchived", (): Promise<ArchivedTask[]> => tasksStore.listArchived());
}
