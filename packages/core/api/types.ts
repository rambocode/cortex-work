export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
export type IssuePriority = "urgent" | "high" | "medium" | "low" | "none";
export type IssueAssigneeType = "member" | "agent" | "squad";

export interface Issue {
  id: string;
  workspace_id: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assignee_type: IssueAssigneeType | null;
  assignee_id: string | null;
  creator_type: IssueAssigneeType;
  creator_id: string;
  parent_issue_id: string | null;
  project_id: string | null;
  position: number;
  start_date: string | null;
  due_date: string | null;
  labels?: { id: string; name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

export interface ListIssuesResponse {
  issues: Issue[];
  total: number;
}

export type AgentStatus = "idle" | "working" | "blocked" | "error" | "offline";
export type AgentRuntimeMode = "local" | "cloud";
export type AgentVisibility = "workspace" | "private";

export interface Agent {
  id: string;
  workspace_id: string;
  runtime_id: string;
  name: string;
  description: string;
  instructions: string;
  avatar_url: string | null;
  runtime_mode: AgentRuntimeMode;
  runtime_config: Record<string, unknown>;
  custom_env: Record<string, string>;
  custom_args: string[];
  custom_env_redacted?: boolean;
  visibility: AgentVisibility;
  status: AgentStatus;
  max_concurrent_tasks: number;
  model: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  archived_by: string | null;
}

export type AgentTaskStatus = "queued" | "dispatched" | "running" | "completed" | "failed" | "cancelled";

export interface AgentTask {
  id: string;
  agent_id: string;
  runtime_id: string;
  issue_id: string;
  workspace_id?: string;
  status: AgentTaskStatus;
  priority: number;
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  result: unknown;
  error: string | null;
  failure_reason?: string;
  attempt?: number;
  max_attempts?: number;
  created_at: string;
  trigger_summary?: string;
  trigger_author_name?: string;
  chat_session_id?: string;
  autopilot_run_id?: string;
  quick_create_prompt?: string;
  kind?: "comment" | "autopilot" | "chat" | "quick_create" | "direct";
  work_dir?: string;
}

export interface AgentActivityBucket {
  agent_id: string;
  bucket_at: string;
  task_count: number;
  failed_count: number;
}

export interface AgentRunCount {
  agent_id: string;
  run_count: number;
}

export interface DashboardUsageDaily {
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  task_count: number;
}

export interface DashboardUsageByAgent {
  agent_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  task_count: number;
}

export interface DashboardAgentRunTime {
  agent_id: string;
  total_seconds: number;
  task_count: number;
  failed_count: number;
}

export interface DashboardRunTimeDaily {
  date: string;
  total_seconds: number;
  task_count: number;
  failed_count: number;
}
