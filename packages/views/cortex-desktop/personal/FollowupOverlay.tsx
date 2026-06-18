// 历史消息「追问」浮层（U4）。以某条 assistant 回复正文为种子,在应用内浮层里
// 经临时流式通道连续多轮追问。关闭即弃:turns 全持于 useFollowupAsk 的本地 state,
// **不**进 React Query 缓存 / run 注册表 / 磁盘(R5)。
//
// 三段式固定布局:
//  - 顶部:种子正文(只读、超长可展开/收起)。
//  - 中部:turns 区(独立滚动;流式自动吸底,用户上滑时暂停)。
//  - 底部:多行 textarea + 发送/停止。
//
// 渲染说明(R5 如何守住):中部**不复用** ChatArea 的 MessageStream —— 它接收的是
// 主会话 Conversation 形状且自带一套滚动语义,直喂 turns 既别扭也易把本地态拖进主
// 会话渲染管线。这里改用本地轻量渲染(renderRich + AgentLog 风格折叠块),turns 始终
// 只活在 useFollowupAsk 的本地 state,绝不进缓存/注册表。
//
// codex 占位(KTD6):codex 的文本整段一次到达(非逐字),故 streaming 轮在 messages 尚空时
// 显示「生成中…」占位而非逐字光标;claude/pi 逐字到达,显示光标。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "@cortex-work/ui/icons";
import { useFollowupAsk } from "@cortex-work/core";
import type { FollowupSeed, FollowupSessionCtx, Turn } from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";
import { renderRich } from "../rich";

export interface FollowupOverlayProps {
  seed: FollowupSeed;
  sessionCtx: FollowupSessionCtx;
  onClose: () => void;
}

// 种子正文超过此长度时默认折叠,给「展开/收起」。
const SEED_COLLAPSE_THRESHOLD = 240;

// 浮层内可聚焦元素选择器(焦点陷阱用)。
const FOCUSABLE =
  'button:not([disabled]),textarea:not([disabled]),input:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';

// 取一条折叠后 text 块的纯文本(判断是否「尚无内容」用)。
function textOf(m: Message): string {
  if (m.kind !== "text") return "";
  const t = m.text;
  return typeof t === "string" ? t : t.parts.map((p) => p.v).join("");
}

