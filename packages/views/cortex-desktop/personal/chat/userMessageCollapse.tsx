import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import { Icon } from "@cortex-work/ui/icons";

// 用户消息的正文、附件和图片共享同一个高度预算。该值约等于 10 行个人会话正文，既能保留
// 问题上下文，又不会让一次粘贴或多图输入占满整个阅读区；是否超限以真实 DOM 高度为准。
const USER_MESSAGE_COLLAPSED_HEIGHT = 260;

/**
 * 对过高的用户消息统一折叠，覆盖文字、引用、附件、图片和文件。
 *
 * 不能按字符数判断：同样长度在不同窗口宽度下行数不同，图片加载后也会改变总高度。因此先按
 * DOM 的 scrollHeight 判定，并监听内容区及其顶层内容尺寸；短消息不渲染任何额外控制。
 */
export function UserMessageContent({ children }: { children: ReactNode }) {
  const { t } = useTranslation("chat");
  const contentRef = useRef<HTMLDivElement>(null);
  const [collapsible, setCollapsible] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const measure = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    const next = content.scrollHeight > USER_MESSAGE_COLLAPSED_HEIGHT + 1;
    setCollapsible(next);
    if (!next) setExpanded(false);
  }, []);

  // 每次消息内容提交后立即测量，避免先完整展开一帧再折叠造成跳动。
  useLayoutEffect(measure);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resizeObserver?.observe(content);
    Array.from(content.children).forEach((child) => resizeObserver?.observe(child));

    return () => {
      resizeObserver?.disconnect();
    };
  }, [measure]);

  return (
    <div className={`pw-user-message-shell ${collapsible ? (expanded ? "is-expanded" : "is-collapsed") : ""}`}>
      <div ref={contentRef} className="pw-user-message-content">
        {children}
      </div>
      {collapsible ? (
        <button
          type="button"
          className="pw-user-message-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("userMessage.collapse") : t("userMessage.expand")}
          <Icon.Chevron size={11} className={expanded ? "is-open" : ""} />
        </button>
      ) : null}
    </div>
  );
}
