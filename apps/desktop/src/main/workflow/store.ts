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

// ── workflow-runs/<id>.json（按 workflowId 串行读-改-写）─────────────────────

function runsPath(workflowId: string): string {
  // SAFE_ID 防穿越：id 含 / .. 等字符会跳出 workflow-runs/ 目录读写任意文件。
  if (!SAFE_ID.test(workflowId)) throw new Error(`非法 workflow id: ${workflowId}`);
  return join(workflowRunsDir(), `${workflowId}.json`);
}

// runQueues：每个 workflowId 独立串行队列，避免同一工作流并发追加运行记录时相互覆盖。
// 不同 workflowId 之间互不阻塞，保持 IO 并发能力。
const runQueues = new Map<string, Promise<void>>();

export async function loadRuns(workflowId: string): Promise<WorkflowRun[]> {
  // SAFE_ID 校验在 try 外部：非法 id 应抛出（而非静默返回 []），
  // 让调用方感知到编程错误而不是以为文件不存在。
  const path = runsPath(workflowId);
  try {
    const raw = await fsp.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { runs?: WorkflowRun[] };
    return Array.isArray(parsed?.runs) ? parsed.runs : [];
  } catch {
    return []; // 首次或文件损坏
  }
}

// mutateRuns：读→变换→tmp+rename 原子写，在 workflowId 专属串行队列中执行。
// runsPath 在进入 Promise 链前同步调用，非法 id 立即抛出（同步）；
// 调用方（appendRun/deleteRun/updateRun）须包装成 Promise.reject 以兼容 async 调用。
function mutateRuns(
  workflowId: string,
  fn: (runs: WorkflowRun[]) => WorkflowRun[],
): Promise<void> {
  const path = runsPath(workflowId); // 非法 id 在此同步抛出
  const prev = runQueues.get(workflowId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const current = await loadRuns(workflowId);
      const updated = fn(current);
      await fsp.mkdir(workflowRunsDir(), { recursive: true });
      const tmp = path + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, runs: updated }), "utf8");
      await fsp.rename(tmp, path);
    })
    .catch((err) => console.error("[workflow-runs] save failed:", err));
  runQueues.set(workflowId, next);
  return next;
}

// 追加一条运行记录：最新在前 + 按 id 去重（重复 upsert 安全）+ 截断到 keepN。
// workflowId 单独传入（WorkflowRun 无 automationId 字段，故不能像 automation 一样用 run.automationId）。
// try/catch 把 runsPath 的同步 SAFE_ID 错误包装成 rejected Promise，让 async 调用方能 await 到。
export function appendRun(workflowId: string, run: WorkflowRun, keepN = DEFAULT_KEEP_RUNS): Promise<void> {
  try {
    return mutateRuns(workflowId, (runs) => {
      const deduped = [run, ...runs.filter((r) => r.id !== run.id)];
      return deduped.slice(0, keepN);
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

// 删除单条运行记录（按 id 过滤；不存在则无操作）。
export function deleteRun(workflowId: string, runId: string): Promise<void> {
  try {
    return mutateRuns(workflowId, (runs) => runs.filter((r) => r.id !== runId));
  } catch (err) {
    return Promise.reject(err);
  }
}

// 更新已有运行记录的部分字段（running → success/error 收尾）。
export function updateRun(
  workflowId: string,
  runId: string,
  patch: Partial<WorkflowRun>,
): Promise<void> {
  try {
    return mutateRuns(workflowId, (runs) =>
      runs.map((r) => (r.id === runId ? { ...r, ...patch } : r)),
    );
  } catch (err) {
    return Promise.reject(err);
  }
}

// 启动自愈：上次异常退出残留的 running 记录标 killed（进程已不在，不可能仍在跑）。
export async function markOrphanRunsKilled(): Promise<void> {
  const list = await loadWorkflows();
  for (const w of list) {
    const runs = await loadRuns(w.id);
    if (runs.some((r) => r.status === "running")) {
      await mutateRuns(w.id, (rs) =>
        rs.map((r) =>
          r.status === "running"
            ? { ...r, status: "error" as const, finishedAt: r.finishedAt || new Date().toISOString(), message: "进程异常退出" }
            : r,
        ),
      );
    }
  }
}
