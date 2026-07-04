// Kun store/chat-store-runtime-helpers 的裁剪版：仅保留 design 树消费的
// 「回合是否仍在运行 / 收集回合内 assistant 文本」两组纯函数及其私有依赖。
// 与 Kun 语义差异：background-shell 通知消息的识别简化为只看 meta.messageSource
// （cortex 的设计回合不会产生该类消息，保留判断只为行为兼容）。
import type { ChatBlock } from "./agent-types";

function runtimeStatusLooksRunning(status?: string): boolean {
  const normalized = status?.trim().toLowerCase();
  return (
    normalized === "running" ||
    normalized === "in_progress" ||
    normalized === "queued" ||
    normalized === "started"
  );
}

// 简化版 background-shell 通知识别（Kun 版还会从正文推断来源）。
function isBackgroundShellNoticeUserMessage(block: { meta?: Record<string, unknown> | null }): boolean {
  return (block.meta as Record<string, unknown> | undefined)?.messageSource === "background_shell";
}

// 单个块是否仍有未完成的 runtime 工作（工具运行中/等待审批或输入）。
export function hasPendingRuntimeWork(block: ChatBlock): boolean {
  if (block.kind === "tool") return block.status === "running";
  if (block.kind === "compaction") return block.status === "running";
  if (block.kind === "review") return block.status === "running";
  if (block.kind === "approval") return block.status === "pending";
  if (block.kind === "user_input") return block.status === "pending";
  return false;
}

function assistantBlockHasVisibleContent(block: Extract<ChatBlock, { kind: "assistant" }>): boolean {
  const withoutThink = block.text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
  return withoutThink.length > 0;
}

// 时间线级判断：最近一个用户消息之后是否还有挂起的 runtime 工作。
// 注意「pendingInCurrentTurn」在遇到有可见内容的 assistant 块时清零——
// 工具挂起后若 assistant 已产出正文，视为该轮工作已推进完。
export function threadHasPendingRuntimeWork(blocks: ChatBlock[]): boolean {
  let pendingInCurrentTurn = false;

  for (const block of blocks) {
    if (block.kind === "user") {
      if (isBackgroundShellNoticeUserMessage(block)) continue;
      pendingInCurrentTurn = false;
      continue;
    }
    if (hasPendingRuntimeWork(block)) {
      pendingInCurrentTurn = true;
      continue;
    }
    if (pendingInCurrentTurn && block.kind === "assistant" && assistantBlockHasVisibleContent(block)) {
      pendingInCurrentTurn = false;
    }
  }

  return pendingInCurrentTurn;
}

// 快照级判断：优先信 thread 状态字符串，否则回退时间线扫描。
export function threadSnapshotLooksRunning(blocks: ChatBlock[], threadStatus?: string): boolean {
  if (threadStatus != null && threadStatus.trim()) {
    return runtimeStatusLooksRunning(threadStatus);
  }
  return threadHasPendingRuntimeWork(blocks);
}

// 收集 userBlockId 对应回合内的全部 assistant 文本（含流式未落定的 liveAssistant 尾巴）。
export function collectAssistantTextForTurn(
  blocks: ChatBlock[],
  userBlockId: string,
  liveAssistant: string,
): string {
  const userIndex = blocks.findIndex((block) => block.kind === "user" && block.id === userBlockId);
  if (userIndex < 0) return liveAssistant.trim();
  const parts: string[] = [];
  for (let index = userIndex + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    if (block.kind === "user") break;
    if (block.kind === "assistant" && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  if (liveAssistant.trim()) parts.push(liveAssistant.trim());
  return parts.join("\n\n").trim();
}
