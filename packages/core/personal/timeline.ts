// 项目时间线数据层。
// 存储事件（run / summary.day）落在 timeline/<projectId>.json，经 DesktopBridge
// 读写；session.created 由 SessionMeta 在读取时合成；git commit 由 gitLog 按需
// 合入展示。历史回填：首次加载且文件无 backfilledAt 时，扫描该项目已落盘的会话
// 消息生成 run 事件 —— 旧消息只有 HH:MM 无完整时间戳，统一归到 session 的
// updatedAt（最后活跃日），并打 meta.backfilled 标记。

import { useCallback, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Message } from "../types";
import type { DesktopBridge } from "../desktop/bridge";
import type {
  GitCommit,
  ProjectMeta,
  PushSettings,
  PushTarget,
  SessionMeta,
  TimelineEvent,
  TimelineFileData,
} from "../desktop/types";
import { useDesktopBridge } from "../provider";
import { usePersonalStore } from "../store/personal";

export const timelineKeys = {
  detail: (projectId: string) => ["personal", "timeline", projectId] as const,
  gitLog: (projectId: string) => ["personal", "timeline-git", projectId] as const,
};

// ── 纯函数：时间/聚合 ─────────────────────────────────────────────────────

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function hhmm(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface DayGroup {
  day: string; // YYYY-MM-DD
  events: TimelineEvent[]; // 按 ts 升序（不含 summary.day）
  summary?: TimelineEvent; // 该天的 AI 日报（若已生成）
  stats: DayStats;
}

export interface DayStats {
  sessions: number; // 新建会话数
  runs: number; // 交互轮次
  files: number; // 去重后的变更文件数
  commits: number;
}

// 按天分组并倒序（最近的天在前）；summary.day 提到天头部,不进事件流。
export function groupEventsByDay(events: TimelineEvent[]): DayGroup[] {
  const byDay = new Map<string, DayGroup>();
  const ensure = (day: string): DayGroup => {
    let g = byDay.get(day);
    if (!g) {
      g = { day, events: [], stats: { sessions: 0, runs: 0, files: 0, commits: 0 } };
      byDay.set(day, g);
    }
    return g;
  };
  for (const ev of events) {
    const day = ev.kind === "summary.day" && ev.meta?.day ? ev.meta.day : dayKey(ev.ts);
    const g = ensure(day);
    if (ev.kind === "summary.day") {
      // 同一天若有多条（重新生成）,保留 ts 最新的。
      if (!g.summary || ev.ts > g.summary.ts) g.summary = ev;
      continue;
    }
    g.events.push(ev);
  }
  for (const g of byDay.values()) {
    g.events.sort((a, b) => a.ts - b.ts);
    const files = new Set<string>();
    for (const ev of g.events) {
      if (ev.kind === "run") g.stats.runs += 1;
      if (ev.kind === "session.created") g.stats.sessions += 1;
      if (ev.kind === "git.commit") g.stats.commits += 1;
      for (const f of ev.files ?? []) files.add(f);
    }
    g.stats.files = files.size;
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

export interface CalendarCell {
  day: string; // YYYY-MM-DD
  date: number; // 几号
  inMonth: boolean;
  stats?: DayStats;
}

// 构建某月的周网格（周一为一周第一天）,附带每天统计。
// month: 0-11。
export function buildCalendarWeeks(year: number, month: number, groups: DayGroup[]): CalendarCell[][] {
  const statsByDay = new Map(groups.map((g) => [g.day, g.stats]));
  const first = new Date(year, month, 1);
  // getDay(): 0=周日 … 6=周六 → 周一起始的偏移。
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - lead);
  const weeks: CalendarCell[][] = [];
  const cursor = new Date(start);
  do {
    const week: CalendarCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const key = dayKey(cursor.getTime());
      week.push({
        day: key,
        date: cursor.getDate(),
        inMonth: cursor.getMonth() === month,
        stats: statsByDay.get(key),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  } while (cursor.getMonth() === month);
  return weeks;
}

// ── 纯函数：事件构造 ──────────────────────────────────────────────────────

export function promptTitle(text: string, max = 60): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line || "（空提示）";
}

export function clipSummary(text: string, max = 200): string | undefined {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

// 写类工具 → 从 detail（file_path）提取变更文件。Bash 等命令型工具不算。
const WRITE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|str_replace_editor)$/i;

export function extractChangedFile(toolName: string, detail: string | undefined, cwd: string): string | undefined {
  if (!detail || !WRITE_TOOLS.test(toolName)) return undefined;
  if (detail.endsWith("…")) return undefined; // 主进程截断过的路径不可信
  const root = cwd.replace(/[/\\]+$/, "");
  if (detail.startsWith(root + "/") || detail.startsWith(root + "\\")) return detail.slice(root.length + 1);
  return detail;
}

// 从 SessionMeta 合成 session.created 事件（不落盘）。
export function sessionCreatedEvents(sessions: SessionMeta[], projectId: string): TimelineEvent[] {
  return sessions
    .filter((s) => s.projectId === projectId)
    .map((s) => ({
      id: `sc-${s.id}`,
      projectId,
      sessionId: s.id,
      ts: s.createdAt,
      kind: "session.created" as const,
      title: s.title,
      meta: { agent: s.agent },
    }));
}

export function commitEvents(commits: GitCommit[], projectId: string): TimelineEvent[] {
  return commits.map((c) => ({
    id: `gc-${c.hash}`,
    projectId,
    ts: c.ts,
    kind: "git.commit" as const,
    title: c.subject,
    meta: { hash: c.hash },
  }));
}

// 历史回填：已落盘消息只有 HH:MM,无法还原具体日期,统一归到 session.updatedAt
// 所在天,叠加毫秒偏移保持轮次顺序。
export function deriveBackfillEvents(
  sessions: SessionMeta[],
  projectId: string,
  chatsBySession: Record<string, Message[]>,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const sess of sessions.filter((s) => s.projectId === projectId)) {
    const messages = chatsBySession[sess.id] ?? [];
    let idx = 0;
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i];
      if (!m || m.kind !== "text" || m.who !== "me" || typeof m.text !== "string") continue;
      const prompt = m.text;
      // 配对其后第一条 agent 文本作为结果摘要。
      let summary: string | undefined;
      for (let j = i + 1; j < messages.length; j += 1) {
        const n = messages[j];
        if (!n || n.kind !== "text") continue;
        if (n.who === "me") break;
        if (typeof n.text === "string") {
          summary = clipSummary(n.text);
          break;
        }
      }
      events.push({
        id: `bf-${sess.id}-${idx}`,
        projectId,
        sessionId: sess.id,
        ts: sess.updatedAt + idx,
        kind: "run",
        title: promptTitle(prompt),
        summary,
        meta: { agent: sess.agent, backfilled: true },
      });
      idx += 1;
    }
  }
  return events;
}

