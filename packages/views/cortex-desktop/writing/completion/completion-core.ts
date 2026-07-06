// ghost text 续写的 CodeMirror 无关纯逻辑(U3):窗口切取、触发判定、Tab 采纳位移。
// 抽出这些纯函数是为在不拉起 CM/DOM 的前提下就近单测(CM 扩展本体在 ghost-text.ts,只做薄胶水)。

// 前后缀窗口(与主进程 writing-llm 窗口一致;对齐 Kun 6000/4000)。
export const WRITING_COMPLETION_PREFIX_WINDOW = 6_000;
export const WRITING_COMPLETION_SUFFIX_WINDOW = 4_000;
// 去抖阈值:打字停顿 ≥600ms 才请求续写(避免每次击键都发,省 token 且不打扰)。
export const WRITING_COMPLETION_DEBOUNCE_MS = 600;

// 从整篇文档 + 光标偏移切出前后缀窗口(prefix 保尾、suffix 保头)。
export function buildCompletionWindows(doc: string, head: number): { prefix: string; suffix: string } {
  const h = Math.max(0, Math.min(doc.length, head));
  return {
    prefix: doc.slice(Math.max(0, h - WRITING_COMPLETION_PREFIX_WINDOW), h),
    suffix: doc.slice(h, Math.min(doc.length, h + WRITING_COMPLETION_SUFFIX_WINDOW)),
  };
}

// 是否发起续写:启用(已配置 + ghost text 开关开)且光标前有实义字符(空白开头不触发)。
export function shouldRequestCompletion(enabled: boolean, prefix: string): boolean {
  return enabled && prefix.trim().length > 0;
}

// Tab 采纳:在光标 head 处插入 ghost 文本,光标移到插入末尾。
export function computeGhostAccept(
  _doc: string,
  head: number,
  text: string,
): { from: number; insert: string; anchor: number } {
  return { from: head, insert: text, anchor: head + text.length };
}
