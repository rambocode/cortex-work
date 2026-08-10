import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cleanToolName, usePersonalChat, usePersonalRunEvents, usePersonalStore, type RunEvent } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import type { Message } from "@cortex-work/core/types";
import { Icon } from "@cortex-work/ui/icons";

type PreviewStep = {
  kind: "thinking" | "tool" | "text" | "retry" | "result";
  text: string;
};
type PreviewLabels = {
  thinking: string;
  tool: (name: string, detail: string | undefined, phase: "start" | "done" | "failed") => string;
  retry: (attempt: number) => string;
  resultDone: string;
  resultFailed: (error: string) => string;
};

function previewLabel(event: RunEvent, labels: PreviewLabels): PreviewStep | null {
  const { ev } = event;
  if (ev.type === "thinking") {
    const text = ev.delta.replace(/\s+/g, " ").trim();
    return { kind: "thinking", text: text || labels.thinking };
  }
  // 子 Agent 正文由其独立会话持久化，预览区从该会话读取完整输出；事件列表只保留过程步骤，
  // 避免把流式 text delta 截断成多个重复片段。
  if (ev.type === "text") return null;
  if (ev.type === "tool") {
    const name = cleanToolName(ev.name) || ev.name;
    const detail = ev.detail?.replace(/\s+/g, " ").trim();
    const phase = ev.phase !== "end" ? "start" : ev.isError ? "failed" : "done";
    return { kind: "tool", text: labels.tool(name, detail, phase) };
  }
  if (ev.type === "retry") {
    return { kind: "retry", text: ev.reason || labels.retry(ev.attempt) };
  }
  if (ev.type === "result") {
    return {
      kind: "result",
      text: ev.ok ? labels.resultDone : labels.resultFailed(ev.error ?? ""),
    };
  }
  return null;
}

