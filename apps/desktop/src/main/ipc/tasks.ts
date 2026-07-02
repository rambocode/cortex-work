// 真任务系统主进程存储域（替换 doc 聚合 Tasks）。main 是 owner：tasks.json 单文件全量。
// 三类写者——renderer 编辑、后台结构化回写(U6)、agent 委派回写(U12)——共用同一
// TasksStore.mutate 串行队列（KTD1，防后台/委派写被 renderer 整表覆盖 clobber）。
// 存储核心在 tasks-store.ts（不依赖 electron，可单测）；本文件注入路径 + 绑 ipcMain + broadcast。
// 单例 store 导出，供 tasks-migrate.ts（迁移）与 tasks-delegate-observer.ts（委派回写）共用。

import { BrowserWindow, Notification, ipcMain, powerSaveBlocker } from "electron";
import { Cron } from "croner";
import { tasksJsonPath, taskDocsRoot, taskDocsDir } from "../paths";
import { TasksStore } from "./tasks-store";
import { saveTaskDoc, deleteTaskDoc } from "./task-doc";
import { TasksReminderScheduler } from "../tasks-reminder-scheduler";
import type { ArchivedTask, PersistedState, TaskAttachment, TaskInput, TaskMeta, TaskProject, TaskProjectKind, TaskProjectMode } from "./types";
import { createLogger } from "../log";

const log = createLogger("tasks-reminder");
// 附件专用 scope（与提醒日志分流）。task-doc:* 的错误日志经此记录，脱敏见 logTaskDocError。
const taskDocLog = createLogger("task-doc");

// task-doc:* 错误日志脱敏（KTD9）：只记 op + 错误类型/code，**绝不原样打印用户 fileName 或
// taskDocsRoot 绝对路径**——saveDocInto/assertDocPath 的 err.message 会内嵌文件名/绝对路径，
// 直接落日志会泄露。createLogger 走 electron-log：文件 transport 已 redact + sync=false，
// console 仅 dev 输出，双重满足「脱敏 + 异步 + dev-gate」。
function logTaskDocError(op: string, err: unknown): void {
  const name = err instanceof Error ? err.name : "Error";
  const code = (err as NodeJS.ErrnoException)?.code;
  taskDocLog.error(`${op} 失败: ${code ? `${name}(${code})` : name}`);
}

// 单例存储（迁移/委派观察者与 handlers 共用同一实例）。
export const tasksStore = new TasksStore({ tasksStorePath: tasksJsonPath });

// 推全量快照给所有存活窗口（窗口可能已关，事件丢失不影响落盘，renderer 重获焦点补拉）。
export function broadcastTasksChanged(list: TaskMeta[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("tasks:changed", list);
  }
}

// ── 任务提醒（U11）：main 原生通知投递 + 调度器装配 ────────────────────────────────
//
// opt-in 落点（决策）：复用 pushSettings.internal.enabled（「内部原生通知」总开关，
// SettingsMenu 注释已声明「未来任务通知」共用此开关）。默认关（opt-in），main 经
// getPersistedState 缓存可干净读到，故不新增 IPC 通道，改由 store:save 钩子把开关同步给调度器。
export function isTasksReminderOptInEnabled(state: PersistedState): boolean {
  return state.pushSettings?.internal?.enabled ?? false;
}

// 原生系统通知（复用 automation/push-on-complete 范式）。锁屏隐私：**只带标题**，
// 不把 notes 正文塞进 body。close-to-tray 下窗口可能 hidden，click 需 show() 再 focus()。
function showTasksNotification(task: TaskMeta): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: task.title || "任务提醒" });
  n.on("click", () => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win) {
      win.show();
      win.focus();
    }
  });
  n.show();
}

