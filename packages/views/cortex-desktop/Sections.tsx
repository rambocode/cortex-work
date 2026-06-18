import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  agentActivity30dOptions,
  agentListOptions,
  agentRunCounts30dOptions,
  agentTaskSnapshotOptions,
  dashboardAgentRunTimeOptions,
  dashboardRunTimeDailyOptions,
  dashboardUsageByAgentOptions,
  dashboardUsageDailyOptions,
  issueListOptions,
  useCortexUIStore,
  useCoreContext,
  useWorkspaceId,
} from "@cortex-work/core";
import type {
  AgentActivityBucket,
  AgentRunCount,
  AgentTask,
  DashboardAgentRunTime,
  DashboardRunTimeDaily,
  DashboardUsageByAgent,
  DashboardUsageDaily,
  Issue,
  IssuePriority,
  IssueStatus,
  LiveAgent,
} from "@cortex-work/core";

function MulticaPageShell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <main className={`chat section mc-page ${className}`}>{children}</main>;
}

function InlineState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="section-empty">
      <div className="section-empty-title">{title}</div>
      {detail ? <div className="section-empty-detail">{detail}</div> : null}
    </div>
  );
}

const ISSUE_STATUS: { id: IssueStatus; labelKey: string; cls: string }[] = [
  { id: "backlog", labelKey: "sections.issueStatus.backlog", cls: "s-gray" },
  { id: "todo", labelKey: "sections.issueStatus.todo", cls: "s-blue" },
  { id: "in_progress", labelKey: "sections.issueStatus.inProgress", cls: "s-amber" },
  { id: "in_review", labelKey: "sections.issueStatus.inReview", cls: "s-green" },
];

const PRIORITY_LABEL_KEY: Record<IssuePriority, string> = {
  urgent: "sections.priority.urgent",
  high: "sections.priority.high",
  medium: "sections.priority.medium",
  low: "sections.priority.low",
  none: "sections.priority.none",
};

function TasksPage() {
  const { t } = useTranslation();
  const wsId = useWorkspaceId();
  const { apiClient, liveDataEnabled } = useCoreContext();
  const query = useQuery(issueListOptions(wsId, apiClient));
  const issues = query.data?.issues ?? [];
  const open = issues.filter((i) => !["done", "cancelled"].includes(i.status)).length;

  if (!liveDataEnabled) return <DemoTasksPage />;

  return (
    <MulticaPageShell className="issue-page">
      <IssuePageHeader total={issues.length} open={open} detail={query.isLoading ? t("sections.loadingIssue") : t("sections.allIssues")} />
      <div className="section-body mc-section-body">
        {query.isError ? (
          <InlineState title={t("sections.taskLoadFailed")} detail={query.error instanceof Error ? query.error.message : t("sections.taskLoadFailedDetail")} />
        ) : query.isLoading ? (
          <InlineState title={t("sections.loadingTasks")} />
        ) : (
          <IssueBoard issues={issues} />
        )}
      </div>
    </MulticaPageShell>
  );
}

function IssuePageHeader({ total, open, detail }: { total: number; open: number; detail: string }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="issue-breadcrumb">
        <span className="crumb-pill">D</span>
        <span>dx</span>
        <Icon.ChevronRight size={13} />
        <strong>issue</strong>
      </div>
      <div className="issue-filterbar">
        <div className="mc-chip-group">
          <button className="mc-chip is-active">{t("sections.all")}</button>
          <button className="mc-chip">{t("sections.members")}</button>
          <button className="mc-chip">{t("sections.agents")}</button>
        </div>
        <div className="mc-spacer" />
        <button className="mc-icon-btn" aria-label={t("sections.filter")}>
          <Icon.Search size={14} />
        </button>
        <button className="mc-icon-btn" aria-label={t("sections.sort")}>
          <Icon.Settings size={14} />
        </button>
        <button className="mc-icon-btn" aria-label={t("sections.columnSettings")}>
          <Icon.Sidebar size={14} />
        </button>
      </div>
      <div className="issue-context">
        <span>{detail}</span>
        <span className="issue-context-count">{open} / {total}</span>
      </div>
    </>
  );
}

