// ── 真任务系统 v2 类型（从 ipc/types.ts 抽出，见 U1/KTD3）──
// 抽离原因：core/desktop/types.ts 已逾 1200 行上限，两份镜像同步抽出。
// 与 packages/core/desktop/tasks-types.ts **逐字镜像**（镜像漂移是头号坑，改一处必改另一处）。
// 状态枚举：inbox 是「无 project 且未分诊」的计算态，不入此枚举。
export type TaskStatus = "active" | "in-progress" | "waiting" | "done" | "dropped";
// 任务来源：手动新建 / 快速捕获 / agent 产出。
export type TaskSource = "manual" | "capture" | "agent";

// 当前委派子结构。sessionId 供回写归属重校验；runId 供 killCli 取消（runId≠sessionId）。
export interface TaskDelegation {
  sessionId: string;
  runId?: string;
  state: "running" | "awaiting-confirm" | "failed";
  error?: string;
}

// task-project 的层级类型：folder 仅作分组容器、不直接容纳任务；project 可容纳任务、可再嵌子项目。
export type TaskProjectKind = "folder" | "project";

// task-project 是 tasks.json 内自持的一等分组实体，独立于工作区代码工程（v1 无路径）。
// 层级（U1）：parentId 指向父节点（folder 或 project 均可为父），缺省 = 顶层；
// kind 缺省视为 "project"（读时由 store normalizeData 补默认，见 U2）。
export interface TaskProject {
  id: string;
  name: string;
  parentId?: string; // 父 TaskProject.id；缺省/悬空 = 顶层
  kind?: TaskProjectKind; // 缺省 = project（folder 需显式标注）
}

// 一条任务。deferDate/dueDate 以本地日历日 YYYY-MM-DD 存储与比较。
export interface TaskMeta {
  id: string;
  title: string;
  notes?: string; // 正文内联（不为新任务建 tasks/<id>.md）
  status: TaskStatus;
  deferDate?: string; // YYYY-MM-DD 本地日历日
  dueDate?: string; // YYYY-MM-DD 本地日历日
  tags: string[]; // 已规范化
  projectId?: string; // 指向 TaskProject.id；缺省/悬空 = Inbox
  flagged?: boolean;
  source: TaskSource;
  delegation?: TaskDelegation;
  createdAt: number;
  updatedAt: number;
  migratedFrom?: string; // 迁移自旧 TodoMeta.id（溯源/幂等）
  // ── 富字段（U10-U13，全部可选、读时零迁移；详情渐进披露）──
  estimatedDuration?: number; // 预计时长（分钟，U10）
  completedAt?: number; // 置 done 时间戳（U10；权威由 main 状态迁移落点写）
  droppedAt?: number; // 置 dropped 时间戳（U10）
}

// 新建入参（id/时间戳由 store 生成）。
export interface TaskInput {
  title: string;
  notes?: string;
  projectId?: string;
  source?: TaskSource; // 缺省 manual
}

// 归档条目（done/dropped 压缩摘要，U13 产出）。
export interface ArchivedTask {
  id: string;
  title: string;
  summary: string;
  originalStatus: "done" | "dropped";
  archivedAt: number;
}

// tasks.json 全量形状（main-owned；version 独立于 personal-workspace.json）。
export interface TasksFileData {
  version: number;
  migratedAt?: number; // 迁移幂等闸门
  tasks: TaskMeta[];
  projects: TaskProject[];
  archived: ArchivedTask[];
}
