// Markdown 代码块外壳的共享零件:文件预览(MarkdownView)与个人区会话流(chatMarkdown / ChatArea)共用,
// 保证「代码块背景 + 右上角复制 + 语言角标」在两处形态一致,不再各写一份。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";

// 接入高亮后 <code> 的子节点会变成嵌套 <span>,直接拼 children 字符串不可靠;
// react-markdown 传入的 hast node 是稳定的文本来源,递归收集其 value 子节点即原文。
type HastNode = { value?: string; children?: HastNode[] };
export function nodeText(node: unknown): string {
  const n = node as HastNode | undefined;
  if (!n) return "";
  if (typeof n.value === "string") return n.value;
  if (Array.isArray(n.children)) return n.children.map(nodeText).join("");
  return "";
}

export interface CopyButtonProps {
  text: string;
  // 复用为「复制整条回复」等场景时换一套定位样式 / 文案;默认保持代码块复制按钮的现状。
  className?: string;
  label?: string;
  copiedLabel?: string;
}

// 复制按钮:hover 浮现(由 className 对应的 CSS 控制),点击把原文写入剪贴板并短暂反馈 1.5s。
// navigator.clipboard 在浏览器与 Electron renderer(安全上下文)均可用;不可用时静默忽略。
export function CopyButton({
  text,
  className = "pw-md-copy",
  label = "复制代码",
  copiedLabel = "已复制",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className={className}
      data-copied={copied ? "true" : undefined}
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      onClick={() => {
        if (!navigator.clipboard?.writeText) return;
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {copied ? <Icon.Check size={13} /> : <Icon.Copy size={13} />}
    </button>
  );
}