// 单条折叠块渲染:text → Markdown 正文;agentLog → 折叠工具日志块。其余忽略。
function TurnMessage({ m }: { m: Message }) {
  if (m.kind === "text") {
    const t = m.text;
    if (typeof t === "string") {
      return (
        <div className="pw-fu-md md-body">
          <Markdown remarkPlugins={[remarkGfm]}>{t}</Markdown>
        </div>
      );
    }
    return <div className="pw-fu-md">{renderRich(t)}</div>;
  }
  if (m.kind === "agentLog") {
    return (
      <div className="pw-fu-log">
        <div className="pw-fu-log-h">
          {m.active ? <span className="spinner" /> : <Icon.CheckCircle size={13} />}
          <span>{m.title}</span>
          <span className="pw-fu-log-meta">· {m.active ? "运行中" : "已完成"}</span>
        </div>
        {m.items.length > 0 ? (
          <ul className="pw-fu-log-items">
            {m.items.map((it, i) => (
              <li key={i}>{renderRich(it.text)}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  return null;
}

// 单轮渲染:用户问题(me 风格) + 该轮折叠输出 + 状态尾标(光标/生成中/错误+重试/已取消)。
function TurnView({
  turn,
  running,
  isCodex,
  onRetry,
}: {
  turn: Turn;
  running: boolean;
  isCodex: boolean;
  // 重试:传被重试轮的 id,hook 据此原位替换该 error 轮而非追加(FIX-6)。
  onRetry: (question: string, retryOf: string) => void;
}) {
  const hasContent = turn.messages.some((m) => textOf(m).length > 0 || m.kind === "agentLog");
  const streaming = turn.status === "streaming";
  return (
    <div className="pw-fu-turn">
      <div className="pw-fu-q">
        <span className="pw-fu-q-who">我</span>
        <div className="pw-fu-q-text">{turn.question}</div>
      </div>
      <div className="pw-fu-a">
        {turn.messages.map((m, i) => (
          <TurnMessage key={m.uid || i} m={m} />
        ))}
        {/* 流式占位:codex 整段到达 → 显「生成中…」;claude/pi 逐字 → 光标。 */}
        {streaming && running && !hasContent ? (
          isCodex ? (
            <div className="pw-fu-pending">
              <span className="spinner" />
              生成中…
            </div>
          ) : (
            <span className="pw-fu-cursor" aria-hidden />
          )
        ) : null}
        {/* claude/pi 已有内容且仍在流式 → 尾随光标。 */}
        {streaming && running && hasContent && !isCodex ? <span className="pw-fu-cursor" aria-hidden /> : null}
        {turn.status === "error" ? (
          <div className="pw-fu-error">
            <span className="pw-fu-error-text">{turn.error || "执行出错"}</span>
            <button type="button" className="btn pw-fu-retry" onClick={() => onRetry(turn.question, turn.id)}>
              <Icon.Retry size={13} />
              重试
            </button>
          </div>
        ) : null}
        {turn.status === "cancelled" ? <div className="pw-fu-cancelled">已取消</div> : null}
      </div>
    </div>
  );
}

export function FollowupOverlay({ seed, sessionCtx, onClose }: FollowupOverlayProps) {
  const { turns, running, ask, cancel } = useFollowupAsk(seed, sessionCtx);
  const isCodex = sessionCtx.agent === "codex";

  const [draft, setDraft] = useState("");
  const [seedExpanded, setSeedExpanded] = useState(false);

  const dlgRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true); // 中部是否贴底(初始视为贴底)

  // 关闭统一路径:先 cancel(清在途子进程,R5/R7)再 onClose。
  const close = () => {
    cancel();
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // 打开时初始焦点落 textarea。
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // ESC 关闭 + Tab 焦点陷阱(照 PiToolConfirmDialog 的 keydown 模式 + focus-trap)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dlgRef.current;
      if (!root) return;
      const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !root.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // textarea 高度自适应(对齐 ChatArea Composer 写法)。
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(140, ta.scrollHeight) + "px";
  }, [draft]);

  // 中部滚动:流式/新轮到达时,仅当用户在底部才贴底(上滑看历史时不打断)。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [turns, running]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32; // 32px 容差
  };

  const submit = () => {
    const q = draft.trim();
    if (!q || running) return;
    atBottomRef.current = true; // 新发问 → 强制贴底看应答
    ask(q);
    setDraft("");
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const seedText = seed.text;
  const seedLong = seedText.length > SEED_COLLAPSE_THRESHOLD;
  const seedShown = seedLong && !seedExpanded ? seedText.slice(0, SEED_COLLAPSE_THRESHOLD) + "…" : seedText;

  return (
    <div className="pw-dlg-overlay" onClick={close}>
      <div
        className="pw-dlg pw-fu-dlg"
        role="dialog"
        aria-modal="true"
        aria-label="追问"
        ref={dlgRef}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="pw-dlg-x" title="关闭" onClick={close}>
          <Icon.X size={15} />
        </button>

        {/* 顶部:种子正文(只读、可折叠)。 */}
        <div className="pw-fu-seed">
          <div className="pw-fu-seed-h">
            <Icon.Reply size={13} />
            <span>就这条回复追问</span>
          </div>
          <div className={`pw-fu-seed-body ${seedLong && !seedExpanded ? "is-clamped" : ""}`}>{seedShown}</div>
          {seedLong ? (
            <button type="button" className="pw-fu-seed-toggle" onClick={() => setSeedExpanded((v) => !v)}>
              {seedExpanded ? "收起" : "展开"}
            </button>
          ) : null}
        </div>

        {/* 中部:turns 流(独立滚动)。 */}
        <div className="pw-fu-turns" ref={scrollRef} onScroll={onScroll}>
          {turns.length === 0 ? (
            <div className="pw-fu-empty">就这条回复继续追问,关闭即丢弃。</div>
          ) : (
            turns.map((t) => (
              <TurnView
                key={t.id}
                turn={t}
                running={running}
                isCodex={isCodex}
                onRetry={(question, retryOf) => {
                  if (running) return;
                  atBottomRef.current = true;
                  ask(question, retryOf); // 原位替换该 error 轮(FIX-6)
                }}
              />
            ))
          )}
        </div>

        {/* 底部:输入 + 发送/停止。 */}
        <div className="pw-fu-foot">
          <textarea
            ref={taRef}
            className="pw-fu-input"
            value={draft}
            placeholder={running ? "应答生成中…" : "继续追问…（Enter 发送，Shift+Enter 换行）"}
            rows={1}
            disabled={running}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          {running ? (
            <button type="button" className="btn pw-fu-stop" onClick={cancel} title="停止生成">
              <Icon.Stop size={14} />
              停止
            </button>
          ) : (
            <button
              type="button"
              className="btn primary pw-fu-send"
              onClick={submit}
              disabled={!draft.trim()}
              title="发送 (Enter)"
            >
              <Icon.Send size={14} />
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
