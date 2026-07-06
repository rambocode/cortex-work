// Cmd-K 就地改写(U3)渲染端可复用的纯逻辑:请求构造(前后缀窗口 + 选区)/替换应用/审阅入参组装。
// 参照 Kun src/renderer/src/write/inline-edit.ts,但去掉 recent-edits/scope 推断等 Kun 专属信号(本轮不做)。
//
// 关键约束:
//   - 前缀窗口取尾 6000、后缀窗口取头 4000(对齐 Kun),原文=当前选区 [from,to)。
//   - 改写结果不进聊天历史,而是组合成全文 next 后走既有 diff 审阅(beginReview),复用 U6 红绿裁决通道。
//   - origin 取 ReviewOrigin 允许值 "agent"(模型生成的改动,语义最贴近),不新建第二套 diff。

import type { WritingInlineEditRequest } from "../desktop/writing-llm-types";
import type { ReviewOrigin } from "./review-manager";

// 前后缀上下文窗口(与主进程 writing-llm 的窗口一致;对齐 Kun 6000/4000)。
export const WRITING_INLINE_EDIT_PREFIX_WINDOW = 6_000;
export const WRITING_INLINE_EDIT_SUFFIX_WINDOW = 4_000;

// 夹取偏移到 [0,len]。
function clampOffset(len: number, offset: number): number {
  const v = Number(offset);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(len, Math.floor(v)));
}

// 取尾/取头窗口。
function clipTail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}
function clipHead(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

// Cmd-K 是否可执行:已配置 + 存在非空选区。无选区/未配置一律禁用(渲染端据此不触发)。
export function canRunWritingInlineEdit(
  configured: boolean,
  selectionText: string | undefined | null,
): boolean {
  return configured && !!selectionText && selectionText.trim().length > 0;
}

// 构造就地改写请求:归一化 from/to(容忍反向选区)→ 前后缀窗口 + 选区原文 + 指令。
export function buildWritingInlineEditRequest(
  content: string,
  from: number,
  to: number,
  instruction: string,
  language = "markdown",
): WritingInlineEditRequest {
  const lo = clampOffset(content.length, Math.min(from, to));
  const hi = clampOffset(content.length, Math.max(from, to));
  return {
    prefix: clipTail(content.slice(0, lo), WRITING_INLINE_EDIT_PREFIX_WINDOW),
    suffix: clipHead(content.slice(hi), WRITING_INLINE_EDIT_SUFFIX_WINDOW),
    original: content.slice(lo, hi),
    instruction,
    language,
  };
}

// 把替换文本写入 [from,to) 区间,产出改写后的全文(from/to 已在调用侧对当前内容取自选区)。
export function applyWritingInlineEditReplacement(
  content: string,
  from: number,
  to: number,
  replacement: string,
): string {
  const lo = clampOffset(content.length, Math.min(from, to));
  const hi = clampOffset(content.length, Math.max(from, to));
  return `${content.slice(0, lo)}${replacement}${content.slice(hi)}`;
}

// 组装 beginReview 入参:baseline=改写前全文、next=改写后全文、origin=agent(复用既有审阅,不新建通道)。
export function buildWritingInlineEditReviewInput(
  content: string,
  from: number,
  to: number,
  replacement: string,
): { baseline: string; next: string; origin: ReviewOrigin } {
  return {
    baseline: content,
    next: applyWritingInlineEditReplacement(content, from, to, replacement),
    origin: "agent",
  };
}
