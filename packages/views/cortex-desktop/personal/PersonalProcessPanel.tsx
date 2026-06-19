// 右侧执行过程区（U4）：中栏右侧占位、可收起可重开的临时执行过程区。读瞬态过程流
// （usePersonalProcess(activeSessionId)）和当前回复状态（typing），按当前会话渲染 agentLog
// 步骤 + reasoning 思考 + agent 状态，随运行流式更新；一轮结束后保留展开，直到用户折叠或下一轮清空。
//
// 关键约定（见计划 KTD3/KTD9）：
//  - 过程区作为 .pw-center-col 里的右侧占位列参与布局，主会话区自然变窄，**不遮挡**消息和输入框。
//    **不**进 rightView、不进 PersonalRightPanel。
//  - 用新建精简 ProcessStep 渲染件，**不**复用团队侧 ChatArea 的私有 AgentLogMessage/ReasoningMessage
//    （守 R12：不触碰 ChatArea 导出面）。
//  - 门控与 rightOpen/rightView 解耦：仅当中栏显示会话区（非 automation/home/timeline/noteEditor/
//    settings）且当前会话有过程或正在回复时渲染。
//  - 运行中/完成后默认展开看步骤；用户可主动收起为可重开入口；下一轮过程流会恢复默认展开。
//  - 可达性：收起入口键盘可聚焦、role=button + aria-expanded；流式步骤容器 aria-live=polite；
//    过程区出现不抢当前焦点（纯渲染，无 autoFocus/无 focus() 调用）。

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalChat, usePersonalProcess, usePersonalStore } from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";
import { renderRich } from "../rich";
import { AGENT_LABEL, useChatViewActive } from "./agentMeta";

// 过程流里是否仍有运行中的步骤（agentLog/reasoning 的 active）。
function isProcessActive(process: Message[]): boolean {
  for (const m of process) {
    if ((m.kind === "agentLog" || m.kind === "reasoning") && m.active === true) return true;
  }
  return false;
}

// 精简过程步骤渲染件（KTD9，不复用 ChatArea 私有件）。只渲染 agentLog（工具步骤列表）与
// reasoning（思考流）两类——过程流里只会有这两类。
function ProcessStep({ m }: { m: Message }) {
  if (m.kind === "agentLog") {
    return (
      <div className="pw-process-step pw-process-log">
        <div className="pw-process-step-h">
          {m.active ? (
            <span className="spinner" />
          ) : (
            <span className="pw-process-check">
              <Icon.CheckCircle size={13} />
            </span>
          )}
          <span className="pw-process-step-title">{m.title}</span>
          <span className="pw-process-step-meta">
            · {m.active ? "运行中" : "已完成"} · {m.items.length} 步
          </span>
        </div>
        <ul className="pw-process-items">
          {m.items.map((it, i) => (
            <li key={i} className={it.ic === "running" ? "is-active" : ""}>
              <span className="ic">
                {it.ic === "check" ? (
                  <Icon.Check size={12} />
                ) : it.ic === "running" ? (
                  <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} />
                ) : it.ic === "pending" ? (
                  <span
                    style={{ width: 6, height: 6, border: "1.5px dashed currentColor", borderRadius: "50%" }}
                  />
                ) : (
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      background: "currentColor",
                      borderRadius: "50%",
                      display: "inline-block",
                    }}
                  />
                )}
              </span>
              <span className="pw-process-item-text">{renderRich(it.text)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (m.kind === "reasoning") {
    return (
      <div className="pw-process-step pw-process-reasoning">
        <div className="pw-process-step-h">
          <Icon.Sparkle size={12} />
          <span className="pw-process-step-title">思考过程</span>
        </div>
        <div className="pw-process-reasoning-body">{renderRich(m.text)}</div>
      </div>
    );
  }
  return null;
}

function StatusStep({ text, active }: { text: string; active: boolean }) {
  return (
    <div className="pw-process-step pw-process-status">
      <div className="pw-process-step-h">
        {active ? (
          <span className="spinner" />
        ) : (
          <span className="pw-process-check">
            <Icon.CheckCircle size={13} />
          </span>
        )}
        <span className="pw-process-step-title">回复状态</span>
        <span className="pw-process-step-meta">· {active ? "运行中" : "已完成"}</span>
      </div>
      <div className="pw-process-status-body">{renderRich(text)}</div>
    </div>
  );
}

export function PersonalProcessPanel() {
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const activeSession = usePersonalStore((s) => s.sessions.find((x) => x.id === s.activeSessionId));
  const runId = usePersonalStore((s) => (s.activeSessionId ? s.runningBySession[s.activeSessionId] : undefined));
  const chatViewActive = useChatViewActive();
  const { allMessages } = usePersonalChat(activeSessionId);
  // 过程流按 activeSessionId 隔离：只取当前会话的过程（后台会话过程不在当前屏显示，R7）。
  const process = usePersonalProcess(activeSessionId);
  const statusText = useMemo(() => {
    const typing = [...allMessages].reverse().find((m) => m.kind === "typing");
    if (typing?.kind === "typing" && typing.text.trim()) return typing.text;
    if (!runId) return null;
    const name = activeSession?.agent ? (AGENT_LABEL[activeSession.agent] ?? activeSession.agent) : "Agent";
    return `${name} 正在响应...`;
  }, [activeSession?.agent, allMessages, runId]);
  const active = useMemo(() => isProcessActive(process) || !!runId, [process, runId]);
  const processResetKey = `${activeSessionId ?? ""}:${runId ?? ""}:${process[0]?.uid ?? ""}`;

  // 展开/收起：每轮新过程默认展开；用户手动折叠/展开覆盖默认，同一轮流式增量和完成态不重置。
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  useEffect(() => {
    setUserOpen(null);
  }, [processResetKey]);
  const expanded = userOpen ?? true;

  // 门控：中栏非会话区 / 当前会话既无过程也无回复状态 → 不渲染。
  if (!chatViewActive || (process.length === 0 && !statusText)) return null;

  // 头部即折叠开关：点击 / Enter / Space 切换 body 显隐（设计稿 togglePanel）。头部常驻,
  // body 仅展开时渲染。收起时整卡只剩头部一行（可重开入口）。
  const toggle = () => setUserOpen((v) => !(v ?? true));

  return (
    <div className={`pw-process ${expanded ? "is-expanded" : "is-collapsed"}`} data-active={active}>
      <div
        className="pw-process-head"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={expanded ? "收起执行过程" : "展开执行过程"}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className="pw-process-head-title">执行过程</span>
        <span className={`pw-process-badge ${active ? "is-active" : "is-done"}`}>
          {active ? "运行中" : "已完成"}
        </span>
        <span className={`pw-process-chev ${expanded ? "is-open" : ""}`} aria-hidden="true">
          <Icon.Chevron size={14} />
        </span>
      </div>
      {/* 流式步骤容器：aria-live=polite 让辅助技术可感知增量步骤（R9）。 */}
      {expanded ? (
        <div className="pw-process-body" aria-live="polite">
          {statusText ? <StatusStep text={statusText} active={!!runId} /> : null}
          {process.map((m, i) => (
            <ProcessStep key={m.uid ?? i} m={m} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
