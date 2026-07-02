// v1 legacy 待办 → v2 TaskMeta 的纯迁移映射（无 IO：正文读取经 readBody 注入）。
// 数据安全关键路径的算法核心（编排/定序/备份在 main 侧 tasks-migrate.ts，见计划 U3/KTD2）。
// 规则：
//   - status: open→active、done→done。
//   - projectId：若旧 projectId 在 legacy projects[] 中存在 → 按其名新建对应 task-project（同一
//     旧 projectId 复用同一 task-project）；孤儿 projectId（不在 projects[]）→ 落 Inbox（置空）。
//   - 正文：读旧 tasks/<id>.md（detailPath）截断后入 notes；缺失/损坏(readBody 返回 null) → 保任务
//     空正文，绝不因单文件坏而丢任务或阻断整体迁移。
//   - migratedFrom 记旧 id，供溯源（与 main 侧 migratedAt 幂等闸门配合）。

import type { TaskMeta, TaskProject } from "../desktop/types";

// 照 taskArchive 的 MAX_DOC_CHARS：迁移正文入库前截断，防超长。
export const MAX_NOTE_CHARS = 12_000;

// 迁移只需旧 todo 的这些字段；projects 只需 id+name 解析分组名。
export interface LegacyTodo {
  id: string;
  projectId?: string;
  title: string;
  status: "open" | "done";
  detailPath?: string;
  createdAt?: number;
  updatedAt?: number;
}
export interface LegacyProjectRef {
  id: string;
  name: string;
}

export interface MigrateResult {
  tasks: TaskMeta[];
  projects: TaskProject[];
}

export function migrateLegacyTodos(
  todos: readonly LegacyTodo[],
  projects: readonly LegacyProjectRef[],
  deps: {
    readBody: (detailPath: string) => string | null; // 缺失/损坏返回 null
    now: number;
    newId: (prefix: "task" | "proj") => string;
  },
): MigrateResult {
  const nameByLegacyProject = new Map(projects.map((p) => [p.id, p.name]));
  // 旧 projectId → 新建的 task-project（同一旧 project 只建一个）。
  const taskProjectByLegacy = new Map<string, TaskProject>();
  const outProjects: TaskProject[] = [];

  const tasks: TaskMeta[] = todos.map((todo) => {
    let projectId: string | undefined;
    const name = todo.projectId ? nameByLegacyProject.get(todo.projectId) : undefined;
    if (todo.projectId && name) {
      let tp = taskProjectByLegacy.get(todo.projectId);
      if (!tp) {
        tp = { id: deps.newId("proj"), name };
        taskProjectByLegacy.set(todo.projectId, tp);
        outProjects.push(tp);
      }
      projectId = tp.id;
    }
    // 否则（无 projectId 或孤儿 projectId）→ Inbox（projectId 保持 undefined）。

    let notes: string | undefined;
    if (todo.detailPath) {
      const body = deps.readBody(todo.detailPath);
      if (body != null && body.trim()) notes = body.slice(0, MAX_NOTE_CHARS);
    }

    return {
      id: deps.newId("task"),
      title: todo.title,
      notes,
      status: todo.status === "done" ? "done" : "active",
      tags: [],
      projectId,
      source: "manual",
      createdAt: todo.createdAt ?? deps.now,
      updatedAt: todo.updatedAt ?? deps.now,
      migratedFrom: todo.id,
    };
  });

  return { tasks, projects: outProjects };
}
