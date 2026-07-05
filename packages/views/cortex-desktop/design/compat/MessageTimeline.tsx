// Kun chat/MessageTimeline 的替身：渲染设计右栏的对话转录。用户气泡靠右、助手文本靠左
// (渲染 markdown,复用宿主 .md-body 样式)。连续的工具调用**聚合成一个可折叠组**——默认折叠成
// 一行(N 个操作 + 类型统计),点开逐条看详情(文件路径/命令等)——避免一长串无信息的读取芯片刷屏。
import { useState, type ReactElement } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatBlock } from "@cortex-work/core/design/compat/agent-types";

const MD_PLUGINS = [remarkGfm];

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;

type MessageTimelineProps = {
  blocks: ChatBlock[];
  // 流式中的助手增量文本（尚未落定为 block）。
  live?: string;
  liveReasoning?: string;
} & Record<string, unknown>;

// 工具名 → 简短中文标签 + 图标。未知工具回退原名。
const TOOL_META: Record<string, { icon: string; label: string }> = {
  read: { icon: "📖", label: "读取" },
  write: { icon: "✏️", label: "写入" },
  edit: { icon: "✏️", label: "编辑" },
  bash: { icon: "❯_", label: "命令" },
  delegate_task: { icon: "⚡", label: "并行子任务" },
  ls: { icon: "📂", label: "列目录" },
  grep: { icon: "🔎", label: "搜索" },
  glob: { icon: "🔎", label: "查找" },
};

function toolNameOf(block: ToolBlock): string {
  const fromMeta = typeof block.meta?.toolName === "string" ? block.meta.toolName : "";
  if (fromMeta) return fromMeta;
  return (block.summary || "").split(/[\s·]/)[0] || "工具";
}

function metaFor(name: string): { icon: string; label: string } {
  return TOOL_META[name] ?? { icon: "⚙", label: name };
}

// 从工具 block 的 detail(input JSON)里提取一行可读摘要:文件路径 / 命令 / 标签等。
function toolDetailLine(block: ToolBlock): string {
  const raw = block.detail;
  if (!raw) return "";
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch {
    return raw.length > 120 ? raw.slice(0, 120) + "…" : raw;
  }
  const pick = (k: string): string | undefined => (typeof obj?.[k] === "string" ? (obj[k] as string) : undefined);
  const path = pick("file_path") ?? pick("path") ?? pick("filePath");
  if (path) return path.replace(/^.*\.cortex-design\//, ".cortex-design/"); // 只显尾部相对路径
  const command = pick("command");
  if (command) return command;
  const label = pick("label");
  if (label) return label;
  const pattern = pick("pattern");
  if (pattern) return pattern;
  return "";
}

function statusDotClass(status: string): string {
  if (status === "running") return "bg-amber-500 animate-pulse";
  if (status === "error") return "bg-red-500";
  return "bg-emerald-500";
}

// 连续工具调用的可折叠组。折叠:一行摘要(总数 + 按类型计数);展开:逐条 icon+标签+详情+状态点。
function ToolGroup({ tools }: { tools: ToolBlock[] }): ReactElement {
  const [open, setOpen] = useState(false);
  const anyRunning = tools.some((t) => t.status === "running");
  const anyError = tools.some((t) => t.status === "error");
  // 按工具类型计数,拼成 "读取 ×8 · 命令 ×2"。
  const counts = new Map<string, number>();
  for (const t of tools) {
    const n = toolNameOf(t);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()].map(([n, c]) => `${metaFor(n).label}${c > 1 ? ` ×${c}` : ""}`).join(" · ");
  const summaryDot = anyError ? "error" : anyRunning ? "running" : "success";

  // 单个工具调用不折叠,直接显示一行芯片(带详情)。
  if (tools.length === 1) {
    const t = tools[0]!;
    const m = metaFor(toolNameOf(t));
    const detail = toolDetailLine(t);
    return (
      <div className="flex items-center gap-2 self-start rounded-full border border-ds-border-muted bg-ds-card px-2.5 py-1 text-[11.5px] text-ds-muted">
        <span aria-hidden="true">{m.icon}</span>
        <span className="font-medium text-ds-ink">{m.label}</span>
        {detail ? <span className="max-w-[220px] truncate opacity-70">{detail}</span> : null}
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(t.status)}`} />
      </div>
    );
  }

  return (
    <div className="self-start">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-ds-border-muted bg-ds-card px-2.5 py-1 text-[11.5px] text-ds-muted transition hover:bg-ds-hover"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="font-medium text-ds-ink">{tools.length} 个操作</span>
        <span className="opacity-70">{breakdown}</span>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(summaryDot)}`} />
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-1 border-l border-ds-border-muted pl-3">
          {tools.map((t) => {
            const m = metaFor(toolNameOf(t));
            const detail = toolDetailLine(t);
            return (
              <div key={t.id} className="flex items-center gap-2 text-[11.5px] text-ds-muted">
                <span aria-hidden="true">{m.icon}</span>
                <span className="text-ds-ink">{m.label}</span>
                {detail ? <span className="min-w-0 flex-1 truncate opacity-70">{detail}</span> : null}
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(t.status)}`} />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// 把连续的 tool block 聚成组;其它块类型保持独立。返回渲染段列表。
type Segment = { kind: "tools"; tools: ToolBlock[] } | { kind: "block"; block: ChatBlock };

function segmentize(blocks: ChatBlock[]): Segment[] {
  const segs: Segment[] = [];
  for (const block of blocks) {
    if (block.kind === "tool") {
      const last = segs[segs.length - 1];
      if (last && last.kind === "tools") last.tools.push(block);
      else segs.push({ kind: "tools", tools: [block] });
    } else {
      segs.push({ kind: "block", block });
    }
  }
  return segs;
}

export function MessageTimeline(props: MessageTimelineProps): ReactElement {
  const { blocks, live } = props;
  const segments = segmentize(blocks);
  return (
    <div className="flex flex-col gap-2.5 px-1 py-2 text-[13px] leading-relaxed">
      {segments.map((seg, i) => {
        if (seg.kind === "tools") {
          return <ToolGroup key={`tools-${i}`} tools={seg.tools} />;
        }
        const block = seg.block;
        if (block.kind === "user") {
          const display = (block.meta?.displayText as string | undefined)?.trim() || block.text;
          return (
            <div key={block.id} className="flex justify-end">
              <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-[var(--ds-sidebar-row-active)] px-3.5 py-2 text-ds-ink">
                {display}
              </div>
            </div>
          );
        }
        if (block.kind === "assistant" && block.text.trim()) {
          return (
            <div key={block.id} className="md-body px-0.5 text-ds-ink">
              <Markdown remarkPlugins={MD_PLUGINS}>{block.text}</Markdown>
            </div>
          );
        }
        if (block.kind === "system" && block.text.trim()) {
          return (
            <div
              key={block.id}
              className="self-start rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-1.5 text-[12px] text-red-600 dark:text-red-300"
            >
              {block.text}
            </div>
          );
        }
        return null;
      })}
      {live?.trim() ? (
        <div className="md-body px-0.5 text-ds-ink opacity-80">
          <Markdown remarkPlugins={MD_PLUGINS}>{live}</Markdown>
        </div>
      ) : null}
    </div>
  );
}
