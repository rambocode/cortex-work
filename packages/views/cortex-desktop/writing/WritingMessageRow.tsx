// 写作助手时间线单条消息渲染(对齐 Kun MessageTimeline 的紧凑卡风格):
//   user      — 右对齐气泡(displayText 优先,剥掉上下文噪音);
//   assistant — Markdown 正文,流式中尾随打字光标;
//   thinking  — 可折叠推理块(流式中显「思考中…」,落定显「已思考」;默认收起,点击展开原文);
//   tool      — 紧凑卡一行(终端图标 + 工具名 + 运行态);
//   system    — 错误条。
import { useState, type ReactElement } from "react";
import { ChevronRight } from "lucide-react";
import type { WritingMessage } from "@cortex-work/core/writing/run/writing-run-manager";
import { Icon } from "@cortex-work/ui/icons";
import { MarkdownView } from "../personal/markdown/MarkdownView";

export function WritingMessageRow({ message }: { message: WritingMessage }): ReactElement {
  if (message.role === "user") {
    return (
      <div className="pw-wa-msg is-user">
        <div className="pw-wa-msg-body">{message.displayText ?? message.text}</div>
      </div>
    );
  }
  if (message.role === "assistant") {
    return (
      <div className="pw-wa-msg is-assistant">
        <div className="pw-wa-msg-body pw-note-md">
          <MarkdownView content={message.text} />
          {/* 流式中在正文尾部渲染打字光标(CSS 闪烁);落定(streaming=false)即移除。 */}
          {message.streaming ? <span className="pw-wa-cursor" aria-hidden="true" /> : null}
        </div>
      </div>
    );
  }
  if (message.role === "thinking") {
    return <ThinkingRow message={message} />;
  }
  if (message.role === "tool") {
    return (
      <div className="pw-wa-msg is-tool" data-status={message.status}>
        <Icon.Terminal size={12} />
        <span className="pw-wa-tool-name">{message.name}</span>
        {message.status === "running" ? <span className="pw-wa-tool-dot">运行中</span> : null}
      </div>
    );
  }
  // system(错误)
  return (
    <div className="pw-wa-msg is-system" data-severity={message.severity}>
      {message.text}
    </div>
  );
}

// thinking 折叠块:默认收起只显状态行,点击展开推理原文(纯文本 pre-wrap,推理流不是 Markdown 语义)。
function ThinkingRow({
  message,
}: {
  message: Extract<WritingMessage, { role: "thinking" }>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="pw-wa-msg is-thinking" data-streaming={message.streaming ? "1" : undefined}>
      <button
        type="button"
        className="pw-wa-think-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`pw-wa-think-chev${open ? " is-open" : ""}`}>
          <ChevronRight size={12} strokeWidth={2} />
        </span>
        <span className="pw-wa-think-label">{message.streaming ? "思考中…" : "已思考"}</span>
      </button>
      {open ? <div className="pw-wa-think-body">{message.text}</div> : null}
    </div>
  );
}
