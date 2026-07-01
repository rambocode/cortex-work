// 真任务系统存储核心（不依赖 electron）——照搬 notes-store.ts 的单文件三件套：
//   单 Promise 链 writeQueue（串行,并发不交错）
//   + 内存镜像 cached（失败不缓存,首次成功 save 才建镜像）
//   + 原子写（mkdir + 写 .tmp + rename,JSON.stringify(data, null, 2)）。
// 关键差异（数据安全，见计划 U2/KTD1）：新任务有「后台结构化回写」「agent 委派回写」两类
// 非 renderer 写者,全部经本 store 的同一 writeQueue 串行,故绝不能像 store.ts 那样让 renderer
// 整表覆盖——否则后台/委派回写被下一次全量 save clobber。
// 损坏处理（计划 U2/研究 rank2）：区分「文件缺失(ENOENT)=安全空态」与「解析失败/结构非法=损坏」。
// 损坏时把文件隔离到 .corrupt 并进入 corrupt 态**拒绝一切 mutate**,绝不在损坏读之后落盘覆盖
// 幸存数据(隔离后若回退空态再写,等于二次抹掉,故 corrupt 态必须持久拒写直到重启排查)。
// 路径解析经 deps 注入,核心逻辑可在 vitest 以临时文件测试;主进程入口(ipc/tasks.ts)注入
// paths.tasksJsonPath 并把 electron 绑定(ipcMain.handle / broadcast)裹在外层。

import { promises as fsp } from "fs";
import { dirname } from "path";
import type { ArchivedTask, TaskInput, TaskMeta, TaskProject, TasksFileData } from "./types";
import { createLogger } from "../log";

const log = createLogger("tasks-store");

// id 生成：task-<base36 时间>-<seq>-<random>（仿 notes-store.ts:newNoteId）。
let seq = 0;
export function newTaskId(prefix: "task" | "proj" = "task"): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

// tasks.json 空态（main-owned；version 独立于 personal-workspace.json，全新文件从 1 起）。
export function emptyTasks(): TasksFileData {
  return { version: 1, tasks: [], projects: [], archived: [] };
}

// 结构校验：version 与三个数组齐备才认为合法，否则按损坏处理。
function isValidTasksFile(v: unknown): v is TasksFileData {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return d.version === 1 && Array.isArray(d.tasks) && Array.isArray(d.projects) && Array.isArray(d.archived);
}

export interface TasksStoreDeps {
  // tasks.json 单文件全量路径解析（主进程注入 paths.tasksJsonPath；测试注入临时文件）。
  tasksStorePath: () => string;
}

export class TasksStore {
  private cached: TasksFileData | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  // 一旦检测到损坏即置 true 并持久拒写：隔离后回退空态再写=二次抹掉，故必须拒到重启排查。
  private corrupt = false;

  constructor(private readonly deps: TasksStoreDeps) {}

