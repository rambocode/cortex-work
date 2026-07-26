// Kun chat/MessageTimeline 的替身：渲染设计右栏的对话转录。用户气泡靠右、助手文本靠左
// (渲染 markdown,复用宿主 .md-body 样式)。连续的工具调用**聚合成一个可折叠组**——默认折叠成
// 一行(N 个操作 + 类型统计),点开逐条看详情(文件路径/命令等)——避免一长串无信息的读取芯片刷屏。
import { useState, type ReactElement } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Pencil } from "lucide-react";
import type { ChatBlock } from "@cortex-work/core/design/compat/agent-types";

const MD_PLUGINS = [remarkGfm];
// 本组件是 Kun 的替身层,不接 i18n(同文件其余文案亦为硬编码中文)。
const EDIT_AND_RESEND_LABEL = "编辑并重新发送";

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;

type MessageTimelineProps = {
  blocks: ChatBlock[];
  // 流式中的助手增量文本（尚未落定为 block）。
  live?: string;
  liveReasoning?: string;
  busy?: boolean;
  busyLabel?: string;
  /**
   * 「编辑重发」:把这条用户消息的原话放回输入框。
   * 回合可能因供应商侧错误失败(如 402 Insufficient Balance),原话却只留在气泡里 ——
   * 用户得手打一遍才能重试。传入即在用户气泡上显示编辑按钮。
   */
  onEditUserMessage?: (text: string) => void;
} & Record<string, unknown>;

// 工具名 → 简短中文标签 + 图标。key 一律小写(查表时归一化),未知工具回退短名 + 等宽截断。
type ToolMeta = {
  icon: string;
  label: string;
  runningLabel?: string;
  successLabel?: string;
  errorLabel?: string;
};

const TOOL_META: Record<string, ToolMeta> = {
  // —— 内置工具 ——
  read: { icon: "📖", label: "读取" },
  write: { icon: "✏️", label: "写入" },
  edit: { icon: "✏️", label: "编辑" },
  bash: { icon: "❯_", label: "命令" },
  ls: { icon: "📂", label: "列目录" },
  grep: { icon: "🔎", label: "搜索" },
  glob: { icon: "🔎", label: "查找" },
  toolsearch: { icon: "🧰", label: "查工具" },
  webfetch: { icon: "🌐", label: "抓网页" },
  websearch: { icon: "🌐", label: "联网搜索" },
  task: { icon: "⚡", label: "子任务" },
  delegate_task: { icon: "⚡", label: "并行子任务" },
  // —— cortex-slides MCP(bento 化,见 apps/desktop/src/main/capabilities/slides/tools.ts)——
  get_deck_state: {
    icon: "📄",
    label: "读取状态",
    runningLabel: "正在读取状态",
    successLabel: "已读取状态",
    errorLabel: "读取状态失败",
  },
  propose_outline: {
    icon: "🧭",
    label: "提交提纲",
    runningLabel: "正在提交提纲",
    successLabel: "已提交提纲",
    errorLabel: "提交提纲失败",
  },
  set_deck_doc: {
    icon: "✏️",
    label: "写入文档",
    runningLabel: "正在写入文档",
    successLabel: "已写入文档",
    errorLabel: "写入文档失败",
  },
  add_asset: {
    icon: "🖼",
    label: "写入素材",
    runningLabel: "正在写入素材",
    successLabel: "已写入素材",
    errorLabel: "写入素材失败",
  },
  // —— 其它工作台 MCP ——
  generate_image: { icon: "🖼", label: "生成图片" },
  generate_video: { icon: "🎬", label: "生成视频" },
  generate_music: { icon: "🎵", label: "生成音乐" },
  generate_speech: { icon: "🔊", label: "生成语音" },
  extract_document: { icon: "📄", label: "提取文档" },
  browser_click: { icon: "🖱", label: "点击" },
  browser_read_console: { icon: "🖥", label: "读控制台" },
  browser_screenshot: { icon: "📸", label: "浏览器截图" },
};

function toolNameOf(block: ToolBlock): string {
  const fromMeta = typeof block.meta?.toolName === "string" ? block.meta.toolName : "";
  if (fromMeta) return fromMeta;
  return (block.summary || "").split(/[\s·]/)[0] || "工具";
}

// 解析 mcp__<server>__<tool>:按 `__` 双下划线切分,兼容含连字符的 server id(cortex-slides 等)。
function parseToolId(raw: string): { server: string; tool: string } {
  if (raw.startsWith("mcp__")) {
    const rest = raw.slice(5);
    const i = rest.indexOf("__");
    if (i >= 0) return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
  }
  return { server: "", tool: raw };
}

// 查表大小写不敏感(运行时工具名多为首字母大写 Read/ToolSearch,表 key 全小写)。
// 未知工具兜底:只显 tool 短名 + 等宽字体(mono),渲染处 truncate,绝不让长名撑破布局。
function metaFor(rawName: string): ToolMeta & { mono?: boolean } {
  const { tool } = parseToolId(rawName);
  return TOOL_META[tool.toLowerCase()] ?? { icon: "⚙", label: tool, mono: true };
}

