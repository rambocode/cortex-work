// MCP 设置卡片(M2 U3)。总开关 + 最小 server 清单(stdio command / http url)。读写 generalSettings.mcp,
// 经 store 自动持久化;主进程在 cli:start 按总开关注入(见 ipc/mcp-config.ts,严格 gate 不覆盖用户文件)。
// 渲染在 AgentSection 内(MCP 是 agent 相邻能力)。标签用 zh 字面量(桌面配置项,沿用 AgentTraceWindowCard
// 的不本地化约定),避免为最小 UI 扩 locale。
/* eslint-disable i18next/no-literal-string -- MCP 配置项标签为桌面专用,暂不本地化 */

import { usePersonalStore } from "@cortex-work/core";
import type { McpServerConfig, McpSettings } from "@cortex-work/core";

const EMPTY: McpSettings = { enabled: false, servers: [] };

// 生成一个稳定的新 server id(基于现有数量,避免与已有 id 冲突)。
function nextServerId(servers: McpServerConfig[]): string {
  let n = servers.length + 1;
  const ids = new Set(servers.map((s) => s.id));
  while (ids.has(`server-${n}`)) n += 1;
  return `server-${n}`;
}

export function McpCard() {
  const general = usePersonalStore((s) => s.generalSettings);
  const setGeneral = usePersonalStore((s) => s.setGeneralSettings);
  const mcp: McpSettings = general.mcp ?? EMPTY;

  const update = (patch: Partial<McpSettings>) => setGeneral({ mcp: { ...mcp, ...patch } });
  const updateServer = (i: number, patch: Partial<McpServerConfig>) =>
    update({ servers: mcp.servers.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) });
  const addServer = () =>
    update({ servers: [...mcp.servers, { id: nextServerId(mcp.servers), transport: "stdio", command: "" }] });
  const removeServer = (i: number) => update({ servers: mcp.servers.filter((_, idx) => idx !== i) });

  return (
    <div className="pw-scard">
      <div className="pw-scard-t">MCP 服务</div>

      <div className="pw-srow">
        <span className="pw-srow-lbl">启用 MCP 注入</span>
        <label className="pw-srow-end">
          <input type="checkbox" checked={mcp.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        </label>
      </div>
      <div className="pw-srow-desc">
        开启后,下表的 MCP server 会按会话注入给 claude(写项目 .mcp.json)与 codex(-c)。关闭时不注入、不覆盖你项目里已有的 .mcp.json,codex 仍继承 ~/.codex 配置。
      </div>

      {mcp.servers.length === 0 ? (
        <div className="pw-scard-empty">尚未配置 MCP server。</div>
      ) : (
        mcp.servers.map((s, i) => (
          <div key={i} className="pw-srow">
            <input
              className="pw-set-input"
              placeholder="名称(id)"
              value={s.id}
              onChange={(e) => updateServer(i, { id: e.target.value })}
            />
            <input
              className="pw-set-input"
              placeholder={s.transport === "stdio" ? "启动命令(如 /usr/local/bin/mcp-fs)" : "URL"}
              value={s.transport === "stdio" ? (s.command ?? "") : (s.url ?? "")}
              onChange={(e) =>
                updateServer(i, s.transport === "stdio" ? { command: e.target.value } : { url: e.target.value })
              }
            />
            <button className="pw-tl-gen" onClick={() => removeServer(i)} aria-label={`删除 ${s.id}`}>
              删除
            </button>
          </div>
        ))
      )}

      <button className="pw-tl-gen" onClick={addServer}>
        + 添加 MCP server
      </button>
    </div>
  );
}
