// Kun chat/MessageTimeline 的替身：渲染设计右栏的对话转录。用户气泡靠右、助手文本靠左
// (渲染 markdown,复用宿主 .md-body 样式)。连续的工具调用**聚合成一个可折叠组**——默认折叠成
// 一行(N 个操作 + 类型统计),点开逐条看详情(文件路径/命令等)——避免一长串无信息的读取芯片刷屏。
import { useState, type ReactElement } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Pencil } from "lucide-react";
import type { ChatBlock } from "@cortex-work/core/design/compat/agent-types";
import { formatSlidesToolDetail } from "@cortex-work/core/design/slides/slides-tool-detail";

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
  // 改稿闭环最常用的工具:缺了它,一整轮改稿在时间线上只剩裸 mono 名字,看起来像「没跑」。
  set_slides: {
    icon: "✏️",
    label: "改写页面",
    runningLabel: "正在改写页面",
    successLabel: "已更新页面",
    errorLabel: "改写页面失败",
  },
  add_asset: {
    icon: "🖼",
    label: "写入素材",
    runningLabel: "正在写入素材",
    successLabel: "已写入素材",
    errorLabel: "写入素材失败",
  },
  add_source: {
    icon: "🔗",
    label: "记录来源",
    runningLabel: "正在记录来源",
    successLabel: "已记录来源",
    errorLabel: "记录来源失败",
  },
  list_sources: {
    icon: "🔗",
    label: "查看来源",
    runningLabel: "正在查看来源",
    successLabel: "已查看来源",
    errorLabel: "查看来源失败",
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

/** detail 是 input 的 JSON 文本;坏 JSON 返回 undefined(交给下游兜底,绝不抛)。 */
function safeParse(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

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
  // cortex-slides 工具优先走页面粒度详情:主进程已随结果回传 replacedPages / revision,
  // 「已更新页面 第3、7页 · rev 72」比「cortex-slides · set_slides」有信息量得多。
  const { tool } = parseToolId(toolNameOf(block));
  const slidesDetail = formatSlidesToolDetail(tool, block.meta?.input ?? safeParse(block.detail), block.meta?.output);
  if (slidesDetail) return slidesDetail;
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

/**
 * 工具组的展开策略(纯函数,便于单测)。
 *
 * 默认折叠是为了不让一长串「读取」芯片刷屏;但**正在跑的时候**必须展开 ——
 * 用户实测的抱怨正是「改稿过程看不见细节,只有一个结果」:改稿期间十几次 set_slides
 * 全被压成一行「N 个操作」,进度完全不可见。跑完不自动收起(用户往回看时还要它开着)。
 * 用户手动切换过(userToggled)之后一律尊重用户的选择。
 */
export function shouldExpandToolGroup(
  tools: Array<{ status: ToolBlock["status"] }>,
  userToggled: boolean | null,
): boolean {
  if (userToggled !== null) return userToggled;
  return tools.some((t) => t.status === "running");
}

// 连续工具调用的可折叠组。折叠:一行摘要(总数 + 按类型计数);展开:逐条 icon+标签+详情+状态点。
function ToolGroup({ tools }: { tools: ToolBlock[] }): ReactElement {
  // null = 用户还没表态,按 shouldExpandToolGroup 的默认策略走(运行中自动展开)。
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = shouldExpandToolGroup(tools, userToggled);
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
        onClick={() => setUserToggled(!open)}
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

/**
 * system 块的样式:按 severity 分叉。
 * 缺省(undefined)仍按 error 处理 —— 历史上 system 块只用于报错,改默认值会让既有错误静默变灰。
 * info 用于「已更新 第3页 · rev 72」这类进度条目,视觉语言与工具芯片保持一致(中性灰底)。
 */
export function systemBlockClass(severity?: "info" | "warning" | "error"): string {
  const base = "self-start rounded-lg px-3 py-1.5 text-[12px]";
  if (severity === "info") return `${base} border border-ds-border-muted bg-ds-card text-ds-muted`;
  if (severity === "warning") {
    return `${base} border border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-300`;
  }
  return `${base} border border-red-500/25 bg-red-500/8 text-red-600 dark:text-red-300`;
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
          const display =
            typeof block.meta?.displayText === "string" ? block.meta.displayText : block.text;
          const attachments = block.meta?.attachments ?? [];
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
              <div className="flex max-w-[88%] flex-col gap-1.5 whitespace-pre-wrap break-words rounded-2xl rounded-br-sm border border-ds-border-muted bg-[var(--ds-sidebar-row-active)] px-3.5 py-2 text-ds-ink">
                {display ? <div>{display}</div> : null}
                {attachments.length ? (
                  <div className="flex flex-wrap gap-1" data-testid="user-attachments">
                    {attachments.map((attachment) => (
                      <span
                        key={attachment.id}
                        className="rounded-md border border-ds-border-muted bg-white/45 px-1.5 py-0.5 text-[11.5px] text-ds-muted dark:bg-white/6"
                      >
                        {attachment.name}
                        {attachment.truncated ? "（已截断）" : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
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
            <div key={block.id} className={systemBlockClass(block.severity)} data-testid="system-block">
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