// 单例提醒调度器（注入真依赖）。markFired 走 `markReminderFired`（store 锁内条件写）落 firedAt 后 broadcast——
// **走裸 broadcast 而非 emitChanged**：emitChanged 会再调 scheduler.sync，形成
// 「写 firedAt → sync → …」回路；裸 broadcast 只推 renderer，不回灌调度器，从源头断环
//（叠加 firedAt 已置的任务不再建 Cron 的天然收敛 + 调度器 firedThisSession 闸门，多重保险）。
export const tasksReminderScheduler = new TasksReminderScheduler({
  now: () => Date.now(),
  createCron: (at, cb) => new Cron(at, cb),
  notify: showTasksNotification,
  markFired: (task, firedAt) => {
    const rem = task.reminder;
    if (!rem) return;
    // 锁内条件写：提醒仍存在且 at 匹配才写 firedAt（防「删提醒瞬间触发」复活已删提醒）；写入才广播。
    void tasksStore
      .markReminderFired(task.id, rem.at, firedAt)
      .then(async (wrote) => {
        if (wrote) broadcastTasksChanged(await tasksStore.list());
      })
      .catch((err) => log.error("写 firedAt 失败:", err));
  },
  powerSaveBlocker: {
    start: () => powerSaveBlocker.start("prevent-app-suspension"),
    stop: (id) => powerSaveBlocker.stop(id),
    isStarted: (id) => powerSaveBlocker.isStarted(id),
  },
  log,
});

// 任务或项目变更后统一推一份任务全量快照（项目变更也可能改任务归属，故一并刷新），
// 并重排提醒调度（新增/改动/删除 reminder 后重建 Cron；firedAt 已置的任务天然不再建，防环）。
async function emitChanged(): Promise<void> {
  const list = await tasksStore.list();
  broadcastTasksChanged(list);
  tasksReminderScheduler.sync(list);
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

  ipcMain.handle(
    "tasks:addProject",
    async (_e, name: string, opts?: { parentId?: string; kind?: TaskProjectKind }): Promise<TaskProject> => {
      const p = await tasksStore.addProject(name, opts);
      await emitChanged();
      return p;
    },
  );

  // 更新 task-project：rename + reparent（防环在 store，成环 reject → renderer toast）。返回 null=不存在。
  ipcMain.handle(
    "tasks:updateProject",
    async (_e, id: string, patch: { name?: string; parentId?: string | null; mode?: TaskProjectMode }): Promise<TaskProject | null> => {
      const p = await tasksStore.updateProject(id, patch);
      if (p) await emitChanged();
      return p;
    },
  );

  // 删除 task-project：直属子节点上提到父级、其下任务回 Inbox（U2 层级安全）。
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

  // ── 任务附件（U13）：复用聊天文档附件闸门（doc.ts），只换存储根为 task-docs + 写回 attachments。──
  // 保存：saveDocInto 落盘（扩展名 allowlist/magic-bytes/50MB/原子写）→ addAttachment 在 store
  // 串行锁内 append 引用（防并发丢更新）→ emitChanged 广播。返回落盘引用供 renderer 乐观展示。
  ipcMain.handle(
    "task-doc:save",
    async (
      _e,
      taskId: string,
      file: { name: string; mimeType: string; srcPath?: string; data?: ArrayBuffer },
    ): Promise<TaskAttachment> => {
      try {
        const ref = await saveTaskDoc(taskDocsRoot(), taskId, file);
        // meta null = 任务已被并发删除：落盘文件成孤儿（无引用指向），无害，不阻断 renderer。
        const meta = await tasksStore.addAttachment(taskId, ref);
        if (meta) await emitChanged();
        return ref;
      } catch (err) {
        logTaskDocError("task-doc:save", err); // 日志脱敏；原始 message（含用户自己的文件名）向上抛给 toast
        throw err;
      }
    },
  );

  // 删除：assertDocPath 校验根边界（拒符号链接/越界）后 unlink 真实路径 → removeAttachment 清引用。
  // 文件已不在磁盘（ENOENT）视为已删，仍继续清引用；越界/符号链接等拒绝错误向上抛（不清引用）。
  ipcMain.handle("task-doc:delete", async (_e, taskId: string, path: string): Promise<void> => {
    try {
      await deleteTaskDoc(taskDocsDir(taskId), path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logTaskDocError("task-doc:delete", err);
        throw err;
      }
    }
    const meta = await tasksStore.removeAttachment(taskId, path);
    if (meta) await emitChanged();
  });
}
