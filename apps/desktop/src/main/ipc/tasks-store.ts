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
import type { ArchivedTask, Member, ProjectStage, StageTemplate, TaskAttachment, TaskInput, TaskMeta, TaskProject, TaskProjectKind, TaskProjectMode, TaskProjectStatus, TasksFileData } from "./types";
// 防环复用 core 纯函数（与 U1 树逻辑同源；main 已有 import core 纯模块先例 taskMigrate）。
import { isDescendant } from "@cortex-work/core/personal/taskProjectTree";
// 子任务层级：改父防环 + 删父级联删子树（U2，与渲染层建树同源纯函数）。
import { isTaskDescendant, taskDescendantIds } from "@cortex-work/core/personal/taskTree";
// 重复任务「完成即滚动」的日期推进纯逻辑（U12）。
import { canRoll, rollRepeat } from "@cortex-work/core/personal/taskRepeat";
import { createLogger } from "../log";

const log = createLogger("tasks-store");

// id 生成：<prefix>-<base36 时间>-<seq>-<random>（仿 notes-store.ts:newNoteId）。
// 前缀扩展：member=团队成员 / tpl=自定义阶段模板 / stage=项目阶段实例
// （tpl 自带时间段，天然不撞内置模板的 tpl-builtin- 前缀）。
let seq = 0;
export function newTaskId(prefix: "task" | "proj" | "member" | "tpl" | "stage" = "task"): string {
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

// 读时归一化（U2/KTD4、U8/KTD5）：为旧档补 kind（folder 需显式标注，其余 project）与 mode（缺省 parallel）默认，
// 使下游可可靠依赖两字段存在。幂等：无缺省字段时原样返回、不产生新对象。
// 阶段扩展：project.stages 存在时补每条的 status（缺省 not-started）/ order（缺省数组下标），
// 供 timeline/tab 可靠排序。members/jobTypes/stageTemplates 刻意不 backfill（undefined 由
// core resolve 默认，落盘固化会阻断默认表随 App 升级演进）。
function normalizeData(data: TasksFileData): TasksFileData {
  let changed = false;
  const projects = data.projects.map((p) => {
    const patch: Partial<TaskProject> = {};
    if (p.kind === undefined) patch.kind = "project" as TaskProjectKind;
    if (p.mode === undefined) patch.mode = "parallel" as TaskProjectMode;
    if (p.stages?.some((s) => s.status === undefined || s.order === undefined)) {
      patch.stages = p.stages.map((s, i) => ({ ...s, status: s.status ?? "not-started", order: s.order ?? i }));
    }
    if (Object.keys(patch).length === 0) return p;
    changed = true;
    return { ...p, ...patch };
  });
  return changed ? { ...data, projects } : data;
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
      // 归一化补 kind 默认（幂等）；结果进缓存，下次 saveTasksFile 自然把升级形状落盘。
      const normalized = normalizeData(parsed);
      this.cached = normalized;
      return normalized;
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
      // 子任务（U2）：parentId 指向的父任务须存在，否则降级为顶层（不悬空）。
      const parentTaskId =
        input.parentId && data.tasks.some((t) => t.id === input.parentId) ? input.parentId : undefined;
      const meta: TaskMeta = {
        id: newTaskId(),
        title: input.title.trim(),
        notes: input.notes,
        status: "active",
        tags: [],
        projectId: input.projectId,
        parentTaskId,
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
      const prev = data.tasks[idx];
      // 子任务改父级（U2）：patch.parentTaskId 为 string 时须校验——父存在且不成环
      // （把任务挂到自身或其后代下）。undefined = 提升为顶层/不改，无需校验。
      // 抛错供 handler 捕获给 UI toast，绝不落成环数据。
      if (patch.parentTaskId !== undefined) {
        if (!data.tasks.some((t) => t.id === patch.parentTaskId)) {
          throw new Error("目标父任务不存在");
        }
        if (isTaskDescendant(data.tasks, id, patch.parentTaskId)) {
          throw new Error("不能把任务移到自身或其子级之下");
        }
      }
      const next: TaskMeta = {
        ...prev,
        ...patch,
        id: prev.id,
        createdAt: prev.createdAt,
        updatedAt: Date.now(),
      };
      // U10：完成/丢弃时间戳（权威在 main）。仅在 status 实际变化时按新状态写/清——
      // 进入 done→写 completedAt；进入 dropped→写 droppedAt；离开则对应清空（恢复 active 等）。
      if (patch.status && patch.status !== prev.status) {
        next.completedAt = next.status === "done" ? Date.now() : undefined;
        next.droppedAt = next.status === "dropped" ? Date.now() : undefined;
      }
      // U12：重复任务「完成即滚动」——置 done 且仍有 repeat + 日期锚点 → 不落 done，顺延日期回 active、
      // 不留 completedAt（对抗 #4 已知限制）。「结束重复」= 先清 repeat 再完成（届时 canRoll 假，走正常 done）。
      if (patch.status === "done" && prev.status !== "done" && canRoll(next)) {
        const rolled = rollRepeat(next);
        next.status = "active";
        next.completedAt = undefined;
        next.dueDate = rolled.dueDate;
        next.deferDate = rolled.deferDate;
        // U14 子日重复（分/时）：rollRepeat 把提醒时刻顺延一个间隔（清 firedAt 使重新触发）；日期类重复无此项。
        if (rolled.reminder) next.reminder = rolled.reminder;
      }
      const tasks = data.tasks.slice();
      tasks[idx] = next;
      return [{ ...data, tasks }, next];
    });
  }

  // U13 附件：把落盘引用 append 进任务 attachments。**读-改-写在 mutate 锁内完成**——
  // 若在 handler 侧「先读任务再 update 整个数组」，并发添加会互相覆盖丢引用（lost update）；
  // 放进 store 的串行队列里以当前最新数组为基准 append，杜绝该竞争。任务不存在返回 null。
  addAttachment(id: string, ref: TaskAttachment): Promise<TaskMeta | null> {
    return this.mutate<TaskMeta | null>((data) => {
      const idx = data.tasks.findIndex((t) => t.id === id);
      if (idx < 0) return [data, null];
      const prev = data.tasks[idx];
      const next: TaskMeta = {
        ...prev,
        attachments: [...(prev.attachments ?? []), ref],
        updatedAt: Date.now(),
      };
      const tasks = data.tasks.slice();
      tasks[idx] = next;
      return [{ ...data, tasks }, next];
    });
  }

  // U13 附件：按落盘 path 从任务 attachments 移除一条引用（磁盘文件由调用方 assertDocPath 后 unlink）。
  // 同样在 mutate 锁内做，避免与并发 add/remove 竞争。任务不存在返回 null。
  removeAttachment(id: string, path: string): Promise<TaskMeta | null> {
    return this.mutate<TaskMeta | null>((data) => {
      const idx = data.tasks.findIndex((t) => t.id === id);
      if (idx < 0) return [data, null];
      const prev = data.tasks[idx];
      const next: TaskMeta = {
        ...prev,
        attachments: (prev.attachments ?? []).filter((a) => a.path !== path),
        updatedAt: Date.now(),
      };
      const tasks = data.tasks.slice();
      tasks[idx] = next;
      return [{ ...data, tasks }, next];
    });
  }

  // 物理删除（不可恢复，区别于 dropped 软标记，见计划 U4/U13）。
  // 子任务级联（U2/KTD5）：删含子任务的父 → 连同整棵后代子树一并删除（区别于 deleteProject 的「上提」——
  // 项目是容器故保命上提，子任务是父动作的子步骤故随父删除）。UI 侧对有子任务的删除先弹确认（U4）。
  delete(id: string): Promise<void> {
    return this.mutate<void>((data) => {
      const toRemove = new Set<string>([id, ...taskDescendantIds(data.tasks, id)]);
      return [{ ...data, tasks: data.tasks.filter((t) => !toRemove.has(t.id)) }, undefined];
    });
  }

  // U11：在 mutate 锁内条件写提醒 firedAt——仅当该任务的提醒**仍存在、at 匹配、且未触发**才写。
  // 这是「删提醒瞬间 Cron 触发」的权威守卫：调度器 fire 用的是陈旧闭包快照，若用普通 update
  // 会以旧 reminder 把用户刚删的提醒复活；本方法读锁内当前值，提醒已删/改时则 no-op。返回是否写入。
  markReminderFired(id: string, at: number, firedAt: number): Promise<boolean> {
    return this.mutate<boolean>((data) => {
      const idx = data.tasks.findIndex((t) => t.id === id);
      if (idx < 0) return [data, false];
      const t = data.tasks[idx];
      if (!t.reminder || t.reminder.at !== at || t.reminder.firedAt != null) return [data, false];
      const next = { ...t, reminder: { ...t.reminder, firedAt }, updatedAt: Date.now() };
      const tasks = data.tasks.slice();
      tasks[idx] = next;
      return [{ ...data, tasks }, true];
    });
  }

  // 新建 task-project（U2 加层级）：opts.parentId 挂到父下（父须存在，否则降级为顶层）；
  // opts.kind 缺省 "project"（folder 需显式传入）。
  // 阶段扩展：opts.stages 承接「创建项目时选模板」的实例化结果（renderer 侧 instantiateStages 产出），
  // 一次落库避免 add 后再 update 两跳；note/status 同理透传。
  addProject(
    name: string,
    opts?: { parentId?: string; kind?: TaskProjectKind; stages?: ProjectStage[]; note?: string; status?: TaskProjectStatus },
  ): Promise<TaskProject> {
    return this.mutate((data) => {
      const parentId =
        opts?.parentId && data.projects.some((p) => p.id === opts.parentId) ? opts.parentId : undefined;
      const proj: TaskProject = {
        id: newTaskId("proj"),
        name: name.trim(),
        parentId,
        kind: opts?.kind ?? "project",
        stages: opts?.stages,
        note: opts?.note,
        status: opts?.status,
      };
      return [{ ...data, projects: [...data.projects, proj] }, proj];
    });
  }

  // 更新 task-project（U2）：rename（name）+ reparent（parentId）+ 切换执行模式（mode，U8/KTD5）。
  // parentId 语义：省略 = 不改；null = 提升到顶层；string = 挂到该父下（父须存在 + 防环）。
  // mode 语义（U8）：省略 = 不改；"parallel"/"sequential" = 切换。复用既有 tasks:updateProject IPC 通道
  // （mode 随 patch 对象经 IPC 序列化透传，无新 IPC）；模式只影响可用性派生（纯前端），无级联落库。
  // 防环用 isDescendant（把节点挂到自身或其后代下）→ 抛错供 UI 捕获给 toast；项目不存在返回 null。
  // 阶段/设置扩展：note/status/stages 随 patch 透传（省略 = 不改）。**替换 stages 时在同一锁内
  // 清孤儿引用**——被删阶段 id 若仍被任务 stageId 引用，把这些任务的 stageId 置空（防悬空指向）。
  updateProject(
    id: string,
    patch: {
      name?: string;
      parentId?: string | null;
      mode?: TaskProjectMode;
      note?: string;
      status?: TaskProjectStatus;
      stages?: ProjectStage[];
    },
  ): Promise<TaskProject | null> {
    return this.mutate<TaskProject | null>((data) => {
      const idx = data.projects.findIndex((p) => p.id === id);
      if (idx < 0) return [data, null];
      const cur = data.projects[idx];
      let parentId = cur.parentId;
      if (patch.parentId !== undefined) {
        if (patch.parentId === null) {
          parentId = undefined; // 提升到顶层
        } else {
          if (!data.projects.some((p) => p.id === patch.parentId)) {
            throw new Error("目标父项目不存在");
          }
          if (isDescendant(data.projects, id, patch.parentId)) {
            throw new Error("不能把项目移到自身或其子级之下");
          }
          parentId = patch.parentId;
        }
      }
      const next: TaskProject = {
        ...cur,
        name: patch.name !== undefined ? patch.name.trim() : cur.name,
        parentId,
        mode: patch.mode !== undefined ? patch.mode : cur.mode,
        note: patch.note !== undefined ? patch.note : cur.note,
        status: patch.status !== undefined ? patch.status : cur.status,
        stages: patch.stages !== undefined ? patch.stages : cur.stages,
      };
      const projects = data.projects.slice();
      projects[idx] = next;
      // 阶段收缩的孤儿清理：仅当 stages 实际被替换时，找出「旧有、新无」的阶段 id，
      // 把该项目下仍引用它们的任务 stageId 清空。
      let tasks = data.tasks;
      if (patch.stages !== undefined) {
        const kept = new Set(patch.stages.map((s) => s.id));
        const removed = new Set((cur.stages ?? []).map((s) => s.id).filter((sid) => !kept.has(sid)));
        if (removed.size > 0) {
          const now = Date.now();
          tasks = data.tasks.map((t) =>
            t.stageId && removed.has(t.stageId) ? { ...t, stageId: undefined, updatedAt: now } : t,
          );
        }
      }
      return [{ ...data, projects, tasks }, next];
    });
  }

  // 删除 task-project（层级安全，U2/KTD2，替换旧扁平语义）：
  //   - 直属子节点（folder/project）提升到被删节点的父级（无父则顶层），不级联删整棵子树；
  //   - 直属任务（projectId === id）回 Inbox（projectId 置空），不删任务。
  deleteProject(projectId: string): Promise<void> {
    return this.mutate<void>((data) => {
      const target = data.projects.find((p) => p.id === projectId);
      const newParent = target?.parentId; // 提升到父级（undefined = 顶层）
      const now = Date.now();
      const projects = data.projects
        .filter((p) => p.id !== projectId)
        .map((p) => (p.parentId === projectId ? { ...p, parentId: newParent } : p));
      const tasks = data.tasks.map((t) =>
        t.projectId === projectId ? { ...t, projectId: undefined, updatedAt: now } : t,
      );
      return [{ ...data, projects, tasks }, undefined];
    });
  }

  // 归档一条 done/dropped 任务：摘要落 archived[]，从活动列表移除（U13/R27）。返回是否归档。
  // 仅 done/dropped 可归档（active/waiting/in-progress 拒绝，防误归档在办任务）。
  archive(id: string, summary: string): Promise<boolean> {
    return this.mutate<boolean>((data) => {
      const t = data.tasks.find((x) => x.id === id);
      if (!t || (t.status !== "done" && t.status !== "dropped")) return [data, false];
      const entry: ArchivedTask = {
        id: t.id,
        title: t.title,
        summary,
        originalStatus: t.status,
        archivedAt: Date.now(),
      };
      return [{ ...data, tasks: data.tasks.filter((x) => x.id !== id), archived: [...data.archived, entry] }, true];
    });
  }

  async listArchived(): Promise<ArchivedTask[]> {
    const data = await this.getData();
    return data.archived.slice();
  }

  // ── 团队成员（资源管理，参照 IFocus）────────────────────────────────────────
  // 顶层 members 可选：undefined 视为空库（读侧 ?? []），首次 add 才落盘该字段。

  async listMembers(): Promise<Member[]> {
    const data = await this.getData();
    return (data.members ?? []).slice();
  }

  addMember(input: { name: string; role?: string }): Promise<Member> {
    return this.mutate((data) => {
      const m: Member = { id: newTaskId("member"), name: input.name.trim(), role: input.role?.trim() || undefined };
      return [{ ...data, members: [...(data.members ?? []), m] }, m];
    });
  }

  updateMember(id: string, patch: { name?: string; role?: string }): Promise<Member | null> {
    return this.mutate<Member | null>((data) => {
      const members = data.members ?? [];
      const idx = members.findIndex((m) => m.id === id);
      if (idx < 0) return [data, null];
      const next: Member = {
        ...members[idx],
        name: patch.name !== undefined ? patch.name.trim() : members[idx].name,
        // role 传空串 = 清除岗位（与 undefined「不改」区分）。
        role: patch.role !== undefined ? patch.role.trim() || undefined : members[idx].role,
      };
      const list = members.slice();
      list[idx] = next;
      return [{ ...data, members: list }, next];
    });
  }

  // 删除成员：同一锁内级联把任务 memberIds 里的该 id 与其工时分配 memberHours[id] 一并移除
  // （防悬空引用；handler 侧需连带刷新任务）。
  deleteMember(id: string): Promise<void> {
    return this.mutate<void>((data) => {
      const now = Date.now();
      const tasks = data.tasks.map((t) => {
        const inIds = t.memberIds?.includes(id) ?? false;
        const inHours = t.memberHours != null && id in t.memberHours;
        if (!inIds && !inHours) return t;
        let memberHours = t.memberHours;
        if (inHours) {
          const { [id]: _removed, ...rest } = t.memberHours!;
          memberHours = Object.keys(rest).length ? rest : undefined;
        }
        return {
          ...t,
          memberIds: inIds ? t.memberIds!.filter((m) => m !== id) : t.memberIds,
          memberHours,
          updatedAt: now,
        };
      });
      return [{ ...data, members: (data.members ?? []).filter((m) => m.id !== id), tasks }, undefined];
    });
  }

  // ── 岗位标签库 ──────────────────────────────────────────────────────────────
  // 整表替换（低频、单编辑面）。首次 set 即落盘固化（含删空 []）；此前 undefined 由 core
  // resolveJobTypes 补默认——刻意不在读侧 backfill，保持默认表随 App 升级可演进。

  async listJobTypes(): Promise<string[] | undefined> {
    const data = await this.getData();
    return data.jobTypes?.slice();
  }

  setJobTypes(next: string[]): Promise<string[]> {
    return this.mutate((data) => {
      const cleaned = next.map((s) => s.trim()).filter((s) => s.length > 0);
      return [{ ...data, jobTypes: cleaned }, cleaned];
    });
  }

  // ── 自定义阶段模板 ──────────────────────────────────────────────────────────
  // 仅自定义模板落盘；内置模板是 core 常量（渲染时合并），故此处 CRUD 天然触不到内置。

  async listStageTemplates(): Promise<StageTemplate[]> {
    const data = await this.getData();
    return (data.stageTemplates ?? []).slice();
  }

  addStageTemplate(input: { name: string; description?: string; stages: string[] }): Promise<StageTemplate> {
    return this.mutate((data) => {
      const tpl: StageTemplate = {
        id: newTaskId("tpl"),
        name: input.name.trim(),
        description: input.description?.trim() || undefined,
        stages: input.stages.map((s) => s.trim()).filter((s) => s.length > 0),
      };
      return [{ ...data, stageTemplates: [...(data.stageTemplates ?? []), tpl] }, tpl];
    });
  }

  updateStageTemplate(
    id: string,
    patch: { name?: string; description?: string; stages?: string[] },
  ): Promise<StageTemplate | null> {
    return this.mutate<StageTemplate | null>((data) => {
      const list = data.stageTemplates ?? [];
      const idx = list.findIndex((t) => t.id === id);
      if (idx < 0) return [data, null];
      const cur = list[idx];
      const next: StageTemplate = {
        ...cur,
        name: patch.name !== undefined ? patch.name.trim() : cur.name,
        description: patch.description !== undefined ? patch.description.trim() || undefined : cur.description,
        stages:
          patch.stages !== undefined ? patch.stages.map((s) => s.trim()).filter((s) => s.length > 0) : cur.stages,
      };
      const templates = list.slice();
      templates[idx] = next;
      return [{ ...data, stageTemplates: templates }, next];
    });
  }

  // 删模板不影响已实例化项目（stages 是复制品、与模板解耦），仅从模板库消失。
  deleteStageTemplate(id: string): Promise<void> {
    return this.mutate<void>((data) => {
      return [{ ...data, stageTemplates: (data.stageTemplates ?? []).filter((t) => t.id !== id) }, undefined];
    });
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
