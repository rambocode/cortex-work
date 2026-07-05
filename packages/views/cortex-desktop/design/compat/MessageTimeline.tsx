// Kun chat/MessageTimeline 的替身：渲染设计右栏的对话转录。用户气泡靠右、助手文本靠左,
// 工具调用折叠成一行紧凑的状态芯片(图标 + 名称 + 状态点),流式尾巴接在末尾。
import type { ChatBlock } from "@cortex-work/core/design/compat/agent-types";

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

// 从工具 block 的 summary/meta 里取工具名。
function toolNameOf(block: Extract<ChatBlock, { kind: "tool" }>): string {
  const fromMeta = typeof block.meta?.toolName === "string" ? block.meta.toolName : "";
  if (fromMeta) return fromMeta;
  return (block.summary || "").split(/[\s·]/)[0] || "工具";
}

// 状态点颜色:运行中(琥珀脉动)/成功(绿)/失败(红)。
function statusDotClass(status: string): string {
  if (status === "running") return "bg-amber-500 animate-pulse";
  if (status === "error") return "bg-red-500";
  return "bg-emerald-500";
}

export function MessageTimeline(props: MessageTimelineProps) {
  const { blocks, live } = props;
  return (
    <div className="flex flex-col gap-2.5 px-1 py-2 text-[13px] leading-relaxed">
      {blocks.map((block) => {
        if (block.kind === "user") {
          // 设计回合的 block.text 是完整 prompt(很长),气泡优先展示简短的 displayText。
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
            <div key={block.id} className="whitespace-pre-wrap break-words px-0.5 text-ds-ink">
              {block.text}
            </div>
          );
        }
        if (block.kind === "tool") {
          const name = toolNameOf(block);
          const meta = TOOL_META[name] ?? { icon: "⚙", label: name };
          return (
            <div
              key={block.id}
              className="flex items-center gap-2 self-start rounded-full border border-ds-border-muted bg-ds-card px-2.5 py-1 text-[11.5px] text-ds-muted"
              title={block.summary}
            >
              <span aria-hidden="true">{meta.icon}</span>
              <span className="font-medium text-ds-ink">{meta.label}</span>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(block.status)}`} />
            </div>
          );
        }
        if (block.kind === "system" && block.text.trim()) {
          // 系统/错误提示:红底细条。
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
        <div className="whitespace-pre-wrap break-words px-0.5 text-ds-ink opacity-80">{live}</div>
      ) : null}
    </div>
  );
}
