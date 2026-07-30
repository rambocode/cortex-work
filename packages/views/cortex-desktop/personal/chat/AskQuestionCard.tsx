// askquestion 富卡片（输入框上方）。pi 的 askquestion 工具经 ctx.ui 借道 → handleLine 归一为
// PiUiRequest{method:"askquestion"} → 入 store piUiPending → 本卡片消费「当前活跃会话」队首。
// 多组 → 顶部 tab 切换（单组不显 tab）,每组 ≤3 选项(推荐项高亮)+ 可自定义输入(与选项互斥);
// 整卡必答(tab 上显 ✓ 标已答)后一次提交,答案聚合 JSON 经 {value} 回写;取消/ESC → {cancelled}。
// 会话隔离:仅渲染 uiSessionId===当前会话 的卡。宽度对齐输入框、背景纯白、tab 用主题色。非模态。

import { useEffect, useMemo, useRef, useState } from "react";
import { respondPiUi, serializeAskQuestionAnswers, useDesktopBridge, usePersonalStore } from "@cortex-work/core";

// 每组的本地选择:选项下标 或 自定义文本(互斥,KTD-5)。
type GroupSelection = { optionIndex?: number; custom?: string };

function isAnswered(g: { options: unknown[] }, sel: GroupSelection | undefined): boolean {
  if (!sel) return false;
  const hasCustom = typeof sel.custom === "string" && sel.custom.trim().length > 0;
  const hasOption = sel.optionIndex != null && sel.optionIndex >= 0 && sel.optionIndex < g.options.length;
  return hasCustom || hasOption;
}

