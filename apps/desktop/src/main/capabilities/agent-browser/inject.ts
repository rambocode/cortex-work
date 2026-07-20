import type { AgentBrowserSettings, McpServerConfig, McpSettings } from "../../ipc/types";

export const AGENT_BROWSER_MCP_SERVER_ID = "agent-browser";
const AGENT_BROWSER_IDLE_TIMEOUT_MS = "300000";

function safeSessionId(sessionId: string | undefined): string {
  const suffix = (sessionId || "default").replace(/[^A-Za-z0-9_-]/g, "_");
  return `cortex-${suffix}`;
}

export function buildAgentBrowserMcpServerConfig(
  settings: AgentBrowserSettings | undefined,
  sessionId: string | undefined,
  binaryPath: string | null,
): McpServerConfig | null {
  if (settings?.enabled === false || !binaryPath) return null;
  return {
    id: AGENT_BROWSER_MCP_SERVER_ID,
    label: "Agent Browser（内置）",
    transport: "stdio",
    command: binaryPath,
    args: ["mcp", "--tools", "all"],
    env: {
      AGENT_BROWSER_SESSION: safeSessionId(sessionId),
      AGENT_BROWSER_IDLE_TIMEOUT_MS,
    },
  };
}

function isLegacyAgentBrowserServer(server: McpServerConfig): boolean {
  return (
    server.id === AGENT_BROWSER_MCP_SERVER_ID &&
    server.transport === "stdio" &&
    server.command === "agent-browser" &&
    JSON.stringify(server.args ?? []) === JSON.stringify(["mcp"])
  );
}

export function migrateLegacyAgentBrowserMcp(settings: McpSettings): McpSettings {
  const occupied = new Set(settings.servers.filter((s) => s.id !== AGENT_BROWSER_MCP_SERVER_ID).map((s) => s.id));
  let changed = false;
  const servers = settings.servers.flatMap((server): McpServerConfig[] => {
    if (isLegacyAgentBrowserServer(server)) {
      changed = true;
      return [];
    }
    if (server.id !== AGENT_BROWSER_MCP_SERVER_ID) return [server];
    let suffix = 1;
    let id = "agent-browser-user";
    while (occupied.has(id)) id = `agent-browser-user-${++suffix}`;
    occupied.add(id);
    changed = true;
    return [{ ...server, id }];
  });
  return changed ? { ...settings, servers } : settings;
}
