// Kun chat/MessageTimeline 的最小替身：只渲染用户/助手文本块与流式尾巴，
// 供设计右栏的对话转录先可读。工具块折叠/推理展示等富渲染待批5+ 接 cortex
// 既有消息渲染体系时替换。
import type { ChatBlock } from "@cortex-work/core/design/compat/agent-types";

type MessageTimelineProps = {
  blocks: ChatBlock[];
  // 流式中的助手增量文本（尚未落定为 block）。
  live?: string;
  liveReasoning?: string;
} & Record<string, unknown>;

export function MessageTimeline(props: MessageTimelineProps) {
  const { blocks, live } = props;
  return (
    <div className="flex flex-col gap-3 text-sm">
      {blocks.map((block) => {
        if (block.kind === "user") {
          return (
            <div key={block.id} className="self-end rounded-lg bg-black/5 px-3 py-2 dark:bg-white/10">
              {block.text}
            </div>
          );
        }
        if (block.kind === "assistant" && block.text.trim()) {
          return (
            <div key={block.id} className="whitespace-pre-wrap px-1">
              {block.text}
            </div>
          );
        }
        // 工具/审批等其它块类型:最小替身只显示占位行，避免信息完全丢失。
        if (block.kind === "tool") {
          return (
            <div key={block.id} className="px-1 text-xs opacity-60">
              ⚙ {block.summary ?? block.kind}
            </div>
          );
        }
        return null;
      })}
      {live?.trim() ? <div className="whitespace-pre-wrap px-1 opacity-80">{live}</div> : null}
    </div>
  );
}