// ── 持久化（读-改-写按项目串行） ──────────────────────────────────────────

const writeQueues = new Map<string, Promise<void>>();

function emptyFile(): TimelineFileData {
  return { version: 1, events: [] };
}

function parseFile(raw: unknown): TimelineFileData | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as TimelineFileData;
  return Array.isArray(data.events) ? data : null;
}

// 串行化的读-改-写,并同步 React Query 缓存。
function mutateTimeline(
  qc: QueryClient,
  bridge: DesktopBridge,
  projectId: string,
  mutate: (data: TimelineFileData) => TimelineFileData,
): Promise<void> {
  const prev = writeQueues.get(projectId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const cached = qc.getQueryData<TimelineFileData>(timelineKeys.detail(projectId));
      const current = cached ?? parseFile(await bridge.loadTimeline(projectId)) ?? emptyFile();
      const updated = mutate(current);
      qc.setQueryData(timelineKeys.detail(projectId), updated);
      await bridge.saveTimeline(projectId, updated);
    })
    .catch((err) => {
      console.error("[personal-timeline] save failed:", err);
    });
  writeQueues.set(projectId, next);
  return next;
}

// 供 messages.ts 在一轮 CLI 结束时记录 run 事件（bridge 缺失时静默跳过）。
export function recordTimelineEvent(
  qc: QueryClient,
  bridge: DesktopBridge | null,
  projectId: string,
  event: TimelineEvent,
): void {
  if (!bridge) return;
  void mutateTimeline(qc, bridge, projectId, (data) => ({ ...data, events: [...data.events, event] }));
}

// ── Hooks ─────────────────────────────────────────────────────────────────

