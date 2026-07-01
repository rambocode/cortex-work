// v1 legacy 待办 → v2 tasks.json 的 main 侧迁移编排（数据安全关键，见计划 U3/KTD2）。
// 严格定序（防源数据丢失）：
//   1. 强制 .bak 备份 personal-workspace.json（非可选；备份失败即中止，宁可不迁也不冒险）。
//   2. 读 personal-workspace.json 的 todos + projects。
//   3. tasksStore.migrateOnce：仅当 tasks.json 无 migratedAt 时执行纯映射并盖 migratedAt（幂等 no-op）。
//   4. 迁移成功落盘 tasks.json 之后，才把 personal-workspace.json 的 todos 剥离回写（源单一化）。
// **必须在 registerIpcHandlers（store:load/store:save/tasks:*）之前 eager + await 调用**：
// 使 renderer 的任何 store:load/save 都排在迁移之后处理——renderer 永远看不到未迁移的 todos，
// 从根上消除「renderer 首个 save 先于迁移抹掉源 todos」的竞态（研究 rank1）。
// personal-workspace.json **不 bump 版本**（仅移除 todos 字段，hydrate 已容忍缺省），
// 避免旧代码「版本不匹配→回退 EMPTY→空态覆盖」的静默丢数据链（KTD2）。

import { promises as fsp, readFileSync } from "fs";
import { dirname } from "path";
import { migrateLegacyTodos, type LegacyProjectRef, type LegacyTodo } from "@cortex-work/core/personal/taskMigrate";
import type { TasksFileData } from "./types";
import { workspaceStorePath } from "../paths";
import { emptyTasks, newTaskId } from "./tasks-store";
import { createLogger } from "../log";

const log = createLogger("tasks-migrate");

// 迁移只依赖 store 的 migrateOnce（幂等闸门），注入以便单测用真实 TasksStore + 临时文件。
interface MigrationStore {
  migrateOnce(build: () => TasksFileData): Promise<boolean>;
}

// 数据安全核心（可注入、可测）：备份→读→migrateOnce→成功后剥 todos。返回是否实际迁移。
export async function migrateWorkspaceTodos(store: MigrationStore, wsPath: string): Promise<boolean> {
  let rawWs: string;
  try {
    rawWs = await fsp.readFile(wsPath, "utf8");
  } catch {
    // 无 personal-workspace.json（全新安装）→ 无 legacy 待办可迁。
    return false;
  }

  let ws: Record<string, unknown>;
  try {
    ws = JSON.parse(rawWs) as Record<string, unknown>;
  } catch (e) {
    // personal-workspace 本身损坏：不碰它、跳过迁移（其自身加载逻辑另行处理）。
    log.error("personal-workspace.json 解析失败，跳过任务迁移:", e);
    return false;
  }

  const todos = (Array.isArray(ws.todos) ? ws.todos : []) as LegacyTodo[];
  if (todos.length === 0) return false; // 无待办可迁

  // 1. 强制备份（非可选）。备份失败即中止，绝不在无备份下改动源数据。
  try {
    await fsp.copyFile(wsPath, wsPath + ".bak");
  } catch (e) {
    log.error("备份 personal-workspace.json.bak 失败，中止迁移以防数据风险:", e);
    return false;
  }

  const projects: LegacyProjectRef[] = Array.isArray(ws.projects)
    ? (ws.projects as Array<{ id: string; name: string }>).map((p) => ({ id: p.id, name: p.name }))
    : [];

  // 2 + 3. 幂等迁移：仅当 tasks.json 无 migratedAt 时构建（对已迁移纯 no-op）。
  const migrated = await store.migrateOnce(() => {
    const { tasks, projects: taskProjects } = migrateLegacyTodos(todos, projects, {
      // 旧正文读取（同步，一次性 init）；缺失/损坏返回 null → 保任务空正文，不阻断整体。
      readBody: (detailPath) => {
        try {
          return readFileSync(detailPath, "utf8");
        } catch {
          return null;
        }
      },
      now: Date.now(),
      newId: newTaskId,
    });
    return { ...emptyTasks(), migratedAt: Date.now(), tasks, projects: taskProjects };
  });

  // 4. 迁移成功落盘 tasks.json 之后，才剥离 personal-workspace.todos 回写（原子写；不 bump 版本）。
  if (migrated) {
    const { todos: _dropTodos, ...rest } = ws;
    const tmp = wsPath + ".tmp";
    await fsp.mkdir(dirname(wsPath), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(rest, null, 2), "utf8");
    await fsp.rename(tmp, wsPath);
    log.info(`任务迁移完成：${todos.length} 条 legacy 待办 → tasks.json；personal-workspace.todos 已剥离。`);
  }
  return migrated;
}

// 主进程入口：绑真实单例 store + 真实路径。延迟 import tasks.ts（含 electron 绑定）到调用时，
// 使单测可只 import 本模块的 migrateWorkspaceTodos 而不拉起 electron 绑定层。
export async function runTaskMigration(): Promise<void> {
  const { tasksStore } = await import("./tasks");
  await migrateWorkspaceTodos(tasksStore, workspaceStorePath());
}
