// 右侧执行过程区（U4）：中栏右侧占位、默认收起为一个圆形 icon、点击向下展开的临时执行过程区。读瞬态
// 过程流（usePersonalProcess(activeSessionId)）和当前回复状态（typing），按当前会话渲染 agentLog
// 步骤 + reasoning 思考 + agent 状态，随运行流式更新；默认始终收起为 icon，点击展开看步骤。
//
// 关键约定（见计划 KTD3/KTD9）：
//  - 过程区作为 .pw-center-col 里的右侧占位列参与布局，主会话区自然变窄，**不遮挡**消息和输入框。
//    **不**进 rightView、不进 PersonalRightPanel。
//  - 用新建精简 ProcessStep 渲染件，**不**复用团队侧 ChatArea 的私有 AgentLogMessage/ReasoningMessage
//    （守 R12：不触碰 ChatArea 导出面）。
//  - 门控与 rightOpen/rightView 解耦：仅当中栏显示会话区（非 automation/home/timeline/noteEditor/
//    settings）且当前会话有过程或正在回复时渲染。
//  - 默认收起（expanded = userOpen ?? false）：运行中也收起为圆形 icon，不自动撑开整块面板抢焦；
//    icon 随状态变化（运行中转圈 ↔ 完成绿勾）即为「执行感知」。点击 icon 向下展开看步骤，展开态点
//    头部收起。用户手动开合（userOpen）同一轮（processResetKey 不变）保持，下一轮过程流恢复默认收起。
//  - 可达性：收起入口键盘可聚焦、role=button + aria-expanded；流式步骤容器 aria-live=polite；
//    过程区出现不抢当前焦点（纯渲染，无 autoFocus/无 focus() 调用）。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  // 扩展命令(/cmd)轮:pi 即时执行、无过程步骤,命令输出走消息流。无内容时不渲染本面板,
  // 避免空态「运行中」一闪而过。
  const isExtensionCommand = usePersonalStore((s) =>
    s.activeSessionId ? !!s.piRuntimeBySession[s.activeSessionId]?.extensionCommand : false,
  );
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
  // 每轮(runId)重置展开偏好;**不**含 process[0].uid —— 否则本轮第一个过程项(如 reasoning)出现时
  // key 变化会把用户刚展开的面板重置回收起(表现为「关闭一次」闪烁,codex 发 reasoning 时尤为明显)。
  const processResetKey = `${activeSessionId ?? ""}:${runId ?? ""}`;

  // 展开/收起：每轮新过程默认收起；用户手动展开/折叠覆盖默认，同一轮流式增量和完成态不重置。
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  useEffect(() => {
    setUserOpen(null);
  }, [processResetKey]);
  // 默认收起为圆形 icon（运行中也收起，不自动撑开整块面板，避免抢焦）：userOpen 为用户手动覆盖，
  // 同一轮内（processResetKey 不变）保持；下一轮 runId/首步变化时 useEffect 重置回默认收起。
  // 运行/完成的 icon 变化（转圈↔绿勾）即为用户的「执行感知」，点开才向下展开看步骤。
  const expanded = userOpen ?? false;

  // 粘底自动滚动:流式步骤/思考增长时跟随到最新位置;但用户上滚阅读历史时不打扰(stick=false)。
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    // 距底 < 48px 视作「在底部」→ 继续跟随;否则用户在上方阅读 → 暂停跟随。
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  // 新一轮(processResetKey 变化)重置为跟随;展开瞬间也回到底部。
  useEffect(() => {
    stick.current = true;
  }, [processResetKey]);
  // 内容增量后(同步布局阶段)若处于跟随态则滚到底;依赖 process/statusText 的变化逐帧触发。
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  // 门控：中栏非会话区 / 当前会话既无过程也无回复状态 → 不渲染。
  // 扩展命令轮且无过程步骤 → 不渲染（命令输出在消息流,过程面板无内容,避免空态闪现）。
  if (!chatViewActive || (process.length === 0 && !statusText)) return null;
  if (isExtensionCommand && process.length === 0) return null;

  // 开关：收起态点 icon 展开、展开态点头部收起。默认收起（userOpen 为 null 时视作 false），
  // 故首次点击从收起翻到展开。
  const toggle = () => setUserOpen((v) => !(v ?? false));

  // 收起态（默认）：整卡塌成一个圆形 icon 按钮（点击向下展开入口），grid 第二列随之塌窄、会话区变宽。
  // 原生 <button> → 键盘/读屏可达；图标随状态变化即为「执行感知」：运行中转圈、完成显示绿色对勾。
  if (!expanded) {
    return (
      <button
        type="button"
        className="pw-process is-collapsed"
        data-active={active}
        aria-expanded={false}
        aria-label="展开执行过程"
        title={active ? "执行中，点击展开" : "执行过程已完成，点击展开"}
        onClick={toggle}
      >
        <span className="pw-process-fab-ic" aria-hidden="true">
          {active ? <span className="spinner" /> : <Icon.CheckCircle size={18} />}
        </span>
      </button>
    );
  }

  // 展开态：完整卡片（此处 expanded 必为 true，收起态已在上方提前 return）。头部点击/Enter/Space
  // 收起为 icon。
  return (
    <div className="pw-process is-expanded" data-active={active}>
      <div
        className="pw-process-head"
        role="button"
        tabIndex={0}
        aria-expanded={true}
        aria-label="收起执行过程"
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
        <span className="pw-process-chev is-open" aria-hidden="true">
          <Icon.Chevron size={14} />
        </span>
      </div>
      {/* 流式步骤容器：aria-live=polite 让辅助技术可感知增量步骤（R9）。ref+onScroll 实现粘底自动滚动。 */}
      <div className="pw-process-body" aria-live="polite" ref={bodyRef} onScroll={onBodyScroll}>
        {statusText ? <StatusStep text={statusText} active={!!runId} /> : null}
        {process.map((m, i) => (
          <ProcessStep key={m.uid ?? i} m={m} />
        ))}
      </div>
    </div>
  );
}
