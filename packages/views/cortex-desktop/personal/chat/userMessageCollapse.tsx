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
    const height = content.scrollHeight;
    // 滞回带:折叠判定与撤销用不同阈值。若用单一阈值,任何让 scrollHeight 随折叠态微变的
    // 布局因素(历史事故:限高下 flex 压缩 overflow 子块)都会让本 layout effect 同步振荡,
    // 触发 React "Maximum update depth exceeded" 白屏。已判定可折叠后,只有内容明显变矮
    // 才撤销;两带不重叠,振荡在状态层被物理隔断(CSS 侧另有 flex-shrink:0 消振源)。
    setCollapsible((prev) =>
      prev ? height > USER_MESSAGE_COLLAPSED_HEIGHT - 40 : height > USER_MESSAGE_COLLAPSED_HEIGHT + 1,
    );
    if (height <= USER_MESSAGE_COLLAPSED_HEIGHT - 40) setExpanded(false);
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
