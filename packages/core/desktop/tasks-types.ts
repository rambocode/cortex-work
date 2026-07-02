// ── 真任务系统 v2 类型（从 desktop/types.ts 抽出，见 U1/KTD3）──
// 抽离原因：desktop/types.ts 已逾 1200 行上限，继续内联富字段会加剧违规。
// 与 apps/desktop/src/main/ipc/tasks-types.ts **逐字镜像**（镜像漂移是头号坑，改一处必改另一处）。
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

// 任务提醒（U11）：到点触发一次原生桌面通知。
// at = 绝对 epoch ms 触发时刻；firedAt = 已触发时间戳（幂等闸门，避免重启/重排重复触发）。
// firedAt 是「只触发一次 / 只补跑一次」的唯一持久化闸门（automation 靠 enabled/lastRunAt，
// 任务侧无此语义，必须自建）。重设提醒时须清 firedAt 使其能再次触发。
export interface TaskReminder {
  at: number;
  firedAt?: number;
}

// 任务重复（U12）：完成后按周期滚动**同一任务**（顺延日期回 active），不新建实例、不留完成时间。
// 「结束重复」= 先清 repeat（选「无」）再完成才真正 done（滚动任务恒 active、永不进归档，已知限制）。
export interface TaskRepeat {
  // 单位含子日粒度（分/时，与天/周/月同级，U14）：
  //   minutely/hourly = 子日重复，锚在提醒时刻 reminder.at 按间隔顺延（纯日期无时分语义，故只能锚提醒）；
  //   daily/weekly/monthly = 日期重复，顺延 dueDate/deferDate。
  kind: "minutely" | "hourly" | "daily" | "weekly" | "monthly";
  interval?: number; // 每几分/时/天/周/月，缺省 1
  // ── 自定义重复（U14，全部可选；缺省/为空 → 按 interval 简单顺延，读时零迁移）──
  // custom!==true 时忽略下列所有细则；仅 weekly/monthly 有意义。细则缺失/为空时滚动逻辑回退简单顺延（防呆）。
  custom?: boolean;
  weekdays?: number[]; // weekly+custom：命中的星期几集合（0=周日 .. 6=周六）
  monthMode?: "day" | "weekday"; // monthly+custom 子模式：「月中的一天」/「周中的第 N 个星期几」
  monthDays?: Array<number | "last">; // monthMode=day：几号（1..31，或 "last"=当月最后一天）
  ordinal?: "1" | "2" | "3" | "4" | "5" | "last"; // monthMode=weekday：第几个
  weekday?: number; // monthMode=weekday：星期几（0..6）
}

// 任务附件（U13）：复用聊天文档附件闸门（doc.ts saveDocInto/assertDocPath）落盘，仅换存储根为
// task-docs。引用形状与聊天文档落盘结果一致（path 为 task-docs 根内绝对路径）。
// 本期仅收文档类型（pdf/docx/xlsx/pptx/csv/txt/md，由 extToDocExt allowlist 控制），图片附件延后。
export interface TaskAttachment {
  path: string; // 落盘绝对路径（taskDocsRoot()/<taskId>/<uuid>.<ext>），删除时经 assertDocPath 校验根边界
  name: string; // 原始文件名（仅显示，不参与落盘路径构造）
  mimeType: string;
  sizeBytes: number; // 主进程按真实字节数写入（非渲染端上报值）
}

// task-project 的层级类型：folder 仅作分组容器、不直接容纳任务；project 可容纳任务、可再嵌子项目。
export type TaskProjectKind = "folder" | "project";

// project 的执行模式（U8/KTD5）：parallel = 任务各自按 isAvailable 可用；
// sequential = 仅首个未完结顶层任务及其子树可用、其余阻塞（对齐 OmniFocus 顺序项目）。
// 可选字段，读时默认 parallel（store normalizeData 补默认，version 保持 1、零迁移）。
export type TaskProjectMode = "parallel" | "sequential";

// task-project 是 tasks.json 内自持的一等分组实体，独立于工作区代码工程（v1 无路径）。
// 层级（U1）：parentId 指向父节点（folder 或 project 均可为父），缺省 = 顶层；
// kind 缺省视为 "project"（读时由 store normalizeData 补默认，见 U2）。
export interface TaskProject {
  id: string;
  name: string;
  parentId?: string; // 父 TaskProject.id；缺省/悬空 = 顶层
  kind?: TaskProjectKind; // 缺省 = project（folder 需显式标注）
  mode?: TaskProjectMode; // 缺省 = parallel（U8；仅对可容纳任务的 project 有意义，folder 忽略）
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
  // ── 子任务层级（U1）：parentTaskId 指向父 TaskMeta.id，缺省/悬空 = 顶层任务。
  // 任意层级嵌套（无深度上限）；子任务是一等 TaskMeta，自带 projectId/dueDate/status。
  // 建树在渲染层两遍 Map 法即时组装，父不在 scope 则子升顶层（计算视图自然扁平，见 personal/taskTree）。
  parentTaskId?: string;
  // ── 富字段（U10-U13，全部可选、读时零迁移；详情渐进披露）──
  estimatedDuration?: number; // 预计时长（分钟，U10）
  completedAt?: number; // 置 done 时间戳（U10；权威由 main 状态迁移落点写）
  droppedAt?: number; // 置 dropped 时间戳（U10）
  reminder?: TaskReminder; // 定时提醒（U11；到点由 main 调度器投递原生通知，门控在「内部原生通知」opt-in）
  repeat?: TaskRepeat; // 重复（U12；完成即滚动同一任务顺延日期回 active）
  attachments?: TaskAttachment[]; // 附件引用（U13；复用文档附件闸门落盘，仅文档类型。旧档无此字段读为 undefined）
}

// 新建入参（id/时间戳由 store 生成）。
export interface TaskInput {
  title: string;
  notes?: string;
  projectId?: string;
  parentId?: string; // 父 TaskMeta.id（新建子任务，U2 store.add 透传落 parentTaskId）；缺省 = 顶层任务
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
