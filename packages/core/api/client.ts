import type {
  Agent,
  AgentActivityBucket,
  AgentRunCount,
  AgentTask,
  DashboardAgentRunTime,
  DashboardRunTimeDaily,
  DashboardUsageByAgent,
  DashboardUsageDaily,
  ListIssuesResponse,
} from "./types";

export interface ApiClientConfig {
  baseUrl: string;
  token?: string;
  workspaceId?: string;
  workspaceSlug?: string;
  platform?: "web" | "desktop";
  version?: string;
  os?: "macos" | "windows" | "linux" | "unknown";
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function appendSearch(path: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === false || value === "") continue;
    search.set(key, value === true ? "true" : String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export class ApiClient {
  private readonly config: ApiClientConfig;

  constructor(config: ApiClientConfig) {
    this.config = { ...config, baseUrl: cleanBaseUrl(config.baseUrl) };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    if (this.config.workspaceSlug) headers["X-Workspace-Slug"] = this.config.workspaceSlug;
    if (this.config.workspaceId) headers["X-Workspace-ID"] = this.config.workspaceId;
    if (this.config.platform) headers["X-Client-Platform"] = this.config.platform;
    if (this.config.version) headers["X-Client-Version"] = this.config.version;
    if (this.config.os) headers["X-Client-OS"] = this.config.os;
    return headers;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
      credentials: "include",
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ApiError(body || `GET ${path} failed`, response.status, response.statusText);
    }
    return (await response.json()) as T;
  }

  listIssues(params: { limit?: number; offset?: number; open_only?: boolean } = {}): Promise<ListIssuesResponse> {
    return this.get<ListIssuesResponse>(appendSearch("/api/issues", { limit: 200, ...params }));
  }

  listAgents(params: { include_archived?: boolean } = {}): Promise<Agent[]> {
    return this.get<Agent[]>(appendSearch("/api/agents", params));
  }

  listAgentTaskSnapshot(): Promise<AgentTask[]> {
    return this.get<AgentTask[]>("/api/agent-task-snapshot");
  }

  listAgentRunCounts30d(): Promise<AgentRunCount[]> {
    return this.get<AgentRunCount[]>("/api/agent-run-counts");
  }

  listAgentActivity30d(): Promise<AgentActivityBucket[]> {
    return this.get<AgentActivityBucket[]>("/api/agent-activity-30d");
  }

  getDashboardUsageDaily(params: { days: number; projectId?: string | null }): Promise<DashboardUsageDaily[]> {
    return this.get<DashboardUsageDaily[]>(
      appendSearch("/api/dashboard/usage/daily", { days: params.days, project_id: params.projectId }),
    );
  }

  getDashboardUsageByAgent(params: { days: number; projectId?: string | null }): Promise<DashboardUsageByAgent[]> {
    return this.get<DashboardUsageByAgent[]>(
      appendSearch("/api/dashboard/usage/by-agent", { days: params.days, project_id: params.projectId }),
    );
  }

  getDashboardAgentRunTime(params: { days: number; projectId?: string | null }): Promise<DashboardAgentRunTime[]> {
    return this.get<DashboardAgentRunTime[]>(
      appendSearch("/api/dashboard/agent-runtime", { days: params.days, project_id: params.projectId }),
    );
  }

  getDashboardRunTimeDaily(params: { days: number; projectId?: string | null }): Promise<DashboardRunTimeDaily[]> {
    return this.get<DashboardRunTimeDaily[]>(
      appendSearch("/api/dashboard/runtime/daily", { days: params.days, project_id: params.projectId }),
    );
  }
}