function toolStatusLabel(rawName: string, status: ToolBlock["status"]): string {
  const meta = metaFor(rawName);
  if (status === "running") return meta.runningLabel ?? meta.label;
  if (status === "error") return meta.errorLabel ?? meta.label;
  return meta.successLabel ?? meta.label;
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
  // MCP 调用优先显示被调工具名:芯片标签只写「MCP」,不带工具名时一屏三个「MCP」看不出
  // 各自在做什么(用户实测)。codex 的 mcp_tool_call item 形如
  // { server:"cortex-slides", tool:"get_deck_state", arguments:{…} } —— 走 input JSON 落进
  // detail 后,原先只认 file_path/command/label/pattern,于是整条摘要为空。
  const mcpTool = pick("tool");
  if (mcpTool) {
    const server = pick("server");
    return server ? `${server} · ${mcpTool}` : mcpTool;
  }
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
      <div className="flex max-w-full items-center gap-2 self-start rounded-lg border border-ds-border-muted bg-ds-card px-2.5 py-1 text-[11.5px] text-ds-muted">
        <span className="shrink-0" aria-hidden="true">{m.icon}</span>
        {/* 未知工具(mono)用等宽 + 截断,防止超长 MCP 工具名撑破芯片 */}
        <span className={`shrink-0 whitespace-nowrap font-medium text-ds-ink${m.mono ? " max-w-[160px] truncate font-mono" : ""}`}>{toolStatusLabel(toolNameOf(t), t.status)}</span>
        {detail ? <span className="min-w-0 flex-1 truncate opacity-70">{detail}</span> : null}
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(t.status)}`} />
      </div>
    );
  }

  return (
    // self-stretch + min-w-0:给内部 truncate 一个确定的宽度基准,避免长 breakdown 撑成多行椭圆
    <div className="min-w-0 self-stretch">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg border border-ds-border-muted bg-ds-card px-2.5 py-1.5 text-left text-[11.5px] text-ds-muted transition hover:bg-ds-hover"
      >
        <span className="shrink-0" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="shrink-0 font-medium text-ds-ink">{tools.length} 个操作</span>
        <span className="min-w-0 flex-1 truncate opacity-70">{breakdown}</span>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(summaryDot)}`} />
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-1 border-l border-ds-border-muted pl-3">
          {tools.map((t) => {
            const m = metaFor(toolNameOf(t));
            const detail = toolDetailLine(t);
            return (
              <div key={t.id} className="flex items-center gap-2 text-[11.5px] text-ds-muted">
                <span className="shrink-0" aria-hidden="true">{m.icon}</span>
                <span className={`shrink-0 whitespace-nowrap text-ds-ink${m.mono ? " max-w-[140px] truncate font-mono" : ""}`}>{toolStatusLabel(toolNameOf(t), t.status)}</span>
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
  const { blocks, live, busy = false, busyLabel = "Agent 处理中…", onEditUserMessage } = props;
  const segments = segmentize(blocks);
  const hasRunningTool = blocks.some((block) => block.kind === "tool" && block.status === "running");
  return (
    <div className="flex flex-col gap-3.5 px-1 py-2 text-[13px] leading-relaxed">
      {segments.map((seg, i) => {
        if (seg.kind === "tools") {
          return <ToolGroup key={`tools-${i}`} tools={seg.tools} />;
        }
        const block = seg.block;
        if (block.kind === "user") {
          // displayText 是用户原话(不含上下文/合同拼装),编辑重发要回填的正是它。
          const display = (block.meta?.displayText as string | undefined)?.trim() || block.text;
          return (
            <div key={block.id} className="group flex items-start justify-end gap-1">
              {onEditUserMessage && display.trim() ? (
                <button
                  type="button"
                  onClick={() => onEditUserMessage(display)}
                  // 常态隐藏、悬停/聚焦浮现:时间线上每条都挂一个可见按钮太吵。
                  className="mt-1 shrink-0 rounded-md p-1 text-ds-faint opacity-0 transition hover:bg-ds-hover hover:text-ds-ink focus-visible:opacity-100 group-hover:opacity-100"
                  title={EDIT_AND_RESEND_LABEL}
                  aria-label={EDIT_AND_RESEND_LABEL}
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={1.9} />
                </button>
              ) : null}
              <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm border border-ds-border-muted bg-[var(--ds-sidebar-row-active)] px-3.5 py-2 text-ds-ink">
                {display}
              </div>
            </div>
          );
        }
        if (block.kind === "assistant" && block.text.trim()) {
          return (
            <div key={block.id} className="md-body md-soft px-0.5 text-ds-ink">
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
        <div className="md-body md-soft px-0.5 text-ds-ink opacity-80">
          <Markdown remarkPlugins={MD_PLUGINS}>{live}</Markdown>
        </div>
      ) : null}
      {busy && !hasRunningTool ? (
        <div className="flex items-center gap-2 self-start rounded-lg border border-ds-border-muted bg-ds-card px-2.5 py-1 text-[11.5px] text-ds-muted">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
          <span>{busyLabel}</span>
        </div>
      ) : null}
    </div>
  );
}
