// 「连接至自定义 MCP」表单(对齐设计稿)。新增/编辑单个 MCP server:
//   名称 + STDIO/流式 HTTP 切换 +
//   STDIO: 启动命令 / 参数(list) / 环境变量(kv) / 环境变量传递(list) / 工作目录
//   流式 HTTP: URL / 请求头(kv)
// 标签用 zh 字面量(桌面配置项,沿用 McpSection 不本地化约定)。
/* eslint-disable i18next/no-literal-string -- MCP 配置项标签为桌面专用,暂不本地化 */

import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import type { McpServerConfig } from "@cortex-work/core";

type Transport = "stdio" | "http";
type KV = { k: string; v: string };

// id 须 TOML 裸键安全(字母数字 + - _);从名称 slug 化,空则兜底。
function slugifyId(name: string, fallback: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || fallback;
}

function recordToKV(rec?: Record<string, string>): KV[] {
  return rec ? Object.entries(rec).map(([k, v]) => ({ k, v })) : [];
}
function kvToRecord(list: KV[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const { k, v } of list) if (k.trim()) out[k.trim()] = v;
  return Object.keys(out).length ? out : undefined;
}

export function McpServerForm({
  initial,
  existingIds,
  onSave,
  onCancel,
}: {
  initial?: McpServerConfig;
  existingIds: string[]; // 用于新建时生成不冲突的兜底 id
  onSave: (config: McpServerConfig) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.label ?? initial?.id ?? "");
  const [transport, setTransport] = useState<Transport>(initial?.transport === "stdio" || !initial ? "stdio" : "http");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState<string[]>(initial?.args ?? []);
  const [env, setEnv] = useState<KV[]>(recordToKV(initial?.env));
  const [passthrough, setPassthrough] = useState<string[]>(initial?.envPassthrough ?? []);
  const [cwd, setCwd] = useState(initial?.cwd ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [headers, setHeaders] = useState<KV[]>(recordToKV(initial?.headers));

  const fallbackId = useMemo(() => {
    const set = new Set(existingIds);
    let n = set.size + 1;
    while (set.has(`server-${n}`)) n += 1;
    return `server-${n}`;
  }, [existingIds]);

  const canSave = name.trim().length > 0 && (transport === "stdio" ? command.trim().length > 0 : url.trim().length > 0);

  const save = () => {
    if (!canSave) return;
    const id = initial?.id ?? slugifyId(name, fallbackId);
    const base: McpServerConfig = { id, label: name.trim(), transport: transport === "http" ? "http" : "stdio" };
    if (transport === "stdio") {
      const cleanArgs = args.map((a) => a.trim()).filter(Boolean);
      const cleanPass = passthrough.map((p) => p.trim()).filter(Boolean);
      onSave({
        ...base,
        command: command.trim(),
        ...(cleanArgs.length ? { args: cleanArgs } : {}),
        ...(kvToRecord(env) ? { env: kvToRecord(env) } : {}),
        ...(cleanPass.length ? { envPassthrough: cleanPass } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      });
    } else {
      onSave({ ...base, url: url.trim(), ...(kvToRecord(headers) ? { headers: kvToRecord(headers) } : {}) });
    }
  };

  return (
    <div className="pw-mcpf">
      <div className="pw-mcpf-title">连接至自定义 MCP</div>

      {/* 名称 + transport 切换 */}
      <div className="pw-mcpf-card">
        <label className="pw-mcpf-field">
          <span className="pw-mcpf-label">名称</span>
          <input className="pw-mcpf-input" placeholder="MCP server name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="pw-mcpf-seg" role="tablist" aria-label="传输方式">
          <button type="button" role="tab" aria-selected={transport === "stdio"} className={`pw-mcpf-seg-btn ${transport === "stdio" ? "is-on" : ""}`} onClick={() => setTransport("stdio")}>
            STDIO
          </button>
          <button type="button" role="tab" aria-selected={transport === "http"} className={`pw-mcpf-seg-btn ${transport === "http" ? "is-on" : ""}`} onClick={() => setTransport("http")}>
            流式 HTTP
          </button>
        </div>
      </div>

      {transport === "stdio" ? (
        <div className="pw-mcpf-card">
          <label className="pw-mcpf-field">
            <span className="pw-mcpf-label">启动命令</span>
            <input className="pw-mcpf-input" placeholder="openai-dev-mcp serve-sqlite" value={command} onChange={(e) => setCommand(e.target.value)} />
          </label>

          {/* 参数 */}
          <div className="pw-mcpf-field">
            <span className="pw-mcpf-label">参数</span>
            <ListEditor items={args} onChange={setArgs} placeholder="" addLabel="添加参数" />
          </div>

          {/* 环境变量(kv) */}
          <div className="pw-mcpf-field">
            <span className="pw-mcpf-label">环境变量</span>
            <KVEditor items={env} onChange={setEnv} addLabel="添加环境变量" />
          </div>

          {/* 环境变量传递(list of names) */}
          <div className="pw-mcpf-field">
            <span className="pw-mcpf-label">环境变量传递</span>
            <ListEditor items={passthrough} onChange={setPassthrough} placeholder="" addLabel="添加变量" />
          </div>

          <label className="pw-mcpf-field">
            <span className="pw-mcpf-label">工作目录</span>
            <input className="pw-mcpf-input" placeholder="~/code" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          </label>
        </div>
      ) : (
        <div className="pw-mcpf-card">
          <label className="pw-mcpf-field">
            <span className="pw-mcpf-label">URL</span>
            <input className="pw-mcpf-input" placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <div className="pw-mcpf-field">
            <span className="pw-mcpf-label">请求头</span>
            <KVEditor items={headers} onChange={setHeaders} addLabel="添加请求头" />
          </div>
        </div>
      )}

      <div className="pw-mcpf-foot">
        <button type="button" className="pw-btn" onClick={onCancel}>取消</button>
        <button type="button" className="pw-btn pw-btn-primary" disabled={!canSave} onClick={save}>保存</button>
      </div>
    </div>
  );
}

// 单值列表编辑(参数 / 环境变量传递):每行一个输入 + 删除,底部「+ 添加」。
function ListEditor({ items, onChange, placeholder, addLabel }: { items: string[]; onChange: (v: string[]) => void; placeholder: string; addLabel: string }) {
  return (
    <div className="pw-mcpf-list">
      {items.map((val, i) => (
        <div key={i} className="pw-mcpf-list-row">
          <input className="pw-mcpf-input" placeholder={placeholder} value={val} onChange={(e) => onChange(items.map((x, idx) => (idx === i ? e.target.value : x)))} />
          <button type="button" className="pw-mcpf-del" aria-label="删除" onClick={() => onChange(items.filter((_, idx) => idx !== i))}>
            <Icon.Trash size={15} />
          </button>
        </div>
      ))}
      <button type="button" className="pw-mcpf-add" onClick={() => onChange([...items, ""])}>
        <Icon.Plus size={13} /> {addLabel}
      </button>
    </div>
  );
}

// 键值对列表编辑(环境变量 / 请求头)。
function KVEditor({ items, onChange, addLabel }: { items: KV[]; onChange: (v: KV[]) => void; addLabel: string }) {
  return (
    <div className="pw-mcpf-list">
      {items.map((kv, i) => (
        <div key={i} className="pw-mcpf-list-row">
          <input className="pw-mcpf-input" placeholder="键" value={kv.k} onChange={(e) => onChange(items.map((x, idx) => (idx === i ? { ...x, k: e.target.value } : x)))} />
          <input className="pw-mcpf-input" placeholder="值" value={kv.v} onChange={(e) => onChange(items.map((x, idx) => (idx === i ? { ...x, v: e.target.value } : x)))} />
          <button type="button" className="pw-mcpf-del" aria-label="删除" onClick={() => onChange(items.filter((_, idx) => idx !== i))}>
            <Icon.Trash size={15} />
          </button>
        </div>
      ))}
      <button type="button" className="pw-mcpf-add" onClick={() => onChange([...items, { k: "", v: "" }])}>
        <Icon.Plus size={13} /> {addLabel}
      </button>
    </div>
  );
}