function IssueBoard({ issues }: { issues: Issue[] }) {
  const { t } = useTranslation();
  return (
    <div className="issue-board multica-issue-board">
      {ISSUE_STATUS.map((status) => {
        const list = issues.filter((i) => i.status === status.id);
        const statusLabel = t(status.labelKey);
        return (
          <div key={status.id} className={`issue-col issue-col-${status.id}`}>
            <div className="issue-col-h">
              <span className={`issue-status-dot ${status.cls}`} />
              <span className="issue-col-title">{statusLabel}</span>
              <span className="issue-count">{list.length}</span>
              <button className="mc-icon-btn issue-col-action" aria-label={t("sections.moreAria", { name: statusLabel })}>
                <Icon.More size={13} />
              </button>
              <button className="mc-icon-btn issue-col-action" aria-label={t("sections.newAria", { name: statusLabel })}>
                <Icon.Plus size={13} />
              </button>
            </div>
            <div className="issue-cards">
              {list.length === 0 ? <div className="issue-empty">{t("sections.noIssue")}</div> : null}
              {list.slice(0, 12).map((issue) => <IssueCard key={issue.id} issue={issue} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function IssueCard({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  return (
    <div className="issue-card">
      <div className="issue-card-top">
        <span className="issue-key">{issue.identifier || `#${issue.number}`}</span>
      </div>
      <div className="issue-title">{issue.title}</div>
      {issue.description ? <div className="issue-desc">{issue.description}</div> : null}
      <div className="issue-meta">
        <span className="agent-avatar-mini">C</span>
        <span className={`issue-priority p-${issue.priority}`}>
          <Icon.Chart size={11} />
          {t(PRIORITY_LABEL_KEY[issue.priority])}
        </span>
        {issue.due_date ? <span className="issue-due">{t("sections.due", { date: shortDate(issue.due_date) })}</span> : null}
      </div>
      {issue.labels?.length ? (
        <div className="issue-labels">
          {issue.labels.slice(0, 3).map((label) => (
            <span key={label.id} className="issue-label" style={{ borderColor: label.color }}>
              {label.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DemoTasksPage() {
  const { t } = useTranslation();
  const open = MOCK_ISSUES.filter((i) => !["done", "cancelled"].includes(i.status)).length;
  return (
    <MulticaPageShell className="issue-page">
      <IssuePageHeader total={MOCK_ISSUES.length} open={open} detail={t("sections.allIssues")} />
      <div className="section-body mc-section-body">
        <IssueBoard issues={MOCK_ISSUES} />
      </div>
    </MulticaPageShell>
  );
}

const MOCK_ISSUES: Issue[] = [
  {
    id: "mock-issue-1",
    workspace_id: "mock-workspace",
    number: 1,
    identifier: "DX-1",
    title: "Start here: learn Multica with Multica Helper",
    description: "Welcome to Multica. This is your guide...",
    status: "in_review",
    priority: "high",
    assignee_type: "agent",
    assignee_id: "agent-multica-helper",
    creator_type: "member",
    creator_id: "me",
    parent_issue_id: null,
    project_id: "dx",
    position: 1,
    start_date: null,
    due_date: null,
    labels: [],
    created_at: "2026-05-20T09:12:00Z",
    updated_at: "2026-05-30T09:12:00Z",
  },
];

function AgentsPage() {
  const { t } = useTranslation();
  const wsId = useWorkspaceId();
  const { apiClient, liveDataEnabled } = useCoreContext();
  const agentsQuery = useQuery(agentListOptions(wsId, apiClient));
  const tasksQuery = useQuery(agentTaskSnapshotOptions(wsId, apiClient));
  const runsQuery = useQuery(agentRunCounts30dOptions(wsId, apiClient));
  const activityQuery = useQuery(agentActivity30dOptions(wsId, apiClient));

  if (!liveDataEnabled) return <DemoAgentsPage />;

  const agents = agentsQuery.data?.filter((a) => !a.archived_at) ?? [];
  const tasks = tasksQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const activity = activityQuery.data ?? [];
  const rows = agents.map((agent) => liveAgentRow(agent, tasks, runs, activity, t));

  return (
    <MulticaPageShell className="agents-page">
      <AgentsHeader count={agents.length} />
      <div className="section-body mc-section-body">
        {agentsQuery.isError ? (
          <InlineState title={t("sections.agentLoadFailed")} detail={agentsQuery.error instanceof Error ? agentsQuery.error.message : t("sections.agentLoadFailedDetail")} />
        ) : agentsQuery.isLoading ? (
          <InlineState title={t("sections.loadingAgents")} />
        ) : rows.length === 0 ? (
          <InlineState title={t("sections.noAgents")} />
        ) : (
          <AgentTable rows={rows} />
        )}
      </div>
    </MulticaPageShell>
  );
}

type AgentTableRow = {
  id: string;
  name: string;
  description: string;
  statusLabel: string;
  statusClass: string;
  statusDot: string;
  workload: string;
  runtime: string;
  activityLabel: string;
  runs: number;
  avatarText: string;
  avatarBg: string;
  isSelf?: boolean;
};

type Translate = (key: string, opts?: Record<string, unknown>) => string;

function liveAgentRow(agent: LiveAgent, tasks: AgentTask[], runs: AgentRunCount[], activity: AgentActivityBucket[], t: Translate): AgentTableRow {
  const activeTasks = tasks.filter((task) => task.agent_id === agent.id && ["queued", "dispatched", "running"].includes(task.status));
  const latestTask = tasks.find((task) => task.agent_id === agent.id);
  const runCount = runs.find((r) => r.agent_id === agent.id)?.run_count ?? 0;
  const activityCount = activity.filter((a) => a.agent_id === agent.id).reduce((sum, row) => sum + row.task_count, 0);
  const tone = agentTone(agent, activeTasks, t);
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description || "Default guide for your workspace",
    statusLabel: tone.label,
    statusClass: tone.cls,
    statusDot: tone.dot,
    workload: activeTasks.length > 0 ? t("sections.activeTasks", { count: activeTasks.length }) : t("sections.idle"),
    runtime: agent.runtime_mode || agent.model || "Codex",
    activityLabel: latestTask ? taskTitle(latestTask) : t("sections.noRecentActivity"),
    runs: runCount || activityCount,
    avatarText: initials(agent.name),
    avatarBg: avatarColor(agent.id),
  };
}

function DemoAgentsPage() {
  const { t } = useTranslation();
  const rows = mockAgentRows(t);
  return (
    <MulticaPageShell className="agents-page">
      <AgentsHeader count={rows.length} />
      <div className="section-body mc-section-body">
        <AgentTable rows={rows} />
      </div>
    </MulticaPageShell>
  );
}

function AgentsHeader({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="mc-topbar agent-topbar">
        <div className="mc-heading">
          <div className="mc-title-row">
            <Icon.Bot size={15} />
            <span className="mc-title">{t("sections.agentsTitle")}</span>
            <span className="mc-count">{count}</span>
            <span className="mc-subtitle-inline">{t("sections.agentsSubtitle")}</span>
          </div>
        </div>
        <button className="mc-primary-btn">
          <Icon.Plus size={14} />
          {t("sections.newAgent")}
        </button>
      </div>
      <div className="agent-toolbar">
        <label className="mc-searchbox">
          <Icon.Search size={14} />
          <input placeholder={t("sections.searchAgents")} readOnly />
        </label>
        <div className="mc-chip-group">
          <button className="mc-chip is-active">{t("sections.mine")} <span>{count}</span></button>
          <button className="mc-chip">{t("sections.all")} <span>{count}</span></button>
        </div>
        <div className="mc-spacer" />
        <span className="agent-pager">{t("sections.pager")}</span>
        <button className="mc-ghost-btn">
          <Icon.Share size={14} />
          {t("sections.recentlyActive")}
        </button>
      </div>
      <div className="agent-status-filters">
        <button className="mc-chip is-active">{t("sections.all")} {count}</button>
        <button className="mc-chip"><span className="mini-dot green" />{t("sections.statusOnline")} {count}</button>
        <button className="mc-chip"><span className="mini-dot amber" />{t("sections.statusUnstable")} 0</button>
        <button className="mc-chip"><span className="mini-dot gray" />{t("sections.statusOffline")} 0</button>
      </div>
    </>
  );
}

function AgentTable({ rows }: { rows: AgentTableRow[] }) {
  const { t } = useTranslation();
  return (
    <div className="agent-table-shell">
      <div className="agent-table-head">
        <span>{t("sections.colAgent")}</span>
        <span>{t("sections.colStatus")}</span>
        <span>{t("sections.colWorkload")}</span>
        <span>{t("sections.colRuntime")}</span>
        <span>{t("sections.colActivity")}</span>
        <span>{t("sections.colRuns")}</span>
        <span />
      </div>
      {rows.map((row) => (
        <div key={row.id} className="agent-table-row">
          <div className="agent-name-cell">
            <span className="agent-avatar-mini is-large" style={{ background: row.avatarBg }}>
              {row.avatarText}
              <span className={`agent-dot ${row.statusDot}`} />
            </span>
            <span className="agent-name-stack">
              <span className="agent-row-name">
                {row.name}
                {row.isSelf ? <em>{t("sections.self")}</em> : null}
              </span>
              <span className="agent-row-desc">{row.description}</span>
            </span>
          </div>
          <span className={`agent-state ${row.statusClass}`}><span className="mini-dot green" />{row.statusLabel}</span>
          <span className="agent-muted">{row.workload}</span>
          <span className="agent-runtime"><Icon.Terminal size={13} />{row.runtime}</span>
          <span className="agent-activity-line">{row.activityLabel}</span>
          <span className="agent-run-count">{row.runs}</span>
          <button className="mc-icon-btn" aria-label={t("sections.rowMoreAria", { name: row.name })}>
            <Icon.More size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function mockAgentRows(t: Translate): AgentTableRow[] {
  return [
    {
      id: "multica-helper",
      name: "Multica Helper",
      description: "Default guide for your first Multica workspace...",
      statusLabel: t("sections.statusOnline"),
      statusClass: "s-green",
      statusDot: "s-online",
      workload: t("sections.idle"),
      runtime: "Codex (MacBook-Pro.local)",
      activityLabel: "",
      runs: 2,
      avatarText: "C",
      avatarBg: "#061b1b",
      isSelf: true,
    },
  ];
}

function UsagePage() {
  const { t } = useTranslation();
  const wsId = useWorkspaceId();
  const { apiClient, liveDataEnabled } = useCoreContext();
  const days = 30;
  const dailyQuery = useQuery(dashboardUsageDailyOptions(wsId, apiClient, days));
  const byAgentQuery = useQuery(dashboardUsageByAgentOptions(wsId, apiClient, days));
  const agentTimeQuery = useQuery(dashboardAgentRunTimeOptions(wsId, apiClient, days));
  const runtimeDailyQuery = useQuery(dashboardRunTimeDailyOptions(wsId, apiClient, days));
  const agentsQuery = useQuery(agentListOptions(wsId, apiClient));

  if (!liveDataEnabled) return <DemoUsagePage />;

  const daily = dailyQuery.data ?? [];
  const byAgent = byAgentQuery.data ?? [];
  const agentTime = agentTimeQuery.data ?? [];
  const runtimeDaily = runtimeDailyQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const stats = usageStats(daily, byAgent, agentTime, runtimeDaily, t);
  const trend = usageTrend(daily, runtimeDaily);
  const top = topAgents(byAgent, agentTime, agents);

  return (
    <MulticaPageShell className="usage-page">
      <UsageHeader />
      <div className="section-body mc-section-body">
        {dailyQuery.isError || byAgentQuery.isError ? (
          <InlineState title={t("sections.usageLoadFailed")} detail={t("sections.usageLoadFailedDetail")} />
        ) : dailyQuery.isLoading ? (
          <InlineState title={t("sections.loadingUsage")} />
        ) : daily.length === 0 && runtimeDaily.length === 0 ? (
          <InlineState title={t("sections.noUsageData")} />
        ) : (
          <UsageDashboard stats={stats} trend={trend} top={top} agentCount={agents.length} />
        )}
      </div>
    </MulticaPageShell>
  );
}

function DemoUsagePage() {
  const { t } = useTranslation();
  return (
    <MulticaPageShell className="usage-page">
      <UsageHeader />
      <div className="section-body mc-section-body">
        <UsageDashboard stats={demoStats(t)} trend={DEMO_TREND} top={DEMO_TOP_AGENTS} agentCount={1} />
      </div>
    </MulticaPageShell>
  );
}

function demoStats(t: Translate) {
  return [
    { label: t("sections.demoCost"), value: "$4.68", detail: "" },
    { label: t("sections.demoToken"), value: "1.5M", detail: t("sections.demoTokenDetail") },
    { label: t("sections.demoRuntime"), value: "3m 30s", detail: t("sections.demoRuntimeDetail") },
    { label: t("sections.demoTasks"), value: "2", detail: t("sections.demoTasksDetail") },
  ];
}

const DEMO_TREND = [
  { label: "5/20", value: 1_500_000 },
];

const DEMO_TOP_AGENTS = [
  { id: "multica-helper", name: "Multica Helper", pct: 100, token: "1.5M", cost: "$4.68", runtime: "3m 30s", tasks: 2 },
];

function UsageHeader() {
  const { t } = useTranslation();
  return (
    <div className="mc-topbar usage-topbar">
      <div className="mc-heading">
        <div className="mc-title-row">
          <Icon.Chart size={15} />
          <span className="mc-title">{t("sections.usageTitle")}</span>
        </div>
        <div className="mc-subtitle">{t("sections.usageSubtitle")}</div>
      </div>
      <div className="usage-controls">
        <button className="mc-select-btn">
          <Icon.Folder size={14} />
          {t("sections.allProjects")}
          <Icon.Chevron size={13} />
        </button>
        <div className="mc-segment">
          <button className="is-active">{t("sections.byDay")}</button>
          <button>{t("sections.byWeek")}</button>
        </div>
        <div className="mc-segment">
          <button>1d</button>
          <button>7d</button>
          <button className="is-active">30d</button>
          <button>90d</button>
        </div>
      </div>
    </div>
  );
}

function UsageDashboard({
  stats,
  trend,
  top,
  agentCount,
}: {
  stats: { label: string; value: string; detail: string }[];
  trend: { label: string; value: number }[];
  top: { id: string; name: string; pct: number; token?: string; cost?: string; runtime?: string; tasks?: number }[];
  agentCount: number;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="usage-kpis">
        {stats.map((s) => (
          <div key={s.label} className="usage-kpi">
            <div className="usage-kpi-label">{s.label}</div>
            <div className="usage-kpi-value">{s.value}</div>
            <div className="usage-kpi-detail">{s.detail}</div>
          </div>
        ))}
      </div>

      <div className="usage-card usage-chart-card">
        <div className="usage-card-head">
          <h3>{t("sections.dailyToken")}</h3>
          <div className="mc-segment">
            <button className="is-active">Token</button>
            <button>{t("sections.cost")}</button>
            <button>{t("sections.runtimeDuration")}</button>
            <button>{t("sections.taskCount")}</button>
          </div>
        </div>
        <UsageStackChart rows={trend} />
      </div>

      <div className="usage-card">
        <div className="usage-card-head">
          <h3>{t("sections.leaderboard")}</h3>
          <div className="usage-card-actions">
            <div className="mc-segment">
              <button className="is-active">Token</button>
              <button>{t("sections.cost")}</button>
              <button>{t("sections.runtimeDuration")}</button>
              <button>{t("sections.taskCount")}</button>
            </div>
            <span>{t("sections.agentCount", { count: agentCount })}</span>
          </div>
        </div>
        <div className="usage-rank-head">
          <span>{t("sections.colAgent")}</span>
          <span>Token</span>
          <span>{t("sections.cost")}</span>
          <span>{t("sections.runtimeDuration")}</span>
          <span>{t("sections.taskCount")}</span>
        </div>
        <div className="usage-rank-list">
          {top.map((row) => (
            <div key={row.id} className="usage-rank-row">
              <span className="usage-rank-agent">
                <span className="agent-avatar-mini" style={{ background: avatarColor(row.id) }}>
                  {initials(row.name)}
                </span>
                {row.name}
              </span>
              <span className="usage-track">
                <span className="usage-fill" style={{ width: `${row.pct}%` }} />
              </span>
              <span>{row.token ?? `${row.pct}%`}</span>
              <span>{row.cost ?? "-"}</span>
              <span>{row.runtime ?? "-"}</span>
              <span>{row.tasks ?? "-"}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function UsageStackChart({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <div className="usage-stack-chart">
      <div className="usage-axis">
        <span>{compact(max)}</span>
        <span>{compact(max * 0.75)}</span>
        <span>{compact(max * 0.5)}</span>
        <span>{compact(max * 0.25)}</span>
        <span>0</span>
      </div>
      <div className="usage-plot">
        {rows.map((row) => (
          <div key={row.label} className="usage-stack-col">
            <div className="usage-stack-bar" style={{ height: `${Math.max(18, (row.value / max) * 100)}%` }}>
              <span className="usage-stack-main" />
              <span className="usage-stack-light" />
            </div>
            <span className="usage-stack-label">{row.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function usageStats(
  daily: DashboardUsageDaily[],
  byAgent: DashboardUsageByAgent[],
  agentTime: DashboardAgentRunTime[],
  runtimeDaily: DashboardRunTimeDaily[],
  t: Translate,
) {
  const tokens = daily.reduce((sum, row) => sum + tokenTotal(row), 0);
  const tasks = runtimeDaily.reduce((sum, row) => sum + row.task_count, 0) || daily.reduce((sum, row) => sum + row.task_count, 0);
  const seconds = agentTime.reduce((sum, row) => sum + row.total_seconds, 0);
  const agentCount = new Set(byAgent.map((row) => row.agent_id)).size;
  return [
    { label: "Token", value: compact(tokens), detail: t("sections.statBucket", { count: daily.length }) },
    { label: t("sections.taskCount"), value: compact(tasks), detail: t("sections.statAgentsUsage", { count: agentCount }) },
    { label: t("sections.statTotalDuration"), value: duration(seconds), detail: t("sections.statTotalDurationDetail") },
    { label: t("sections.statFailedTasks"), value: compact(runtimeDaily.reduce((sum, row) => sum + row.failed_count, 0)), detail: t("sections.statFailedTasksDetail") },
  ];
}

function usageTrend(daily: DashboardUsageDaily[], runtimeDaily: DashboardRunTimeDaily[]) {
  const byDate = new Map<string, number>();
  for (const row of daily) byDate.set(row.date, (byDate.get(row.date) ?? 0) + tokenTotal(row));
  if (byDate.size === 0) {
    for (const row of runtimeDaily) byDate.set(row.date, row.task_count);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-14).map(([date, value]) => ({ label: date.slice(5), value }));
}

function topAgents(byAgent: DashboardUsageByAgent[], agentTime: DashboardAgentRunTime[], agents: LiveAgent[]) {
  const totals = new Map<string, number>();
  for (const row of byAgent) totals.set(row.agent_id, (totals.get(row.agent_id) ?? 0) + tokenTotal(row));
  if (totals.size === 0) {
    for (const row of agentTime) totals.set(row.agent_id, row.total_seconds);
  }
  const max = Math.max(1, ...totals.values());
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, value]) => ({ id, name: agents.find((a) => a.id === id)?.name ?? id.slice(0, 8), pct: Math.max(4, Math.round((value / max) * 100)) }));
}

function tokenTotal(row: DashboardUsageDaily | DashboardUsageByAgent): number {
  return row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens;
}

function compact(value: number): string {
  return Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function shortDate(value: string): string {
  return value.slice(0, 10);
}

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.slice(0, 2).toUpperCase();
}

function avatarColor(id: string): string {
  const colors = ["#c96442", "#1f6feb", "#16a34a", "#d97706", "#7c3aed", "#0d9488", "#475569"];
  let hash = 0;
  for (const ch of id) hash = (hash + ch.charCodeAt(0)) % colors.length;
  return colors[hash]!;
}

function agentTone(agent: LiveAgent, activeTasks: AgentTask[], t: Translate) {
  if (activeTasks.some((task) => task.status === "running")) return { cls: "s-amber", label: t("sections.statusRunning"), dot: "s-working" };
  if (activeTasks.length > 0) return { cls: "s-blue", label: t("sections.statusQueued"), dot: "s-review" };
  if (agent.status === "offline") return { cls: "s-gray", label: t("sections.statusOfflineLabel"), dot: "s-offline" };
  if (agent.status === "error" || agent.status === "blocked") return { cls: "s-red", label: t("sections.statusError"), dot: "s-offline" };
  return { cls: "s-green", label: t("sections.statusAvailable"), dot: "s-online" };
}

function taskTitle(task: AgentTask): string {
  return task.trigger_summary || task.quick_create_prompt || task.kind || task.status;
}

type SettingsTab = "profile" | "config" | "runtime" | "skill";

const SETTINGS_TABS: { id: SettingsTab; labelKey: string; icon: ReactNode }[] = [
  { id: "profile", labelKey: "sections.settingsTabProfile", icon: <Icon.Users size={15} /> },
  { id: "config", labelKey: "sections.settingsTabConfig", icon: <Icon.Settings size={15} /> },
  { id: "runtime", labelKey: "sections.settingsTabRuntime", icon: <Icon.Terminal size={15} /> },
  { id: "skill", labelKey: "sections.settingsTabSkill", icon: <Icon.Code size={15} /> },
];

function SettingsPage() {
  const { t } = useTranslation();
  const [active, setActive] = useState<SettingsTab>("profile");
  return (
    <MulticaPageShell className="settings-page">
      <div className="settings-sidebar">
        <button className="settings-back" onClick={() => useCortexUIStore.getState().setSection("chat")}>
          <Icon.Back size={15} />
          {t("sections.settingsBack")}
        </button>
        <nav className="settings-nav" aria-label={t("sections.settingsMenuAria")}>
          {SETTINGS_TABS.map((tab) => (
            <button key={tab.id} className={`settings-nav-item ${active === tab.id ? "is-active" : ""}`} onClick={() => setActive(tab.id)}>
              {tab.icon}
              <span>{t(tab.labelKey)}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="settings-content">
        {active === "profile" ? <ProfileSettings /> : null}
        {active === "config" ? <ConfigSettings /> : null}
        {active === "runtime" ? <RuntimeSettings /> : null}
        {active === "skill" ? <SkillSettings /> : null}
      </div>
    </MulticaPageShell>
  );
}

function SettingsPanel({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="settings-panel">
      <div className="settings-panel-head">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </section>
  );
}

function ProfileSettings() {
  const { t } = useTranslation();
  return (
    <SettingsPanel title={t("sections.profileTitle")} description={t("sections.profileDesc")}>
      <div className="settings-card profile-card">
        <button className="profile-avatar">{t("sections.meInitial")}</button>
        <div className="profile-fields">
          <label className="settings-field">
            <span>{t("sections.profileName")}</span>
            <input value="Mike" readOnly />
          </label>
          <label className="settings-field">
            <span>Profile description</span>
            <textarea value={t("sections.profileDescriptionValue")} readOnly rows={5} />
          </label>
          <div className="settings-actions">
            <button className="mc-primary-btn">{t("sections.updateProfile")}</button>
          </div>
        </div>
      </div>
    </SettingsPanel>
  );
}

function ConfigSettings() {
  return (
    <SettingsPanel title="Daemon" description="Configure how the local agent daemon behaves with the desktop app.">
      <div className="daemon-settings">
        <SettingLine
          label="Auto-start on launch"
          description="Automatically start the daemon when the app opens and you are logged in."
        >
          <FakeSwitch checked />
        </SettingLine>
        <SettingLine
          label="Auto-stop on quit"
          description="Stop the daemon when the desktop app is closed. Disable this to keep the daemon running in the background."
        >
          <FakeSwitch />
        </SettingLine>
        <div className="daemon-cli">
          <p>CLI Status</p>
          <span>cortex CLI is installed and available in PATH.</span>
        </div>
      </div>

      <div className="daemon-diagnostics">
        <h3>Diagnostics</h3>
        <p>Identification and connection details. Useful when filing a bug report or investigating why a runtime is not showing up.</p>
        <div className="diagnostics-box">
          <DiagnosticsRow label="State" value={<span className="diag-state"><span />Running</span>} />
          <DiagnosticsRow label="Uptime" value="3m 30s" />
          <DiagnosticsRow label="PID" value="48216" mono />
          <DiagnosticsRow label="Daemon ID" value="local-codex-mbp" mono />
          <DiagnosticsRow label="Profile" value="default" />
          <DiagnosticsRow label="Server URL" value="http://localhost:18789" mono />
          <DiagnosticsRow label="Workspace" value="dx" mono />
          <DiagnosticsRow label="Auth token" value="••••••••••••••••" mono />
        </div>
      </div>
    </SettingsPanel>
  );
}

function SettingLine({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return (
    <div className="setting-line">
      <div>
        <p>{label}</p>
        <span>{description}</span>
      </div>
      {children}
    </div>
  );
}

function FakeSwitch({ checked = false }: { checked?: boolean }) {
  return <button className={`fake-switch ${checked ? "is-on" : ""}`} aria-pressed={checked}><span /></button>;
}

function DiagnosticsRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="diagnostics-row">
      <span>{label}</span>
      <b className={mono ? "mono" : ""}>{value}</b>
    </div>
  );
}

function RuntimeSettings() {
  const machines = [
    { id: "local", title: "MacBook-Pro.local", subtitle: "daemon local-codex-mbp", section: "Local", health: "online", runtimes: 2, busy: 0 },
    { id: "remote", title: "Build Runner", subtitle: "remote ssh runtime", section: "Remote", health: "issues", runtimes: 1, busy: 1 },
  ];
  return (
    <section className="settings-full-panel runtime-aligned">
      <div className="aligned-page-header">
        <div>
          <Icon.Terminal size={15} />
          <h1>Runtimes</h1>
          <span>3</span>
        </div>
        <button className="mc-primary-btn"><Icon.Plus size={14} />Connect Remote</button>
      </div>

      <div className="runtime-split">
        <aside className="runtime-machine-pane">
          <div className="runtime-machine-toolbar">
            <label className="mc-searchbox"><Icon.Search size={14} /><input placeholder="Search machines..." readOnly /></label>
            <div className="mc-chip-group">
              <button className="mc-chip is-active">All 2</button>
              <button className="mc-chip"><span className="mini-dot green" />Online 1</button>
              <button className="mc-chip"><span className="mini-dot amber" />Issues 1</button>
            </div>
          </div>
          <div className="machine-section-label"><span>Local</span><i /></div>
          {machines.filter((m) => m.section === "Local").map((machine) => (
            <button key={machine.id} className="machine-row is-active">
              <span className="machine-icon"><Icon.Terminal size={14} /><i className="green" /></span>
              <span>
                <b>{machine.title}</b>
                <small>{machine.subtitle}</small>
              </span>
              <em>{machine.runtimes} runtimes</em>
            </button>
          ))}
          <div className="machine-section-label"><span>Remote</span><i /></div>
          {machines.filter((m) => m.section === "Remote").map((machine) => (
            <button key={machine.id} className="machine-row">
              <span className="machine-icon"><Icon.Globe size={14} /><i className="amber" /></span>
              <span>
                <b>{machine.title}</b>
                <small>{machine.subtitle}</small>
              </span>
              <em>{machine.busy} busy</em>
            </button>
          ))}
        </aside>
        <main className="runtime-detail-pane">
          <div className="runtime-detail-head">
            <span className="runtime-detail-icon"><Icon.Terminal size={18} /></span>
            <div>
              <h2>MacBook-Pro.local</h2>
              <p><span className="mini-dot green" />Healthy · This machine</p>
            </div>
          </div>
          <div className="runtime-detail-grid">
            <div className="runtime-detail-card"><span>Providers</span><b>Codex, OpenAI</b></div>
            <div className="runtime-detail-card"><span>Queued</span><b>0</b></div>
            <div className="runtime-detail-card"><span>Running</span><b>0</b></div>
            <div className="runtime-detail-card"><span>Version</span><b>v2.14.0</b></div>
          </div>
          <div className="runtime-runtime-list">
            <h3>Runtimes on this machine</h3>
            {["Codex", "OpenAI Responses"].map((name) => (
              <div key={name} className="runtime-runtime-row">
                <span><Icon.Bot size={14} />{name}</span>
                <b>Idle</b>
              </div>
            ))}
          </div>
        </main>
      </div>
    </section>
  );
}

function SkillSettings() {
  const rows = [
    { name: "Issue triage", description: "Classify incoming issues and suggest owner.", files: 3, usedBy: ["MH"], source: "Manual · by Mike", updated: "2h ago" },
    { name: "Code review", description: "Review diffs and summarize risks.", files: 5, usedBy: ["CX", "DX"], source: "Runtime · Codex", updated: "1d ago" },
    { name: "Release notes", description: "", files: 2, usedBy: [], source: "GitHub", updated: "3d ago" },
  ];
  return (
    <section className="settings-full-panel skill-aligned">
      <div className="aligned-page-header">
        <div>
          <Icon.Code size={15} />
          <h1>Skills</h1>
          <span>{rows.length}</span>
          <p>Reusable instructions agents can attach to work.</p>
        </div>
        <button className="mc-primary-btn"><Icon.Plus size={14} />New Skill</button>
      </div>

      <div className="skill-body">
        <div className="skill-intro"><b>Skills teach agents repeatable workflows.</b> Attach them to agents so issue triage, code review, and release work follow the same playbook.</div>
        <div className="skill-card">
          <div className="skill-toolbar">
            <label className="mc-searchbox"><Icon.Search size={14} /><input placeholder="Search skills..." readOnly /></label>
            <button className="mc-chip is-active">All</button>
            <button className="mc-chip">Used</button>
            <button className="mc-chip">Unused</button>
            <button className="mc-chip">Mine</button>
          </div>
          <div className="skill-table">
            <div className="skill-table-head"><span>Name</span><span>Used by</span><span>Source</span><span>Updated</span><span /></div>
            {rows.map((row) => (
              <div key={row.name} className="skill-table-row">
                <span className="skill-name-cell">
                  <b>{row.name}<em><Icon.File size={11} />{row.files}</em></b>
                  <small>{row.description || "No description"}</small>
                </span>
                <span className="skill-used-by">
                  {row.usedBy.length === 0 ? <i>Unused</i> : row.usedBy.map((initial) => <b key={initial}>{initial}</b>)}
                </span>
                <span className="skill-source">{row.source}</span>
                <span>{row.updated}</span>
                <Icon.ChevronRight size={14} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function SectionPage({ section }: { section: "tasks" | "agents" | "usage" | "settings" }) {
  if (section === "tasks") return <TasksPage />;
  if (section === "agents") return <AgentsPage />;
  if (section === "settings") return <SettingsPage />;
  return <UsagePage />;
}