  // 读（优先缓存 + 损坏区分 + 失败不缓存空态）。
  // ENOENT=安全空态；解析失败/结构非法=损坏→隔离 .corrupt + 置 corrupt 态。
  private async getTasks(): Promise<TasksFileData> {
    if (this.corrupt) {
      throw new Error("tasks store 处于损坏隔离态，拒绝读写（见 tasks.json.corrupt）");
    }
    if (this.cached) return this.cached;
    let raw: string;
    try {
      raw = await fsp.readFile(this.deps.tasksStorePath(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        // 文件缺失 = 安全空态（不缓存空态，等首次成功 save 才建镜像）。
        return emptyTasks();
      }
      // 其它读错误（权限等）视为危险，不进入覆盖路径。
      this.corrupt = true;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.quarantine();
      throw new Error("tasks.json 解析失败，已隔离到 tasks.json.corrupt");
    }
    if (isValidTasksFile(parsed)) {
      this.cached = parsed;
      return parsed;
    }
    await this.quarantine();
    throw new Error("tasks.json 结构非法，已隔离到 tasks.json.corrupt");
  }

  // 隔离：把损坏文件重命名到 .corrupt 并置 corrupt 态（幂等，重命名失败仅 log）。
  private async quarantine(): Promise<void> {
    this.corrupt = true;
    const path = this.deps.tasksStorePath();
    try {
      await fsp.rename(path, path + ".corrupt");
    } catch (e) {
      log.error("quarantine rename failed:", e);
    }
  }

  // 原子写（mkdir + 写 .tmp + rename），JSON.stringify(data, null, 2)。
  private async saveTasksFile(data: TasksFileData): Promise<void> {
    const path = this.deps.tasksStorePath();
    await fsp.mkdir(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, path);
  }

  // 串行「读-改-写」：排队确保后一个 mutation 看到前一个已落进内存镜像的最新数据
  //（避免并发写读到同一旧值丢更新）。fn 返回 [新文件数据, 给调用方的结果]。
  // 损坏态下 getTasks 会抛错，mutate 随之 reject，绝不覆盖。
  private mutate<T>(fn: (data: TasksFileData) => [TasksFileData, T]): Promise<T> {
    const run = this.writeQueue.then(async () => {
      const data = await this.getTasks();
      const [next, result] = fn(data);
      this.cached = next; // 立即建镜像，后续 mutation 与 list 即时可见
      await this.saveTasksFile(next);
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

  // 读全量（tasks + projects + archived）。排在 writeQueue 之后，读到此前所有 mutation。
  async getData(): Promise<TasksFileData> {
    await this.writeQueue;
    return this.getTasks();
  }

  // 列任务：无 projectId → 全部；有 → 仅该 projectId（严格相等）。
  async list(projectId?: string): Promise<TaskMeta[]> {
    const data = await this.getData();
    if (projectId === undefined) return data.tasks.slice();
    return data.tasks.filter((t) => t.projectId === projectId);
  }

  async listProjects(): Promise<TaskProject[]> {
    const data = await this.getData();
    return data.projects.slice();
  }

  // 新建：main 生成 id/status="active"/时间戳，写盘后返回完整 TaskMeta。
  add(input: TaskInput): Promise<TaskMeta> {
    return this.mutate((data) => {
      const now = Date.now();
      const meta: TaskMeta = {
        id: newTaskId(),
        title: input.title.trim(),
        notes: input.notes,
        status: "active",
        tags: [],
        projectId: input.projectId,
        source: input.source ?? "manual",
        createdAt: now,
        updatedAt: now,
      };
      return [{ ...data, tasks: [...data.tasks, meta] }, meta];
    });
  }

  // 字段级合并 + 刷新 updatedAt（id/createdAt 不可改）；找不到返回 null。
  // tags/delegation 等数组/对象由调用方传完整值（main 不做深合并）。
  update(id: string, patch: Partial<Omit<TaskMeta, "id" | "createdAt">>): Promise<TaskMeta | null> {
    return this.mutate<TaskMeta | null>((data) => {
      const idx = data.tasks.findIndex((t) => t.id === id);
      if (idx < 0) return [data, null];
      const next: TaskMeta = {
        ...data.tasks[idx],
        ...patch,
        id: data.tasks[idx].id,
        createdAt: data.tasks[idx].createdAt,
        updatedAt: Date.now(),
      };
      const tasks = data.tasks.slice();
      tasks[idx] = next;
      return [{ ...data, tasks }, next];
    });
  }

  // 物理删除（不可恢复，区别于 dropped 软标记，见计划 U4/U13）。
  delete(id: string): Promise<void> {
    return this.mutate<void>((data) => [{ ...data, tasks: data.tasks.filter((t) => t.id !== id) }, undefined]);
  }

  addProject(name: string): Promise<TaskProject> {
    return this.mutate((data) => {
      const proj: TaskProject = { id: newTaskId("proj"), name: name.trim() };
      return [{ ...data, projects: [...data.projects, proj] }, proj];
    });
  }

  // 删除 task-project：其下任务 reparent 到 Inbox（projectId 置空），不删任务（KTD10）。
  deleteProject(projectId: string): Promise<void> {
    return this.mutate<void>((data) => {
      const projects = data.projects.filter((p) => p.id !== projectId);
      const tasks = data.tasks.map((t) =>
        t.projectId === projectId ? { ...t, projectId: undefined, updatedAt: Date.now() } : t,
      );
      return [{ ...data, projects, tasks }, undefined];
    });
  }

  // 归档条目追加（供 U13 归档流程使用）。
  appendArchived(entry: ArchivedTask): Promise<void> {
    return this.mutate<void>((data) => [{ ...data, archived: [...data.archived, entry] }, undefined]);
  }

  // 迁移专用（U3）：仅当尚无 migratedAt 时以给定全量数据初始化并盖章，幂等 no-op。
  // 返回是否实际执行了迁移（false = 已迁移过，纯 no-op）。
  migrateOnce(build: () => TasksFileData): Promise<boolean> {
    return this.mutate<boolean>((data) => {
      if (data.migratedAt) return [data, false];
      return [build(), true];
    });
  }

  // 测试 / 退出收尾：等当前写队列落盘完成。
  flush(): Promise<void> {
    return this.writeQueue;
  }
}
