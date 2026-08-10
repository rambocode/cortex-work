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
import { cleanToolName, usePersonalRunEvents, usePersonalStore, type RunEvent } from "@cortex-work/core";
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
  if (ev.type === "text") {
    const text = ev.delta.replace(/\s+/g, " ").trim();
    return text ? { kind: "text", text } : null;
  }
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

// 与 Kun 的 peek 交互一致：锚定卡片按钮、点外或 Esc 关闭、在空间不足时向上展开。这里只展示
// 当前 callId 的实时摘要；完整输入输出仍交给“查看过程”弹层，避免在预览里泄漏超长工具载荷。
function SubagentPreviewPopover({
  open,
  anchor,
  title,
  status,
  elapsed,
  events,
  summary,
  onClose,
  onOpenProcess,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  title: string;
  status: string;
  elapsed: string;
  events: RunEvent[];
  summary?: string;
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
        {steps.length > 0 ? (
          steps.map((step, index) => (
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
          ))
        ) : (
          <div className="pw-subagent-peek-empty">{t("subagentCard.waiting")}</div>
        )}
        {summary ? (
          <div className="pw-subagent-peek-summary">
            <strong>{t("subagentCard.currentConclusion")}</strong>
            <span>{summary}</span>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

// Kun 对齐的子代理任务卡：结论展开、实时预览、完整过程是三个独立交互。预览与结论互斥，
// “查看过程”按 callId 打开独立详情，不能退回混合全会话事件的通用入口。
export const SubagentCardMessage = memo(function SubagentCardMessage({
  m,
  onOpenProcess,
  sessionId,
}: {
  m: Extract<Message, { kind: "subagentCard" }>;
  onOpenProcess?: (subagent?: { callId: string; label: string }) => void;
  sessionId?: string;
}) {
  const { t } = useTranslation("chat");
  const setActiveSession = usePersonalStore((state) => state.setActiveSession);
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
  const openProcess = () => {
    if (!m.callId || !onOpenProcess) return;
    setPeekOpen(false);
    onOpenProcess({ callId: m.callId, label: m.roleLabel });
  };

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
              <em>{t("subagentCard.agent")}</em>
              <strong>{m.roleLabel}</strong>
              <b>{statusLabel}</b>
            </span>
            <span className="pw-subagent-card-meta">{m.roleId}</span>
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
        {m.callId && onOpenProcess ? (
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
            <button type="button" className="pw-subagent-card-process" onClick={openProcess}>
              {t("subagentCard.viewProcess")}
              <Icon.ChevronRight size={11} />
            </button>
            {m.childSessionId && m.status !== "running" ? (
              <button
                type="button"
                className="pw-subagent-card-process is-primary"
                onClick={() => setActiveSession(m.childSessionId!)}
              >
                {t("subagentCard.openSession")}
                <Icon.ChevronRight size={11} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="pw-subagent-card-line" />
      {expanded && !peekOpen ? (
        <div className="pw-subagent-card-result">
          {m.error ? <div className="is-error">{m.error}</div> : <div>{m.summary}</div>}
        </div>
      ) : null}
      <SubagentPreviewPopover
        open={peekOpen}
        anchor={previewButtonRef.current}
        title={m.roleLabel}
        status={statusLabel}
        elapsed={elapsed}
        events={events}
        summary={m.summary}
        onClose={() => setPeekOpen(false)}
        onOpenProcess={openProcess}
      />
    </section>
  );
});