export function AskQuestionCard({ sessionId }: { sessionId: string }) {
  const bridge = useDesktopBridge();
  // 仅消费「当前活跃会话」的 askquestion 队首(R6 会话隔离:后台会话的卡不冒到当前 composer 上方)。
  const pending = usePersonalStore((s) =>
    s.piUiPending.find((p) => p.uiSessionId === sessionId && p.request.method === "askquestion"),
  );
  const id = pending?.request.id;
  const envelope = pending && pending.request.method === "askquestion" ? pending.request.envelope : undefined;

  const [selections, setSelections] = useState<Record<string, GroupSelection>>({});
  const [submitting, setSubmitting] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  // 切到新待答卡(id 变)时重置本地状态。
  useEffect(() => {
    setSelections({});
    setSubmitting(false);
    setActiveIdx(0);
  }, [id]);

  // ESC = 取消(cancelled,pi 侧 execute 收到取消并续轮)。依赖 id 重绑,确保关的是当前卡。
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") respondPiUi(bridge, sessionId, id, { cancelled: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, sessionId, bridge]);

  // 键盘快捷操作:数字键 1-9 选当前组选项、Enter 提交(答完时)。焦点在输入框/文本域时不劫持,
  // 避免干扰自定义作答与下方 composer 输入。submit 定义在早退守卫之后,经 ref 桥接取最新闭包。
  const submitRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!id || !envelope) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Enter") {
        submitRef.current();
        return;
      }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1) return;
      const group = envelope.groups[Math.min(activeIdx, envelope.groups.length - 1)];
      if (!group || n > group.options.length) return;
      setSelections((s) => ({ ...s, [group.id]: { optionIndex: n - 1 } }));
      setActiveIdx((i) => Math.min(i + 1, envelope.groups.length - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, envelope, activeIdx]);

  const unansweredCount = useMemo(() => {
    if (!envelope) return 0;
    return envelope.groups.filter((g) => !isAnswered(g, selections[g.id])).length;
  }, [envelope, selections]);

  if (!pending || !id || !envelope) return null;
  const answeredAll = unansweredCount === 0;
  const groups = envelope.groups;
  const active = groups[Math.min(activeIdx, groups.length - 1)];
  if (!active) return null;
  const activeSel = selections[active.id];
  const activeCustom = typeof activeSel?.custom === "string" ? activeSel.custom : "";
  const optionPicked = activeSel?.optionIndex != null;
  const customFilled = activeCustom.trim().length > 0;

  // 互斥(last-action wins):选选项清自定义、输入自定义清选项,任一时刻每组只有唯一作答来源(KTD-5)。
  const pickOption = (gid: string, idx: number) => {
    setSelections((s) => ({ ...s, [gid]: { optionIndex: idx } }));
    setActiveIdx((i) => Math.min(i + 1, groups.length - 1)); // 选完当前组自动跳下一组(末组则停留)
  };
  const setCustom = (gid: string, text: string) => setSelections((s) => ({ ...s, [gid]: { custom: text } }));

  const submit = () => {
    if (!answeredAll || submitting) return;
    setSubmitting(true); // 防重复回写同一 id;回写后出队 → 卡片卸载。
    respondPiUi(bridge, sessionId, id, { value: serializeAskQuestionAnswers(envelope, selections) });
  };
  submitRef.current = submit;
  const cancel = () => {
    if (submitting) return;
    respondPiUi(bridge, sessionId, id, { cancelled: true });
  };

  return (
    <div className="pw-askq" role="group" aria-label="向你提问">
      {/* 头部身份行:让卡片一眼可辨「agent 在等你作答」,并提供 ✕ 关闭(等价取消)。 */}
      <div className="pw-askq-head">
        <span className="pw-askq-head-ic" aria-hidden>
          ?
        </span>
        <span className="pw-askq-head-title">向你提问</span>
        {groups.length > 1 ? (
          <span className="pw-askq-head-count">{`${groups.length - unansweredCount}/${groups.length}`}</span>
        ) : null}
        <button type="button" className="pw-askq-head-close" aria-label="关闭" onClick={cancel} disabled={submitting}>
          ✕
        </button>
      </div>
      {groups.length > 1 ? (
        <div className="pw-askq-tabs" role="tablist" aria-label="问题分组">
          {groups.map((g, i) => {
            const done = isAnswered(g, selections[g.id]);
            return (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={i === activeIdx}
                className={`pw-askq-tab${i === activeIdx ? " active" : ""}${done ? " answered" : ""}`}
                onClick={() => setActiveIdx(i)}
              >
                {done ? <span className="pw-askq-tab-check">✓</span> : null}
                <span className="pw-askq-tab-label">{g.header || `问题 ${i + 1}`}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="pw-askq-body" role="tabpanel">
        <div className="pw-askq-question">{active.question}</div>
        <div className={`pw-askq-options${customFilled ? " dimmed" : ""}`} role="radiogroup" aria-label={active.question}>
          {active.options.map((opt, idx) => {
            const selected = optionPicked && activeSel?.optionIndex === idx;
            const recommended = active.recommended === idx;
            return (
              <button
                key={idx}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`pw-askq-opt${selected ? " selected" : ""}`}
                onClick={() => pickOption(active.id, idx)}
              >
                <span className="pw-askq-opt-main">
                  <span className="pw-askq-opt-radio" aria-hidden />
                  <span className="pw-askq-opt-label">{opt.label}</span>
                  {recommended ? <span className="pw-askq-badge">推荐</span> : null}
                </span>
                {opt.description ? <span className="pw-askq-opt-desc">{opt.description}</span> : null}
              </button>
            );
          })}
        </div>
        {active.allowCustom ? (
          <input
            className={`pw-askq-custom${optionPicked ? " dimmed" : ""}`}
            type="text"
            placeholder="或自定义回答…"
            value={activeCustom}
            aria-label={`${active.question} 自定义回答`}
            onChange={(e) => setCustom(active.id, e.target.value)}
            // 自定义输入内回车即提交(答完时),省去移动鼠标点「提交」;未答完则忽略。
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
            }}
          />
        ) : null}
      </div>

      <div className="pw-askq-foot">
        <span className="pw-askq-hint">
          {answeredAll ? "已全部作答" : groups.length > 1 ? `还有 ${unansweredCount} 组未作答` : "选择一项,或输入自定义回答"}
        </span>
        <span className="pw-askq-kbds" aria-hidden>
          <kbd className="pw-askq-kbd">1-{Math.min(active.options.length, 9)}</kbd> 选择
          {answeredAll ? (
            <>
              {" "}
              · <kbd className="pw-askq-kbd">⏎</kbd> 提交
            </>
          ) : null}{" "}
          · <kbd className="pw-askq-kbd">Esc</kbd> 取消
        </span>
        <button type="button" className="btn" onClick={cancel} disabled={submitting}>
          取消
        </button>
        <button type="button" className="btn primary" onClick={submit} disabled={!answeredAll || submitting}>
          提交
        </button>
      </div>
    </div>
  );
}
