// 一键复制按钮:写剪贴板 + 1.5s「已复制」反馈。navigator.clipboard 在 Electron renderer
// 安全上下文可用,不可用时静默忽略(逻辑同 MarkdownView 的代码块复制)。
// 自动化详情多处复用(hero 卡片、提示词折叠、整页运行详情),抽为共享组件避免重复。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";

export function CopyButton({
  text,
  className = "pw-icon-btn",
  size = 15,
  title = "复制",
}: {
  text: string;
  className?: string;
  size?: number;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      className={className}
      title={copied ? "已复制" : title}
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
      {copied ? <Icon.Check size={size} /> : <Icon.Copy size={size} />}
    </button>
  );
}
