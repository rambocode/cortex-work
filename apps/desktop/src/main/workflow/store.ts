// 工作流配置 + 执行历史持久化（仿 automation/store.ts:SAFE_ID + tmp+rename 原子写
// + 串行写队列）。配置单文件 workflows.json（内存缓存）；每个工作流的运行历史
// 一文件 workflow-runs/<id>.json（保留最近 N 条）。主进程是唯一写者。

import { promises as fsp } from "fs";
import { dirname, join } from "path";
import { workflowRunsDir, workflowsStorePath } from "../paths";
import type { WorkflowDef, WorkflowRun } from "./types";
import { normalizeWorkflow } from "./normalize";

// SAFE_ID 防路径穿越：workflow id / run id 只允许 [\w-] 字符，
// 确保拼出的文件名 workflow-runs/<id>.json 不能跳出目标目录。
const SAFE_ID = /^[\w-]+$/;

// 运行历史保留上限（与 automation/store.ts DEFAULT_KEEP_RUNS 对齐）。
const DEFAULT_KEEP_RUNS = 200;

// ── ID 生成 ───────────────────────────────────────────────────────────────────

let seq = 0;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}
export function newWorkflowId(): string {
  return uid("wf");
}
export function newRunId(): string {
  return uid("run");
}

// ── workflows.json（全量,内存缓存 + 串行写）──────────────────────────────────

let cache: WorkflowDef[] | null = null;
// writeChain 串行化全量写：避免并发写相互覆盖（同 automation/store.ts 模式）。
let writeChain: Promise<void> = Promise.resolve();

// load 时对每条跑 normalizeWorkflow：
// workflow DSL 可由外部导入（U15），normalize 确保字段合法、enum 值在范围内、
// 越界数值钳制，防止执行引擎收到格式错误的配置（automation 不需要同等规整，
// 因为其字段由内部 IPC 写入，不存在 DSL 导入场景）。
export async function loadWorkflows(): Promise<WorkflowDef[]> {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(workflowsStorePath(), "utf8");
    const parsed = JSON.parse(raw) as { version?: number; workflows?: unknown[] };
    const now = new Date().toISOString();
    cache = Array.isArray(parsed?.workflows)
      ? parsed.workflows.map((w, i) => normalizeWorkflow(w as Partial<WorkflowDef>, i, now))
      : [];
  } catch {
    cache = []; // 首次或损坏
  }
  return cache;
}

function persist(list: WorkflowDef[]): Promise<void> {
  cache = list;
  const path = workflowsStorePath();
  // 串行写链：每次 persist 追加到上一次写完成后，保证原子性顺序。
  writeChain = writeChain
    .then(async () => {
      // tmp+rename 原子写：写入临时文件后 rename，避免进程崩溃留下半写文件。
      await fsp.mkdir(dirname(path), { recursive: true });
      const tmp = path + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, workflows: list }, null, 2), "utf8");
      await fsp.rename(tmp, path);
    })
    .catch((err) => console.error("[workflow-store] save failed:", err));
  return writeChain;
}

export async function getWorkflow(id: string): Promise<WorkflowDef | undefined> {
  return (await loadWorkflows()).find((w) => w.id === id);
}

export async function upsertWorkflow(def: WorkflowDef): Promise<WorkflowDef> {
  const list = (await loadWorkflows()).slice();
  const idx = list.findIndex((w) => w.id === def.id);
  if (idx >= 0) list[idx] = def;
  else list.push(def);
  await persist(list);
  return def;
}

// 字段级合并（不碰 updatedAt:运行后更新 lastRunAt/lastStatus/nextRunAt 不算"配置修改"）。
export async function patchWorkflow(
  id: string,
  patch: Partial<WorkflowDef>,
): Promise<WorkflowDef | null> {
  const list = (await loadWorkflows()).slice();
  const idx = list.findIndex((w) => w.id === id);
  if (idx < 0) return null;
  const next: WorkflowDef = { ...list[idx], ...patch };
  list[idx] = next;
  await persist(list);
  return next;
}

export async function deleteWorkflow(id: string): Promise<void> {
  const list = (await loadWorkflows()).filter((w) => w.id !== id);
  await persist(list);
  // 同步删除对应的 runs 文件（忽略不存在的情况）。
  if (SAFE_ID.test(id)) {
    try {
      await fsp.rm(runsPath(id));
    } catch {
      // 没有历史文件，忽略
    }
  }
}

// ── 运行历史：持久化每个工作流的运行列表 workflow-runs/<id>.json（保留最近 N 条）────
//
// 内存缓存（最新在前，懒加载自磁盘）+ 每文件「读-改-写」串行链（tmp+rename 原子写）。
// 主进程是唯一写者；渲染端通过 onWorkflowRunEvent 实时收到 start/update/end，
// 并经 React Query 刷新拿到完整列表。进程重启后 markOrphanRunsKilled 把残留的
// "running"（上次异常退出的孤儿）收尾为 error，避免历史里出现永久「运行中」。

