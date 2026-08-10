import type { SessionMeta } from "../desktop/types";

// 已归档会话分区/搜索纯函数（设置页「已归档对话」分区消费）。
// 镜像 partitionProjects 的稳定 tiebreak 思路:同 archivedAt 时以原数组下标兜底,
// 不依赖 Array.prototype.sort 的稳定性。

export interface ArchivedGroup {
  // 关联项目 id;缺省 = 无项目会话(归到末尾的「无项目」组)。
  projectId?: string;
  sessions: SessionMeta[];
}

export interface ArchivedPartition {
  groups: ArchivedGroup[];
  // 过滤前的归档会话总数(供「N 个已归档」chip,搜索时不变)。
  archivedTotal: number;
  // 应用 query 过滤后的会话数(供「搜索无结果」空态判断;无 query 时等于 archivedTotal)。
  filteredTotal: number;
}

// 按 projectId 分组的归档会话。groups 仅含过滤后仍有会话的组(空组被剔除),
// 组顺序按 projectId 在过滤结果中的首次出现序,「无项目」组恒在末尾;组内按
// archivedAt 降序(下标稳定 tiebreak)。
export function partitionArchivedSessions(
  sessions: SessionMeta[],
  query?: string,
): ArchivedPartition {
  // 记录原始下标作为稳定 tiebreak。
  const idx = new Map<SessionMeta, number>();
  sessions.forEach((s, i) => idx.set(s, i));
  const order = (a: SessionMeta, b: SessionMeta) => (idx.get(a) ?? 0) - (idx.get(b) ?? 0);

  const archived = sessions.filter((s) => s.relation !== "side" && s.archivedAt != null);
  const archivedTotal = archived.length;

  const q = query?.trim().toLowerCase() ?? "";
  const filtered = q
    ? archived.filter((s) => s.title.toLowerCase().includes(q))
    : archived;
  const filteredTotal = filtered.length;

  // 按 projectId 分组,保留首次出现序;无 projectId 单独成「无项目」组。
  const byProject = new Map<string, SessionMeta[]>();
  const noProject: SessionMeta[] = [];
  for (const s of filtered) {
    if (s.projectId == null) {
      noProject.push(s);
    } else {
      const bucket = byProject.get(s.projectId);
      if (bucket) bucket.push(s);
      else byProject.set(s.projectId, [s]);
    }
  }

  const sortGroup = (arr: SessionMeta[]) =>
    arr.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || order(a, b));

  const groups: ArchivedGroup[] = [];
  for (const [projectId, arr] of byProject) {
    groups.push({ projectId, sessions: sortGroup(arr) });
  }
  if (noProject.length > 0) {
    groups.push({ projectId: undefined, sessions: sortGroup(noProject) });
  }

  return { groups, archivedTotal, filteredTotal };
}