// 加载项目时间线；首次（无 backfilledAt）自动回填历史会话。
export function useProjectTimeline(project: ProjectMeta | undefined): {
  events: TimelineEvent[];
  loading: boolean;
} {
  const bridge = useDesktopBridge();
  const sessions = usePersonalStore((s) => s.sessions);
  const projectId = project?.id;

  const { data, isLoading } = useQuery<TimelineFileData>({
    queryKey: timelineKeys.detail(projectId ?? "none"),
    enabled: !!bridge && !!projectId,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async () => {
      if (!bridge || !projectId) return emptyFile();
      const existing = parseFile(await bridge.loadTimeline(projectId)) ?? emptyFile();
      if (existing.backfilledAt) return existing;
      // 首次打开：回填历史（旧 chat JSON → run 事件）,与已记录的新事件合并。
      const list = usePersonalStore.getState().sessions.filter((s) => s.projectId === projectId);
      const chats: Record<string, Message[]> = {};
      for (const sess of list) {
        try {
          chats[sess.id] = (await bridge.loadChat(sess.id)) as Message[];
        } catch {
          chats[sess.id] = [];
        }
      }
      const liveIds = new Set(existing.events.map((e) => e.id));
      const backfilled = deriveBackfillEvents(list, projectId, chats).filter((e) => !liveIds.has(e.id));
      const merged: TimelineFileData = {
        version: 1,
        backfilledAt: Date.now(),
        events: [...backfilled, ...existing.events],
      };
      await bridge.saveTimeline(projectId, merged);
      return merged;
    },
  });

  // git 提交按需拉取（非 git 仓库为空）;失败不影响主时间线。
  const { data: commits } = useQuery<GitCommit[]>({
    queryKey: timelineKeys.gitLog(projectId ?? "none"),
    enabled: !!bridge && !!project,
    staleTime: 60_000,
    queryFn: () => (bridge && project ? bridge.gitLog(project.path, { max: 300 }) : Promise.resolve([])),
  });

  if (!projectId) return { events: [], loading: false };
  const stored = data?.events ?? [];
  const synthesized = sessionCreatedEvents(sessions, projectId);
  const git = commitEvents(commits ?? [], projectId);
  return { events: [...stored, ...synthesized, ...git], loading: isLoading };
}

// 日报 prompt（生成路径共用）。
export function buildSummaryPrompt(projectName: string, group: DayGroup): string {
  const lines = group.events.map((ev) => {
    const files = ev.files?.length ? ` 文件:${ev.files.join(",")}` : "";
    const sum = ev.summary ? ` 结果:${ev.summary.slice(0, 120)}` : "";
    return `- [${ev.kind}] ${ev.title}${sum}${files}`;
  });
  return (
    `下面是我在项目「${projectName}」${group.day} 这天与 AI Agent 的协作记录。` +
    `请用中文写一段 3-5 句的工作日报,概括做了什么、改动了哪些方面,直接输出正文,不要标题和列表:\n\n` +
    lines.join("\n").slice(0, 4000)
  );
}

// 推送格式 Skill 的占位符数据（从一天的事件聚合,纯函数）。
export interface PushReportData {
  project: string;
  date: string;
  stats: string;
  summary: string;
  runs: string;
  files: string;
  commits: string;
}

export function buildPushReportData(projectName: string, group: DayGroup): PushReportData {
  const stats: string[] = [];
  if (group.stats.runs) stats.push(`${group.stats.runs} 轮交互`);
  if (group.stats.sessions) stats.push(`${group.stats.sessions} 个新会话`);
  if (group.stats.files) stats.push(`${group.stats.files} 个文件变更`);
  if (group.stats.commits) stats.push(`${group.stats.commits} 次提交`);
  const runs = group.events.filter((e) => e.kind === "run");
  const files = [...new Set(group.events.flatMap((e) => e.files ?? []))];
  const commits = group.events.filter((e) => e.kind === "git.commit");
  return {
    project: projectName,
    date: group.day,
    stats: stats.join(" · "),
    summary: group.summary?.summary ?? "",
    runs: runs.map((e) => `· ${e.title}`).join("\n"),
    files: files.map((f) => `· ${f}`).join("\n"),
    commits: commits.map((e) => `· ${e.meta?.hash?.slice(0, 7) ?? ""} ${e.title}`.trim()).join("\n"),
  };
}

// 用推送格式 Skill 模板渲染：{{占位符}} 替换;含占位符的行替换后为空则整行
// 剔除（数据缺失不留悬空行）;多余空行折叠;首行为推送标题。
export function renderPushReport(template: string, data: PushReportData): { subject: string; text: string } {
  const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
  const rendered = template
    .split("\n")
    .map((line) => {
      const hadPlaceholder = PLACEHOLDER.test(line);
      PLACEHOLDER.lastIndex = 0;
      const out = line.replace(PLACEHOLDER, (raw, key: string) =>
        key in data ? data[key as keyof PushReportData] : raw,
      );
      return { out, drop: hadPlaceholder && out.trim() === "" };
    })
    .filter((l) => !l.drop)
    .map((l) => l.out)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const firstLine = rendered.split("\n").find((l) => l.trim()) ?? "";
  // 标题剥掉 markdown 标记（# / **）,用作邮件主题等纯文本场景。
  const subject = firstLine.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
  return { subject, text: rendered };
}

// 内置默认模板（未配置格式 Skill 时使用;也是「创建示例 Skill」的内容）。
export const DEFAULT_PUSH_TEMPLATE = `【{{project}}】{{date}} 工作日报

{{stats}}

{{summary}}

今日事项:
{{runs}}
`;