function runsPath(workflowId: string): string {
  if (!SAFE_ID.test(workflowId)) throw new Error(`非法 workflow id: ${workflowId}`);
  return join(workflowRunsDir(), `${workflowId}.json`);
}

// 非法 id 仍校验（防御 + 保持既有契约）：传入恶意/畸形 id 抛错而非静默处理。
function assertSafeId(workflowId: string): void {
  if (!SAFE_ID.test(workflowId)) throw new Error(`非法 workflow id: ${workflowId}`);
}

/** workflowId → 运行列表（最新在前）。懒加载自磁盘，加载后常驻内存。 */
const runsCache = new Map<string, WorkflowRun[]>();
// 每个工作流一条串行链：把「读-改-写」整体串行化，避免并发 append/update 互相覆盖。
const runsChain = new Map<string, Promise<unknown>>();

async function readRunsFile(workflowId: string): Promise<WorkflowRun[]> {
  try {
    const raw = await fsp.readFile(runsPath(workflowId), "utf8");
    const parsed = JSON.parse(raw) as { version?: number; runs?: unknown[] };
    return Array.isArray(parsed?.runs) ? (parsed.runs as WorkflowRun[]) : [];
  } catch {
    return []; // 首次或文件损坏
  }
}

async function ensureRunsLoaded(workflowId: string): Promise<WorkflowRun[]> {
  const cached = runsCache.get(workflowId);
  if (cached) return cached;
  const list = await readRunsFile(workflowId);
  runsCache.set(workflowId, list);
  return list;
}

async function writeRunsFile(workflowId: string, list: WorkflowRun[]): Promise<void> {
  const path = runsPath(workflowId);
  await fsp.mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, runs: list }, null, 2), "utf8");
  await fsp.rename(tmp, path);
}

// 串行化「读-改-写」：transform 返回新列表则更新缓存并落盘；返回 null 表示无变化。
function mutateRuns(
  workflowId: string,
  transform: (list: WorkflowRun[]) => WorkflowRun[] | null,
): Promise<void> {
  const prev = runsChain.get(workflowId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const list = await ensureRunsLoaded(workflowId);
      const updated = transform(list);
      if (!updated) return;
      runsCache.set(workflowId, updated);
      await writeRunsFile(workflowId, updated);
    })
    .catch((err) => console.error("[workflow-store] runs mutate failed:", err));
  runsChain.set(workflowId, next);
  return next;
}

export async function loadRuns(workflowId: string): Promise<WorkflowRun[]> {
  assertSafeId(workflowId);
  return (await ensureRunsLoaded(workflowId)).slice();
}

// 记录一次运行：前插到列表头（最新在前），按 id 去重，保留最近 keepN 条。
export function appendRun(
  workflowId: string,
  run: WorkflowRun,
  keepN = DEFAULT_KEEP_RUNS,
): Promise<void> {
  if (!SAFE_ID.test(workflowId)) {
    return Promise.reject(new Error(`非法 workflow id: ${workflowId}`));
  }
  return mutateRuns(workflowId, (list) => {
    const filtered = list.filter((r) => r.id !== run.id);
    return [run, ...filtered].slice(0, Math.max(1, keepN));
  });
}

// 更新某条运行的部分字段（running → success/error 收尾）。id 不匹配则忽略（返回 null）。
export function updateRun(
  workflowId: string,
  runId: string,
  patch: Partial<WorkflowRun>,
): Promise<void> {
  if (!SAFE_ID.test(workflowId)) {
    return Promise.reject(new Error(`非法 workflow id: ${workflowId}`));
  }
  return mutateRuns(workflowId, (list) => {
    const idx = list.findIndex((r) => r.id === runId);
    if (idx < 0) return null;
    const next = list.slice();
    next[idx] = { ...next[idx], ...patch };
    return next;
  });
}

// 删除某条运行记录。id 不存在则忽略（返回 null）。
export function deleteRun(workflowId: string, runId: string): Promise<void> {
  if (!SAFE_ID.test(workflowId)) {
    return Promise.reject(new Error(`非法 workflow id: ${workflowId}`));
  }
  return mutateRuns(workflowId, (list) => {
    const next = list.filter((r) => r.id !== runId);
    return next.length === list.length ? null : next;
  });
}

// 启动自愈：扫描所有运行文件，把残留的 "running"（上次异常退出的孤儿）收尾为 error，
// 避免历史里永久停在「运行中」。对齐 automation/store.ts markOrphanRunsKilled 思路。
export async function markOrphanRunsKilled(): Promise<void> {
  let files: string[];
  try {
    files = await fsp.readdir(workflowRunsDir());
  } catch {
    return; // 目录不存在 → 无历史
  }
  const now = new Date().toISOString();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const workflowId = file.slice(0, -5);
    if (!SAFE_ID.test(workflowId)) continue;
    await mutateRuns(workflowId, (list) => {
      let changed = false;
      const next = list.map((r) => {
        if (r.status !== "running") return r;
        changed = true;
        return {
          ...r,
          status: "error" as const,
          finishedAt: r.finishedAt || now,
          message: r.message || "进程重启，运行已中断",
        };
      });
      return changed ? next : null;
    });
  }
}
