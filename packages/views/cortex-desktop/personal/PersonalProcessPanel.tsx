// 右侧执行过程区（U4）：浮起、可收起可重开的临时执行过程区。读瞬态过程流
// （usePersonalProcess(activeSessionId)），按当前会话渲染 agentLog 步骤 + reasoning 思考，
// 随运行流式更新；一轮结束后收起为可重开入口（数据由 U2 保留至切走/下一轮）。
//
// 关键约定（见计划 KTD3/KTD9）：
//  - 浮层 position:absolute 脱离 .pw-center-col 的 flex:1 规则，锚到 .pw-center-col 的 relative；
//    **不**进 rightView、不进 PersonalRightPanel、不参与 .pw-upper/.pw-center-col 的 flex。
//  - 用新建精简 ProcessStep 渲染件，**不**复用团队侧 ChatArea 的私有 AgentLogMessage/ReasoningMessage
//    （守 R12：不触碰 ChatArea 导出面）。
//  - 门控与 rightOpen/rightView 解耦：仅当中栏显示会话区（非 automation/home/timeline/noteEditor/
//    settings）且当前会话有过程时渲染。
//  - 窄窗退化以「中栏实际可用宽度」（ResizeObserver 量 .pw-center-col，含右栏 is-fileopen/is-detail
//    展宽影响）为准：窄于阈值改底部贴附/单行摘要，不覆盖正文与输入框。
//  - 可达性：收起入口键盘可聚焦、role=button + aria-expanded；流式步骤容器 aria-live=polite；
//    浮层出现不抢当前焦点（纯渲染，无 autoFocus/无 focus() 调用）。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalProcess, usePersonalStore } from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";
import { renderRich } from "../rich";

// 中栏可用宽度低于此阈值时浮层退化为底部贴附/单行摘要，不覆盖正文与输入框。
const NARROW_THRESHOLD = 480;

// 过程流里是否仍有运行中的步骤（agentLog/reasoning 的 active）。运行中 → 默认展开、不收起；
// 全部完成 → 默认收起为可重开入口（结束后收起，数据保留可重开）。
function isProcessActive(process: Message[]): boolean {
  for (const m of process) {
    if ((m.kind === "agentLog" || m.kind === "reasoning") && m.active === true) return true;
  }
  return false;
}

// 过程流摘要：总步数（所有 agentLog 卡片 items 之和）+ 最近一步文本。供收起入口与窄窗单行摘要显示。
function summarize(process: Message[]): { steps: number; lastStep: string | null } {
  let steps = 0;
  let lastStep: string | null = null;
  for (const m of process) {
    if (m.kind !== "agentLog") continue;
    for (const it of m.items) {
      steps += 1;
      if (typeof it.text === "string") lastStep = it.text;
    }
  }
  return { steps, lastStep };
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

// 中栏是否正显示会话区（非 automation/home/timeline/noteEditor/settings）。与现有挂载门控
//（PersonalWorkspace 的视图优先级）对齐：渲染优先级 automation > noteEditor > home > timeline > 会话区。
function useChatViewActive(): boolean {
  const homeOpen = usePersonalStore((s) => s.homeOpen);
  const automationOpen = usePersonalStore((s) => s.automationOpen);
  const settingsOpen = usePersonalStore((s) => s.settingsOpen);
  const noteEditorId = usePersonalStore((s) => s.noteEditorId);
  const timelineProjectId = usePersonalStore((s) => s.timelineProjectId);
  return !homeOpen && !automationOpen && !settingsOpen && !noteEditorId && !timelineProjectId;
}

export function PersonalProcessPanel() {
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const chatViewActive = useChatViewActive();
  // 过程流按 activeSessionId 隔离：只取当前会话的过程（后台会话过程不在当前屏显示，R7）。
  const process = usePersonalProcess(activeSessionId);
  const active = useMemo(() => isProcessActive(process), [process]);
  const summary = useMemo(() => summarize(process), [process]);

  // 展开/收起：由过程流 active/completed 驱动——运行中默认展开且不可收起；完成后默认收起为
  // 可重开入口。用户手动展开/收起覆盖默认（userOpen），active 翻转时清掉回到默认（结束即收起）。
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  useEffect(() => {
    setUserOpen(null);
  }, [active, activeSessionId]);
  const expanded = active ? true : (userOpen ?? false);

  // 窄窗退化：量「中栏实际可用宽度」（含右栏 is-fileopen/is-detail 展宽影响后的 .pw-center-col
  // 计算宽度），窄于阈值改底部贴附/单行摘要、不覆盖正文与输入框。
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = wrapRef.current?.parentElement; // .pw-center-col（浮层的定位锚点 / 实际可用宽度容器）
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth < NARROW_THRESHOLD);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // 门控：中栏非会话区 / 当前会话无过程 → 不渲染（空集 return null）。与 rightOpen/rightView 解耦。
  if (!chatViewActive || process.length === 0) return null;

  // 收起入口：紧凑、可重开。窄窗下也用此单行摘要形态（不展开覆盖正文）。
  const collapsed = !expanded || narrow;

  if (collapsed) {
    const label = summary.steps > 0
      ? `执行过程 · ${summary.steps} 步${summary.lastStep ? ` · ${summary.lastStep}` : ""}`
      : "执行过程";
    return (
      <div
        ref={wrapRef}
        className={`pw-process is-collapsed${narrow ? " is-narrow" : ""}`}
        data-active={active}
      >
        <div
          className="pw-process-entry"
          role="button"
          tabIndex={0}
          aria-expanded={false}
          aria-label="展开执行过程"
          onClick={() => setUserOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setUserOpen(true);
            }
          }}
        >
          {active ? <span className="spinner" /> : <Icon.CheckCircle size={13} />}
          <span className="pw-process-entry-label">{label}</span>
          <span className="pw-process-entry-chev" aria-hidden="true">
            <Icon.Chevron size={11} />
          </span>
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="pw-process is-expanded" data-active={active}>
      <div className="pw-process-head">
        <span className="pw-process-head-title">执行过程</span>
        <span className="pw-process-head-meta">{active ? "运行中" : "已完成"}</span>
        {/* 完成态可收起为可重开入口；运行中不提供收起（active 时默认展开、不可收起）。 */}
        {active ? null : (
          <button
            type="button"
            className="pw-process-collapse"
            aria-label="收起执行过程"
            onClick={() => setUserOpen(false)}
          >
            <Icon.Chevron size={12} />
          </button>
        )}
      </div>
      {/* 流式步骤容器：aria-live=polite 让辅助技术可感知增量步骤（R9）。 */}
      <div className="pw-process-body" aria-live="polite">
        {process.map((m, i) => (
          <ProcessStep key={m.uid ?? i} m={m} />
        ))}
      </div>
    </div>
  );
}
