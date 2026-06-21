// MCP 设置卡片(M2 U3)。总开关 + 最小 server 清单(stdio command / http url)。读写 generalSettings.mcp,
// 经 store 自动持久化;主进程在 cli:start 按总开关注入(见 ipc/mcp-config.ts,严格 gate 不覆盖用户文件)。
// 渲染在插件管理器的「插件」tab 内(MCP 工具与 pi 原生扩展同属工具类,FR-3/R8)。标签用 zh 字面量
// (桌面配置项,沿用 AgentTraceWindowCard 的不本地化约定),避免为最小 UI 扩 locale。
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

// open-design(od)经 MCP 接入预设(FR-5/U6)。「工具一律走 MCP」原则的直接落地:od 以 stdio MCP
// server 形态接入,零核心改动(M2 已支持 stdio command/args 注入)。安全取舍:只暴露端口数字,
// daemon-url 由 http://127.0.0.1:<port> 程序化拼接,host 固定 loopback——杜绝把工作区上下文路由到
// 外部 server(用户改不了 host)。
const OD_PORT_DEFAULT = 7456;
const odArgs = (port: number): string[] => ["mcp", "--daemon-url", `http://127.0.0.1:${port}`];
const isOdServer = (s: McpServerConfig): boolean => s.transport === "stdio" && s.command === "od";
// 从 od server 的 args 反解端口(缺失/非法兜底默认)。
function odPort(s: McpServerConfig): number {
  const i = s.args?.indexOf("--daemon-url") ?? -1;
  const url = i >= 0 ? (s.args?.[i + 1] ?? "") : "";
  const port = Number(url.match(/:(\d+)(?:\/|$)/)?.[1]);
  return Number.isFinite(port) && port > 0 ? port : OD_PORT_DEFAULT;
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
  // od 预设:已存在则不重复添加(id 固定 "od");否则按默认端口接入。
  const addOdPreset = () => {
    if (mcp.servers.some(isOdServer)) return;
    update({ servers: [...mcp.servers, { id: "od", transport: "stdio", command: "od", args: odArgs(OD_PORT_DEFAULT) }] });
  };
  const removeServer = (i: number) => update({ servers: mcp.servers.filter((_, idx) => idx !== i) });

  return (
    <div className="pw-scard">
      <div className="pw-scard-t">MCP 工具</div>

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
            {isOdServer(s) ? (
              // od 预设:仅可改端口,host 固定 127.0.0.1(args 程序化重建)。
              <input
                className="pw-set-input"
                type="number"
                min={1}
                max={65535}
                placeholder="端口(127.0.0.1)"
                aria-label="od daemon 端口"
                value={odPort(s)}
                onChange={(e) => updateServer(i, { args: odArgs(Number(e.target.value) || OD_PORT_DEFAULT) })}
              />
            ) : (
              <input
                className="pw-set-input"
                placeholder={s.transport === "stdio" ? "启动命令(如 /usr/local/bin/mcp-fs)" : "URL"}
                value={s.transport === "stdio" ? (s.command ?? "") : (s.url ?? "")}
                onChange={(e) =>
                  updateServer(i, s.transport === "stdio" ? { command: e.target.value } : { url: e.target.value })
                }
              />
            )}
            <button className="pw-tl-gen" onClick={() => removeServer(i)} aria-label={`删除 ${s.id}`}>
              删除
            </button>
          </div>
        ))
      )}

      <div className="pw-srow pw-srow-actions">
        <button className="pw-tl-gen" onClick={addServer}>
          + 添加 MCP server
        </button>
        <button className="pw-tl-gen" onClick={addOdPreset}>
          + od（open-design）
        </button>
      </div>
      <div className="pw-srow-desc">
        od 预设把 open-design 经 MCP 接入（stdio：<code>od mcp --daemon-url</code>），仅可改端口，host 固定 127.0.0.1。
      </div>
    </div>
  );
}
