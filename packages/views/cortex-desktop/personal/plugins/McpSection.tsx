// MCP 设置卡片(M2 U3)。总开关 + server 清单 + 增删/启停。新增/编辑走独立页(由 PluginManagePage
// 通过 onEdit 上提渲染 McpServerForm,见该文件),本卡只负责列表,不内联表单。
// 读写 generalSettings.mcp,经 store 自动持久化;主进程在 cli:start 按总开关注入(ipc/mcp-config.ts)。
// 标签用 zh 字面量(桌面配置项不本地化)。
/* eslint-disable i18next/no-literal-string -- MCP 配置项标签为桌面专用,暂不本地化 */

import { Icon } from "@cortex-work/ui/icons";
import { useEffect, useState } from "react";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { AgentBrowserRuntimeStatus, McpSettings } from "@cortex-work/core";

const EMPTY: McpSettings = { enabled: false, servers: [] };

export function McpCard({ onEdit }: { onEdit: (index: number | null) => void }) {
  const general = usePersonalStore((s) => s.generalSettings);
  const setGeneral = usePersonalStore((s) => s.setGeneralSettings);
  const bridge = useDesktopBridge();
  const mcp: McpSettings = general.mcp ?? EMPTY;
  const agentBrowserEnabled = general.agentBrowser?.enabled !== false;
  const [agentBrowserStatus, setAgentBrowserStatus] = useState<AgentBrowserRuntimeStatus | null>(null);

  useEffect(() => {
    if (!bridge?.agentBrowserStatus) return;
    let active = true;
    void bridge.agentBrowserStatus().then((status) => {
      if (active) setAgentBrowserStatus(status);
    }).catch(() => {
      if (active) setAgentBrowserStatus({ state: "error", message: "无法读取运行状态" });
    });
    const off = bridge.onAgentBrowserStatus?.((status) => {
      if (active) setAgentBrowserStatus(status);
    });
    return () => {
      active = false;
      off?.();
    };
  }, [bridge]);

  const update = (patch: Partial<McpSettings>) => setGeneral({ mcp: { ...mcp, ...patch } });
  const removeServer = (i: number) => update({ servers: mcp.servers.filter((_, idx) => idx !== i) });

  return (
    <div className="pw-scard">
      <div className="pw-scard-t">MCP 工具</div>

      <div className="pw-mcp-item">
        <div className="pw-mcp-item-main">
          <span className="pw-mcp-item-name">Agent Browser（内置）</span>
          <span className="pw-tag">STDIO</span>
          <span className="pw-mcp-item-sub">为 Claude、Codex 与 Pi 提供完整浏览器自动化工具</span>
          <span className="pw-mcp-item-sub">
            {bridge?.agentBrowserStatus
              ? agentBrowserStatus?.message ?? "正在检查 Chrome"
              : "Chrome 状态仅桌面端可用"}
          </span>
        </div>
        <label className="pw-srow-end">
          <input
            aria-label="启用内置 Agent Browser"
            type="checkbox"
            checked={agentBrowserEnabled}
            onChange={(e) => setGeneral({ agentBrowser: { enabled: e.target.checked } })}
          />
        </label>
        {agentBrowserEnabled && agentBrowserStatus?.state === "error" && bridge?.agentBrowserRetry ? (
          <button
            className="pw-tl-gen"
            onClick={() => void bridge.agentBrowserRetry?.().then(setAgentBrowserStatus).catch(() => {
              setAgentBrowserStatus({ state: "error", message: "重试安装失败" });
            })}
          >
            重试安装
          </button>
        ) : null}
      </div>

      <div className="pw-srow">
        <span className="pw-srow-lbl">启用自定义 MCP 注入</span>
        <label className="pw-srow-end">
          <input aria-label="启用自定义 MCP 注入" type="checkbox" checked={mcp.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        </label>
      </div>
      <div className="pw-srow-desc">
        这里只控制下表的自定义 MCP server；内置 Agent Browser 使用上方独立开关，并按会话注入给 Claude、Codex 与 Pi。
      </div>

      {mcp.servers.length === 0 ? (
        <div className="pw-scard-empty">尚未配置 MCP server。</div>
      ) : (
        <div className="pw-mcp-list">
          {mcp.servers.map((s, i) => (
            <div key={i} className="pw-mcp-item">
              <div className="pw-mcp-item-main" onClick={() => onEdit(i)} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") onEdit(i); }}
              >
                <span className="pw-mcp-item-name">{s.label ?? s.id}</span>
                <span className="pw-tag">{s.transport === "stdio" ? "STDIO" : "流式 HTTP"}</span>
                <span className="pw-mcp-item-sub">{s.transport === "stdio" ? s.command : s.url}</span>
              </div>
              <button className="pw-mcpf-del" aria-label={`删除 ${s.label ?? s.id}`} onClick={() => removeServer(i)}>
                <Icon.Trash size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="pw-srow pw-srow-actions">
        <button className="pw-tl-gen" onClick={() => onEdit(null)}>
          + 连接自定义 MCP
        </button>
      </div>
    </div>
  );
}
