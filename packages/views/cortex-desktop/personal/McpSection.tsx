// MCP 设置卡片(M2 U3)。总开关 + server 清单 + 增删/启停。新增/编辑走独立页(由 PluginManagePage
// 通过 onEdit 上提渲染 McpServerForm,见该文件),本卡只负责列表与 od 预设,不内联表单。
// 读写 generalSettings.mcp,经 store 自动持久化;主进程在 cli:start 按总开关注入(ipc/mcp-config.ts)。
// 标签用 zh 字面量(桌面配置项不本地化)。
/* eslint-disable i18next/no-literal-string -- MCP 配置项标签为桌面专用,暂不本地化 */

import { Icon } from "@cortex-work/ui/icons";
import { usePersonalStore } from "@cortex-work/core";
import type { McpServerConfig, McpSettings } from "@cortex-work/core";

const EMPTY: McpSettings = { enabled: false, servers: [] };

// open-design(od)经 MCP 接入预设(FR-5/U6)。od 以 stdio MCP server 接入,host 固定 loopback。
const OD_PORT_DEFAULT = 7456;
const odArgs = (port: number): string[] => ["mcp", "--daemon-url", `http://127.0.0.1:${port}`];
const isOdServer = (s: McpServerConfig): boolean => s.transport === "stdio" && s.command === "od";

export function McpCard({ onEdit }: { onEdit: (index: number | null) => void }) {
  const general = usePersonalStore((s) => s.generalSettings);
  const setGeneral = usePersonalStore((s) => s.setGeneralSettings);
  const mcp: McpSettings = general.mcp ?? EMPTY;

  const update = (patch: Partial<McpSettings>) => setGeneral({ mcp: { ...mcp, ...patch } });
  const removeServer = (i: number) => update({ servers: mcp.servers.filter((_, idx) => idx !== i) });
  const addOdPreset = () => {
    if (mcp.servers.some(isOdServer)) return;
    update({ servers: [...mcp.servers, { id: "od", label: "od", transport: "stdio", command: "od", args: odArgs(OD_PORT_DEFAULT) }] });
  };

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
        <button className="pw-tl-gen" onClick={addOdPreset}>
          + od（open-design）
        </button>
      </div>
      <div className="pw-srow-desc">
        od 预设把 open-design 经 MCP 接入（stdio：<code>od mcp --daemon-url</code>），host 固定 127.0.0.1。
      </div>
    </div>
  );
}
