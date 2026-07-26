// 已批准研究记忆的写入与撤销（U10 / spec §14.2）。
//
// **设计要点：research 段是投影，不是可自由编辑的正文。**
// 它的真源是 sidecar `research-evidence.json`（candidateId → 条目），markdown 里的那一段
// 由 sidecar 整段渲染而来。这么做是为了让**撤销是精确的**：
// spec §14.2 明确要求「撤销只删除由对应 candidate 写入的 research 条目，不按文本模糊匹配」。
// 若把 research 段当自由文本，撤销就只能去正文里找相似句子删——用户手改过一个字就删不掉，
// 或者更糟，删错一条。
//
// 用户仍可以在 Finder 里手改那一段，但下一次批准/撤销会用 sidecar 重新渲染覆盖它；
// 这一点写在标记行的说明文字里，让用户知道那段是系统维护的。
//
// KTD10 红线：本模块的写入入口只接受**已批准**的候选。判定在调用方（IPC 层），
// 但这里再核一次 status，因为绕过它就等于把没批准的东西写进了长期记忆。
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { MemoryCandidate } from "@cortex-work/core/research/knowledge";
import type { UserMemoryScope } from "@cortex-work/core/memory/memory";

import { userMemoryDir } from "../paths";
import { createLogger } from "../log";

const log = createLogger("research-memory");

/// sidecar 文件名。与三个分区 .md 并列放在 memory 目录下——它描述的正是那些文件里的
/// research 段，放一起用户在 Finder 里也能看出关联。
const SIDECAR_FILE = "research-evidence.json";

/// 一条已批准的研究记忆及其 provenance。
export interface ResearchMemoryEntry {
  candidateId: string;
  knowledgeId: string;
  scope: UserMemoryScope;
  text: string;
  /// 支撑它的证据片段 id。撤销后仍保留在历史里没有意义，故随条目一起删。
  chunkIds: string[];
  approvedAt: string;
}

interface Sidecar {
  version: 1;
  entries: ResearchMemoryEntry[];
}

/// 每次新造空 sidecar，**不共享常量再浅拷贝**——那会让 entries 数组被所有调用方共用，
/// 一次 push 污染下一次的「空」结果（这个坑在 slides 的来源清单上真实踩过）。
function emptySidecar(): Sidecar {
  return { version: 1, entries: [] };
}

function sidecarPath(): string {
  return join(userMemoryDir(), SIDECAR_FILE);
}

/// 读 sidecar。缺失 / 损坏一律回空——它是可再生的派生数据（候选仍在 CRE SQLite 里），
/// 读坏了不该让整个记忆模块打不开。
export async function readResearchMemorySidecar(): Promise<Sidecar> {
  try {
    const raw = JSON.parse(await fsp.readFile(sidecarPath(), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptySidecar();
    const entries = (raw as { entries?: unknown }).entries;
    return { version: 1, entries: Array.isArray(entries) ? (entries as ResearchMemoryEntry[]) : [] };
  } catch {
    return emptySidecar();
  }
}

async function writeSidecar(sidecar: Sidecar): Promise<void> {
  const target = sidecarPath();
  const tmp = `${target}.tmp`;
  await fsp.mkdir(userMemoryDir(), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(sidecar, null, 2), "utf8");
  await fsp.rename(tmp, target);
}

/// 把某个分区的已批准条目渲染成 research 段正文。
///
/// 每条一个列表项 + 一行来源标注：模型读到的是「这条是研究结论，有 N 条证据支撑」，
/// 而不是一句没有出处的断言。**纯函数**，便于单测锁住格式。
export function renderResearchSection(entries: readonly ResearchMemoryEntry[]): string {
  if (entries.length === 0) return "";
  return entries
    .map((entry) => {
      const provenance = entry.chunkIds.length > 0 ? `（研究结论，${entry.chunkIds.length} 条证据支撑）` : "（研究结论）";
      return `- ${entry.text}${provenance}`;
    })
    .join("\n");
}

/// memory-store 的最小写入面（便于测试注入替身，不必构造真 UserMemoryStore）。
export interface ResearchMemorySink {
  setFile(scope: UserMemoryScope, patch: { research: string }): Promise<void>;
}

/// 按分区重新渲染并落盘。**整段覆盖**是刻意的：research 段的真源是 sidecar。
async function reprojectScope(
  sink: ResearchMemorySink,
  sidecar: Sidecar,
  scope: UserMemoryScope,
): Promise<void> {
  const entries = sidecar.entries.filter((entry) => entry.scope === scope);
  await sink.setFile(scope, { research: renderResearchSection(entries) });
}

/// 批准一条候选：写进 sidecar 并重投影该分区的 research 段。
///
/// **status 必须已经是 approved**：本函数不负责流转状态，它只落地「已批准」这个事实。
/// 传进一个非 approved 的候选是调用方的 bug，这里直接拒绝而不是"好心"帮它写进去。
export async function applyApprovedResearchMemory(
  sink: ResearchMemorySink,
  candidate: MemoryCandidate,
  chunkIds: readonly string[],
  approvedAt: string,
): Promise<void> {
  if (candidate.status !== "approved") {
    throw new Error(`拒绝写入未批准的记忆候选：${candidate.candidateId}（status=${candidate.status}）`);
  }
  const sidecar = await readResearchMemorySidecar();
  // 幂等：重复批准同一条不产生重复行。
  const index = sidecar.entries.findIndex((entry) => entry.candidateId === candidate.candidateId);
  const entry: ResearchMemoryEntry = {
    candidateId: candidate.candidateId,
    knowledgeId: candidate.knowledgeId,
    scope: candidate.scope,
    text: candidate.text,
    chunkIds: [...chunkIds],
    approvedAt,
  };
  if (index >= 0) sidecar.entries[index] = entry;
  else sidecar.entries.push(entry);

  await writeSidecar(sidecar);
  await reprojectScope(sink, sidecar, candidate.scope);
}

/// 撤销一条已批准的记忆：**按 candidateId 精确删除**，不做任何文本匹配（spec §14.2）。
///
/// 返回是否真的删掉了一条——调用方据此决定要不要提示「这条本来就不在记忆里」。
export async function revokeResearchMemory(
  sink: ResearchMemorySink,
  candidateId: string,
): Promise<boolean> {
  const sidecar = await readResearchMemorySidecar();
  const target = sidecar.entries.find((entry) => entry.candidateId === candidateId);
  if (!target) return false;

  sidecar.entries = sidecar.entries.filter((entry) => entry.candidateId !== candidateId);
  await writeSidecar(sidecar);
  await reprojectScope(sink, sidecar, target.scope);
  return true;
}

/// 清空全部已批准的研究记忆（设置页「清空研究记忆」）。
export async function clearResearchMemory(sink: ResearchMemorySink): Promise<void> {
  const sidecar = await readResearchMemorySidecar();
  const scopes = new Set(sidecar.entries.map((entry) => entry.scope));
  sidecar.entries = [];
  try {
    await writeSidecar(sidecar);
  } catch (err) {
    log.warn("[research-memory] 写 sidecar 失败", err instanceof Error ? err.name : "unknown");
  }
  for (const scope of scopes) await reprojectScope(sink, sidecar, scope);
}
