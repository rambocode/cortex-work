// Tasks 面板「压缩清理」:把项目 tasks/ 目录按周期（周/月/年）分组,用
// 默认 Agent 整理成
// tasks/archive/<周期>.md,成功后删除原文件。
// 安全约束:未完成（open）任务文件跳过;总结失败/为空则中止,不删任何文件。

import type { DesktopBridge } from "../desktop/bridge";
import type { TaskFileInfo, TaskFilesResult, TodoMeta } from "../desktop/types";
import { completeWithDefaultAgent } from "./encourage";

export type ArchiveGranularity = "week" | "month" | "year";

export const ARCHIVE_GRANULARITIES: { value: ArchiveGranularity; label: string }[] = [
  { value: "week", label: "按周" },
  { value: "month", label: "按月" },
  { value: "year", label: "按年" },
];

// 单文件喂给总结模型的内容上限（防 prompt 过长）。
const MAX_DOC_CHARS = 12_000;

// 文件的周期归属时间:文件名 YYYY-MM-DD 前缀优先（任务文件命名惯例,
// 比 mtime 稳定——mtime 会被后续编辑刷新）,无前缀回退 mtime。
export function taskFileTime(file: TaskFileInfo): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(file.name);
  if (m) {
    const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  return file.mtimeMs;
}

// ISO 8601 周（周一为一周起始,1 月 4 日所在周为第 1 周）。
export function isoWeek(ts: number): { year: number; week: number } {
  const d = new Date(ts);
  // 用 UTC 日期运算,避免本地时区/夏令时引起的跨日漂移。
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7; // 周日按 7 算
  date.setUTCDate(date.getUTCDate() + 4 - day); // 移到本周四,其年份即 ISO 年
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return { year, week };
}

// 周期 key 即归档文件名主体:2026-W24 / 2026-06 / 2026。
export function periodKey(ts: number, granularity: ArchiveGranularity): string {
  const d = new Date(ts);
  if (granularity === "week") {
    const { year, week } = isoWeek(ts);
    return `${year}-W${String(week).padStart(2, "0")}`;
  }
  if (granularity === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return String(d.getFullYear());
}

// 归档产物自身不参与再次压缩（顶层若出现同名模式文件也排除）。
export function isArchiveFileName(name: string): boolean {
  return /^\d{4}(-W\d{2}|-\d{2})?\.md$/i.test(name);
}

export interface TaskFileGroup {
  key: string; // periodKey,如 2026-W24
  files: TaskFileInfo[];
}

// 按周期分组,组按 key 降序（新周期在前）,组内按归属时间升序。
export function groupTaskFiles(files: TaskFileInfo[], granularity: ArchiveGranularity): TaskFileGroup[] {
  const map = new Map<string, TaskFileInfo[]>();
  for (const file of files) {
    if (isArchiveFileName(file.name)) continue;
    const key = periodKey(taskFileTime(file), granularity);
    const list = map.get(key);
    if (list) list.push(file);
    else map.set(key, [file]);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, group]) => ({ key, files: group.sort((a, b) => taskFileTime(a) - taskFileTime(b)) }));
}

// 面板列表:tasks/ 顶层未登记为 todo 的普通 md（归档产物除外）。
export function unregisteredTaskFiles(files: TaskFileInfo[], todos: TodoMeta[]): TaskFileInfo[] {
  const known = new Set(todos.map((t) => t.detailPath));
  return files.filter((f) => !known.has(f.path) && !isArchiveFileName(f.name));
}

// 对账:detailPath 指向的文件已不在磁盘（被外部删除）的 todo —— 应连同元数据清理,
// 否则列表残留悬空条目,点击 readFile 触发 ENOENT。返回应 removeTodo 的 id。
// 仅判定:① 指定项目的 todo;② detailPath 非空（新建瞬间为空串、老数据为空时跳过）。
// detailPath 由 createTaskFile 生成,必为 tasks/<id>.md,文件存在即出现在扫描结果
// (files 顶层或 archived 归档)中,故「不在扫描结果」即文件已被删除。
export function staleTodoIds(scan: TaskFilesResult, todos: TodoMeta[], projectId: string): string[] {
  const known = new Set([...scan.files, ...scan.archived].map((f) => f.path));
  return todos
    .filter((t) => t.projectId === projectId && t.detailPath && !known.has(t.detailPath))
    .map((t) => t.id);
}

export function buildArchivePrompt(projectName: string, key: string, docs: { name: string; content: string }[]): string {
  const body = docs.map((d) => `===== FILE: ${d.name} =====\n${d.content.trim()}`).join("\n\n");
  return [
    `以下是项目「${projectName}」在 ${key} 周期内的任务记录文档,请整理成一份归档总结(Markdown,简体中文):`,
    `- 一级标题:# ${key} 任务归档`,
    "- 每个任务一个小节:任务名、做了什么、结果/结论、遗留问题(如有)",
    "- 保留关键技术细节与决策,删除冗余过程描述",
    "- 只输出整理后的 Markdown,不要任何额外说明",
    "",
    body,
  ].join("\n");
}

export interface ArchiveTaskFilesResult {
  archivePath: string;
  archivedCount: number;
  skippedOpen: number;
  // 归档后应从 store 移除的（已完成）todo id
  removedTodoIds: string[];
}

export async function archiveTaskFiles(opts: {
  bridge: DesktopBridge;
  projectPath: string;
  projectName: string;
  group: TaskFileGroup;
  todos: TodoMeta[];
  // 测试注入口；缺省使用应用默认 Agent。
  complete?: (bridge: DesktopBridge, prompt: string) => Promise<string>;
}): Promise<ArchiveTaskFilesResult> {
  const { bridge, projectPath, projectName, group, todos } = opts;
  const complete = opts.complete ?? completeWithDefaultAgent;

  const openPaths = new Set(todos.filter((t) => t.status === "open").map((t) => t.detailPath));
  const eligible = group.files.filter((f) => !openPaths.has(f.path));
  const skippedOpen = group.files.length - eligible.length;
  if (eligible.length === 0) throw new Error("该周期内没有可归档的文件（未完成任务已跳过）");

  const docs: { name: string; content: string }[] = [];
  for (const file of eligible) {
    const res = await bridge.readFile(file.path);
    docs.push({ name: file.name, content: res.content.slice(0, MAX_DOC_CHARS) });
  }

  const summary = (await complete(bridge, buildArchivePrompt(projectName, group.key, docs))).trim();
  if (!summary) throw new Error("总结模型返回空内容,已中止归档");

  // 同名归档已存在时追加（同周期分多次清理）,不覆盖。
  const archivePath = `${projectPath}/tasks/archive/${group.key}.md`;
  let existing = "";
  try {
    existing = (await bridge.readFile(archivePath)).content;
  } catch {
    /* 首次归档 */
  }
  const body = existing.trim() ? `${existing.trimEnd()}\n\n---\n\n${summary}\n` : `${summary}\n`;
  await bridge.writeFile(archivePath, body);

  // 归档写入成功后才删除原文件;对应的已完成 todo 一并报告给调用方移除。
  const doneByPath = new Map(todos.filter((t) => t.status === "done").map((t) => [t.detailPath, t.id]));
  const removedTodoIds: string[] = [];
  for (const file of eligible) {
    await bridge.deleteFile(file.path);
    const todoId = doneByPath.get(file.path);
    if (todoId) removedTodoIds.push(todoId);
  }
  return { archivePath, archivedCount: eligible.length, skippedOpen, removedTodoIds };
}