// 与 Kun 的 peek 交互一致：锚定卡片按钮、点外或 Esc 关闭、在空间不足时向上展开。正文以
// 子会话实际输出为唯一真源，过程步骤仅作次要补充，避免父卡摘要与子 Agent 输出不一致。
function SubagentPreviewPopover({
  open,
  anchor,
  title,
  status,
  elapsed,
  events,
  output,
  onClose,
  onOpenProcess,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  title: string;
  status: string;
  elapsed: string;
  events: RunEvent[];
  output?: string;
  onClose: () => void;
  onOpenProcess: () => void;
}) {
  const { t } = useTranslation("chat");
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", left: -9999, top: -9999 });
  const labels = useMemo<PreviewLabels>(() => ({
    thinking: t("subagentCard.thinking"),
    tool: (name, detail, phase) => {
      if (phase === "start") {
        return detail
          ? t("subagentCard.toolStart", { name, detail })
          : t("subagentCard.toolStartNoDetail", { name });
      }
      if (phase === "failed") {
        return detail
          ? t("subagentCard.toolFailed", { name, detail })
          : t("subagentCard.toolFailedNoDetail", { name });
      }
      return detail
        ? t("subagentCard.toolDone", { name, detail })
        : t("subagentCard.toolDoneNoDetail", { name });
    },
    retry: (attempt) => t("subagentCard.retry", { attempt }),
    resultDone: t("subagentCard.resultDone"),
    resultFailed: (error) => t("subagentCard.resultFailed", { error: error || t("core.unknownError") }),
  }), [t]);
  const steps = useMemo(
    () => events.map((event) => previewLabel(event, labels)).filter((item): item is PreviewStep => !!item).slice(-6),
    [events, labels],
  );

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(420, Math.max(300, window.innerWidth - 24));
      const height = popoverRef.current?.offsetHeight ?? 280;
      const below = window.innerHeight - rect.bottom >= Math.min(height, 360) + 10;
      setStyle({
        position: "fixed",
        width,
        maxHeight: Math.min(360, window.innerHeight - 24),
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        top: below ? rect.bottom + 8 : Math.max(12, rect.top - height - 8),
        zIndex: 90,
      });
    };
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, steps.length]);

  useEffect(() => {
    if (!open) return;
    const pointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || anchor?.contains(target) || popoverRef.current?.contains(target)) return;
      onClose();
    };
    const keyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", pointerDown);
    window.addEventListener("keydown", keyDown);
    return () => {
      window.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("keydown", keyDown);
    };
  }, [open, anchor, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={popoverRef}
      className="pw-subagent-peek"
      role="dialog"
      aria-label={t("subagentCard.previewAria", { title })}
      style={style}
    >
      <div className="pw-subagent-peek-head">
        <span>
          <strong>{title}</strong>
          <small>{status} · {elapsed}</small>
        </span>
        <button type="button" onClick={onOpenProcess} title={t("subagentCard.viewFullProcess")}>
          <Icon.ChevronRight size={13} />
        </button>
        <button type="button" onClick={onClose} title={t("subagentCard.closePreview")}>
          <Icon.X size={13} />
        </button>
      </div>
      <div className="pw-subagent-peek-body">
        <div className="pw-subagent-peek-output">
          <strong>{t("subagentCard.agentOutput")}</strong>
          {output ? <span>{output}</span> : <em>{t("subagentCard.waitingOutput")}</em>}
        </div>
        {steps.length > 0 ? (
          <div className="pw-subagent-peek-steps">{steps.map((step, index) => (
            <div className="pw-subagent-peek-step" data-kind={step.kind} key={`${step.kind}-${index}`}>
              <i>
                {step.kind === "tool" ? (
                  <Icon.Terminal size={12} />
                ) : step.kind === "result" ? (
                  <Icon.CheckCircle size={12} />
                ) : (
                  <Icon.Sparkle size={12} />
                )}
              </i>
              <span>{step.text}</span>
            </div>
          ))}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

// Kun 对齐的子代理任务卡：预览直接读取子会话输出，“查看过程”进入只读子会话；卡片不再保留
// 另一个“进入子会话”入口，确保同一行为只有一个清晰入口。
export const SubagentCardMessage = memo(function SubagentCardMessage({
  m,
  sessionId,
}: {
  m: Extract<Message, { kind: "subagentCard" }>;
  sessionId?: string;
}) {
  const { t } = useTranslation("chat");
  const setActiveSession = usePersonalStore((state) => state.setActiveSession);
  const childSession = usePersonalStore((state) =>
    m.childSessionId ? state.sessions.find((candidate) => candidate.id === m.childSessionId) : undefined,
  );
  const childChat = usePersonalChat(m.childSessionId);
  const [expanded, setExpanded] = useState(false);
  const [peekOpen, setPeekOpen] = useState(false);
  const previewButtonRef = useRef<HTMLButtonElement>(null);
  const allEvents = usePersonalRunEvents(sessionId);
  const events = useMemo(
    () => (m.callId ? allEvents.filter(({ ev }) => ev.subagentCallId === m.callId) : []),
    [allEvents, m.callId],
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (m.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [m.status]);
  const elapsedMs = Math.max(0, (m.finishedAt ?? now) - m.startedAt);
  const elapsed =
    elapsedMs >= 60_000
      ? `${Math.floor(elapsedMs / 60_000)}:${String(Math.floor((elapsedMs % 60_000) / 1_000)).padStart(2, "0")}`
      : `0:${String(Math.floor(elapsedMs / 1_000)).padStart(2, "0")}`;
  const statusLabel = m.status === "running"
    ? t("subagentCard.running")
    : m.status === "completed"
      ? t("subagentCard.completed")
      : t("subagentCard.failed");
  const hasConclusion = !!(m.summary?.trim() || m.error?.trim());
  const childOutput = useMemo(() => {
    for (let index = childChat.allMessages.length - 1; index >= 0; index -= 1) {
      const message = childChat.allMessages[index];
      if (message?.kind === "text" && message.who !== "me" && typeof message.text === "string") {
        const text = message.text.trim();
        if (text) return text;
      }
    }
    return m.summary?.trim() || m.error?.trim() || undefined;
  }, [childChat.allMessages, m.error, m.summary]);
  const openProcess = () => {
    if (!m.childSessionId) return;
    setPeekOpen(false);
    setActiveSession(m.childSessionId);
  };
  // 内置探索角色在运行协议里仍保留稳定的英文 roleId/roleLabel，展示层统一转成产品中文；
  // 自定义角色继续显示用户配置的名称，避免误译或丢失其业务语义。
  const roleKindLabel = m.roleId === "explore" ? t("subagentCard.explore") : t("subagentCard.agent");
  const agentTypeLabel = m.roleId === "explore" ? t("subagentCard.exploreAgent") : m.roleLabel;
  const agentMeta = `${t("subagentCard.agent")} ${agentTypeLabel}${
    childSession?.model ? ` · ${t("subagentCard.model")} ${childSession.model}` : ""
  }`;

  return (
    <section className={`pw-subagent-card is-${m.status}`}>
      <div className="pw-subagent-card-head">
        <button
          type="button"
          className="pw-subagent-card-main"
          aria-expanded={expanded && !peekOpen}
          onClick={() => {
            setPeekOpen(false);
            if (hasConclusion) setExpanded((value) => !value);
          }}
        >
          <span
            className="pw-subagent-card-avatar"
            style={m.roleColor ? { color: m.roleColor, borderColor: `${m.roleColor}66` } : undefined}
          >
            {m.roleAvatar || <Icon.Bot size={22} />}
            <i>{m.status === "running" ? <span className="spinner" /> : <Icon.Check size={9} />}</i>
          </span>
          <span className="pw-subagent-card-copy">
            <span className="pw-subagent-card-title">
              <em>{roleKindLabel}</em>
              <strong>{m.taskTitle || m.roleLabel}</strong>
              <b>{statusLabel}</b>
            </span>
            <span className="pw-subagent-card-meta">{agentMeta}</span>
            {m.activity ? <span className="pw-subagent-card-activity">{m.activity}</span> : null}
            {hasConclusion && !expanded && !peekOpen ? (
              <span className="pw-subagent-card-expand">{t("subagentCard.expandConclusion")}</span>
            ) : null}
          </span>
          <span className="pw-subagent-card-stats">
            <strong>{elapsed}</strong>
            <span>{t("subagentCard.stepCount", { count: m.steps })}</span>
          </span>
          {hasConclusion ? <Icon.Chevron size={15} className={expanded && !peekOpen ? "is-open" : ""} /> : null}
        </button>
        {m.callId ? (
          <div className="pw-subagent-card-actions">
            <button
              ref={previewButtonRef}
              type="button"
              className={`pw-subagent-card-process ${peekOpen ? "is-active" : ""}`}
              aria-expanded={peekOpen}
              onClick={() => {
                setExpanded(false);
                setPeekOpen((value) => !value);
              }}
            >
              <Icon.Eye size={13} />
              {t("subagentCard.preview")}
            </button>
            {m.childSessionId ? (
              <button type="button" className="pw-subagent-card-process" onClick={openProcess}>
                {t("subagentCard.viewProcess")}
                <Icon.ChevronRight size={11} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="pw-subagent-card-line" />
      {expanded && !peekOpen ? (
        <div className="pw-subagent-card-result">
          {m.error ? (
            <div className="is-error">{m.error}</div>
          ) : (
            // 子 Agent 的结论是可信 Markdown 文本而不是 HTML；react-markdown 默认不执行原始 HTML，
            // remark-gfm 仅补齐表格、任务列表等常用语法，避免把子会话输出退化为纯文本。
            <Markdown remarkPlugins={[remarkGfm]}>{m.summary ?? ""}</Markdown>
          )}
        </div>
      ) : null}
      <SubagentPreviewPopover
        open={peekOpen}
        anchor={previewButtonRef.current}
        title={m.taskTitle || m.roleLabel}
        status={statusLabel}
        elapsed={elapsed}
        events={events}
        output={childOutput}
        onClose={() => setPeekOpen(false)}
        onOpenProcess={openProcess}
      />
    </section>
  );
});