// 日报分享文本（一键复制 / 推送共用）：未配置格式 Skill 时的默认渲染。
export function buildDailyReportText(projectName: string, group: DayGroup): { subject: string; text: string } {
  const data = buildPushReportData(projectName, group);
  // 无 AI 日报时退化为事项列表,有日报时正文已含概括,默认模板两者都带。
  return renderPushReport(DEFAULT_PUSH_TEMPLATE, data);
}

// AI 日报：按设置选择生成模型（集成 Agent 或 OpenAI 兼容端点）,落盘为 summary.day 事件。
export function useGenerateDaySummary(project: ProjectMeta | undefined): {
  generate: (group: DayGroup) => Promise<void>;
  generatingDay: string | null;
} {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  const [generatingDay, setGeneratingDay] = useState<string | null>(null);

  const generate = useCallback(
    async (group: DayGroup) => {
      if (!bridge || !project || generatingDay) return;
      setGeneratingDay(group.day);
      try {
        const prompt = buildSummaryPrompt(project.name, group);
        const cfg = usePersonalStore.getState().timelineSettings.summaryModel;
        const text =
          cfg.kind === "openai"
            ? await bridge.openaiComplete({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, prompt })
            : await bridge.oneshotCli({ prompt, agent: cfg.agent, model: cfg.model });
        const summary = text.trim();
        if (!summary) return;
        const event: TimelineEvent = {
          id: `ds-${project.id}-${group.day}-${Date.now().toString(36)}`,
          projectId: project.id,
          ts: Date.now(),
          kind: "summary.day",
          title: "AI 日报",
          summary,
          meta: { day: group.day },
        };
        await mutateTimeline(qc, bridge, project.id, (data) => ({
          ...data,
          // 同一天重新生成时替换旧日报。
          events: [...data.events.filter((e) => !(e.kind === "summary.day" && e.meta?.day === group.day)), event],
        }));
      } finally {
        setGeneratingDay(null);
      }
    },
    [bridge, project, qc, generatingDay],
  );

  return { generate, generatingDay };
}

// 全局推送设置 → 已启用的推送目标列表（纯函数,便于测试）。
export function enabledPushTargets(push: PushSettings): { label: string; target: PushTarget }[] {
  const out: { label: string; target: PushTarget }[] = [];
  const { wecom, dingtalk, email } = push;
  if (wecom?.enabled && wecom.webhookUrl) {
    out.push({ label: "企业微信", target: { kind: "wecom", webhookUrl: wecom.webhookUrl } });
  }
  if (dingtalk?.enabled && dingtalk.webhookUrl) {
    out.push({
      label: "钉钉",
      target: { kind: "dingtalk", webhookUrl: dingtalk.webhookUrl, secret: dingtalk.secret || undefined },
    });
  }
  if (email?.enabled && email.smtpHost && email.to) {
    const { enabled: _enabled, ...smtp } = email;
    out.push({ label: "邮件", target: { kind: "email", smtp } });
  }
  return out;
}

// 推送日报到所有启用渠道,返回每个渠道的结果文案（成功/失败）。
export function usePushDailyReport(project: ProjectMeta | undefined): {
  push: (group: DayGroup) => Promise<string[]>;
  pushing: boolean;
  channelCount: number;
} {
  const bridge = useDesktopBridge();
  const pushSettings = usePersonalStore((s) => s.pushSettings);
  const [pushing, setPushing] = useState(false);
  const targets = enabledPushTargets(pushSettings);

  const push = useCallback(
    async (group: DayGroup): Promise<string[]> => {
      if (!bridge || !project) return [];
      const list = enabledPushTargets(usePersonalStore.getState().pushSettings);
      if (list.length === 0) return ["未启用任何推送渠道,请先在 设置 → 推送 中配置"];
      setPushing(true);
      try {
        // 配置了推送格式 Skill 则按模板渲染;读取失败回退默认格式。
        const skillPath = usePersonalStore.getState().pushSettings.formatSkillPath;
        let payload = buildDailyReportText(project.name, group);
        if (skillPath) {
          try {
            const { content } = await bridge.readFile(skillPath);
            payload = renderPushReport(content, buildPushReportData(project.name, group));
          } catch {
            // skill 文件被移动/删除时不阻塞推送,使用默认格式。
          }
        }
        const results = await Promise.all(
          list.map(async ({ label, target }) => {
            try {
              const res = await bridge.pushReport(target, payload);
              return res.ok ? `${label} 推送成功` : `${label} 推送失败:${res.error ?? "未知错误"}`;
            } catch (err) {
              return `${label} 推送失败:${err instanceof Error ? err.message : String(err)}`;
            }
          }),
        );
        return results;
      } finally {
        setPushing(false);
      }
    },
    [bridge, project],
  );

  return { push, pushing, channelCount: targets.length };
}
