// 自动化配置 + 执行历史持久化（仿 ipc/timeline.ts:SAFE_ID + tmp+rename 原子写
// + 串行写队列）。配置单文件 automations.json（内存缓存）;每个自动化的运行历史
// 一文件 automation-runs/<id>.json（保留最近 N 条）。主进程是唯一写者。

import { promises as fsp } from "fs";
import { dirname, join } from "path";
import { automationRunsDir, automationsStorePath } from "../paths";
import type { AutomationMeta, AutomationRun } from "../ipc/types";

const SAFE_ID = /^[\w-]+$/;
// 运行历史保留上限。放宽到 200 以支撑前端「分页加载」（旧值 50 翻不了几页）;
// 单条 output 已在 runner 侧截断,200 条磁盘占用可控。
const DEFAULT_KEEP_RUNS = 200;

let seq = 0;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}
export function newAutomationId(): string {
  return uid("auto");
}
export function newRunId(): string {
  return uid("run");
}

// ── automations.json（全量,内存缓存 + 串行写）────────────────────────────

let cache: AutomationMeta[] | null = null;
let writeChain: Promise<void> = Promise.resolve();

// 旧档字段名 piChannelId → providerId（剥离旧名,与 personal store 的 session 迁移一致）。
function migrateAutomation(meta: AutomationMeta): AutomationMeta {
  const legacy = meta as AutomationMeta & { piChannelId?: string };
  if (legacy.piChannelId === undefined) return meta;
  const { piChannelId, ...rest } = legacy;
  return { ...rest, providerId: rest.providerId ?? piChannelId };
}

export async function loadAutomations(): Promise<AutomationMeta[]> {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(automationsStorePath(), "utf8");
    const parsed = JSON.parse(raw) as { version?: number; automations?: AutomationMeta[] };
    cache = Array.isArray(parsed?.automations) ? parsed.automations.map(migrateAutomation) : [];
  } catch {
    cache = []; // 首次或损坏
  }
  return cache;
}

function persist(list: AutomationMeta[]): Promise<void> {
  cache = list;
  const path = automationsStorePath();
  writeChain = writeChain
    .then(async () => {
      await fsp.mkdir(dirname(path), { recursive: true });
      const tmp = path + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, automations: list }, null, 2), "utf8");
      await fsp.rename(tmp, path);
    })
    .catch((err) => console.error("[automation-store] save failed:", err));
  return writeChain;
}

export async function getAutomation(id: string): Promise<AutomationMeta | undefined> {
  return (await loadAutomations()).find((a) => a.id === id);
}

export async function upsertAutomation(meta: AutomationMeta): Promise<AutomationMeta> {
  const list = (await loadAutomations()).slice();
  const idx = list.findIndex((a) => a.id === meta.id);
  if (idx >= 0) list[idx] = meta;
  else list.push(meta);
  await persist(list);
  return meta;
}

// 字段级合并（不碰 updatedAt:运行后更新 lastRunAt/lastStatus/nextRunAt 不算"配置修改"）。
export async function patchAutomation(
  id: string,
  patch: Partial<AutomationMeta>,
): Promise<AutomationMeta | null> {
  const list = (await loadAutomations()).slice();
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const next: AutomationMeta = { ...list[idx], ...patch };
  list[idx] = next;
  await persist(list);
  return next;
}

export async function deleteAutomationStore(id: string): Promise<void> {
  const list = (await loadAutomations()).filter((a) => a.id !== id);
  await persist(list);
  if (SAFE_ID.test(id)) {
    try {
      await fsp.rm(runsPath(id));
    } catch {
      // 没有历史文件,忽略
    }
  }
}

// ── automation-runs/<id>.json（按 automationId 串行读-改-写）──────────────

function runsPath(automationId: string): string {
  if (!SAFE_ID.test(automationId)) throw new Error(`非法 automation id: ${automationId}`);
  return join(automationRunsDir(), `${automationId}.json`);
}

const runQueues = new Map<string, Promise<void>>();

export async function loadRuns(automationId: string): Promise<AutomationRun[]> {
  try {
    const raw = await fsp.readFile(runsPath(automationId), "utf8");
    const parsed = JSON.parse(raw) as { runs?: AutomationRun[] };
    return Array.isArray(parsed?.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
}

function mutateRuns(
  automationId: string,
  fn: (runs: AutomationRun[]) => AutomationRun[],
): Promise<void> {
  const path = runsPath(automationId);
  const prev = runQueues.get(automationId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const current = await loadRuns(automationId);
      const updated = fn(current);
      await fsp.mkdir(automationRunsDir(), { recursive: true });
      const tmp = path + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, runs: updated }), "utf8");
      await fsp.rename(tmp, path);
    })
    .catch((err) => console.error("[automation-runs] save failed:", err));
  runQueues.set(automationId, next);
  return next;
}

// 追加一条运行记录:最新在前 + 按 id 去重（重复 upsert 安全）+ 截断到 keepN。
export function appendRun(run: AutomationRun, keepN = DEFAULT_KEEP_RUNS): Promise<void> {
  return mutateRuns(run.automationId, (runs) => {
    const deduped = [run, ...runs.filter((r) => r.id !== run.id)];
    return deduped.slice(0, keepN);
  });
}

// 删除单条运行记录（复用串行写队列,按 id 过滤;不存在则无操作）。
export function deleteRun(automationId: string, runId: string): Promise<void> {
  return mutateRuns(automationId, (runs) => runs.filter((r) => r.id !== runId));
}

// 更新已有运行记录的部分字段（running → ok/error/timeout 收尾）。
export function updateRun(
  automationId: string,
  runId: string,
  patch: Partial<AutomationRun>,
): Promise<void> {
  return mutateRuns(automationId, (runs) =>
    runs.map((r) => (r.id === runId ? { ...r, ...patch } : r)),
  );
}

// 启动自愈:上次异常退出残留的 running 记录标 killed（进程已不在,不可能仍在跑）。
export async function markOrphanRunsKilled(): Promise<void> {
  const list = await loadAutomations();
  for (const a of list) {
    const runs = await loadRuns(a.id);
    if (runs.some((r) => r.status === "running")) {
      await mutateRuns(a.id, (rs) =>
        rs.map((r) =>
          r.status === "running" ? { ...r, status: "killed", endedAt: r.endedAt ?? Date.now() } : r,
        ),
      );
    }
  }
}
