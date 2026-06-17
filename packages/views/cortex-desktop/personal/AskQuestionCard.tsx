// askquestion 富卡片（输入框上方）。pi 的 askquestion 工具经 ctx.ui 借道 → handleLine 归一为
// PiUiRequest{method:"askquestion"} → 入 store piUiPending → 本卡片消费「当前活跃会话」队首,渲染
// 多组问题(每组 ≤3 选项,推荐项高亮 + 可自定义输入,选项与自定义互斥),整卡必答后一次提交,答案
// 聚合 JSON 经 {value} 回写 pi;取消/ESC → {cancelled}。会话隔离:仅渲染 uiSessionId===当前会话 的卡。
// 非模态(区别于 PiToolConfirmDialog):它是会话内提问,挂在 MessageStream 与 composer 之间。

import { useEffect, useMemo, useState } from "react";
import { respondPiUi, serializeAskQuestionAnswers, useDesktopBridge, usePersonalStore } from "@cortex-work/core";

// 每组的本地选择:选项下标 或 自定义文本(互斥,KTD-5)。
type GroupSelection = { optionIndex?: number; custom?: string };

function isAnswered(g: { id: string; options: unknown[] }, sel: GroupSelection | undefined): boolean {
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

  // 切到新待答卡(id 变)时重置本地状态。
  useEffect(() => {
    setSelections({});
    setSubmitting(false);
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

  const unansweredCount = useMemo(() => {
    if (!envelope) return 0;
    return envelope.groups.filter((g) => !isAnswered(g, selections[g.id])).length;
  }, [envelope, selections]);

  if (!pending || !id || !envelope) return null;
  const answeredAll = unansweredCount === 0;

  // 互斥:选选项清自定义,反之亦然(KTD-5)。
  const pickOption = (gid: string, idx: number) => setSelections((s) => ({ ...s, [gid]: { optionIndex: idx } }));
  const setCustom = (gid: string, text: string) => setSelections((s) => ({ ...s, [gid]: { custom: text } }));

  const submit = () => {
    if (!answeredAll || submitting) return;
    setSubmitting(true); // 防重复回写同一 id;回写后出队 → 卡片卸载。
    respondPiUi(bridge, sessionId, id, { value: serializeAskQuestionAnswers(envelope, selections) });
  };
  const cancel = () => {
    if (submitting) return;
    respondPiUi(bridge, sessionId, id, { cancelled: true });
  };

  return (
    <div className="pw-askq" role="group" aria-label="向你提问">
      <div className="pw-askq-scroll">
        {envelope.groups.map((g) => {
          const sel = selections[g.id];
          const customText = typeof sel?.custom === "string" ? sel.custom : "";
          const customFilled = customText.trim().length > 0;
          const optionPicked = sel?.optionIndex != null;
          return (
            <div key={g.id} className="pw-askq-group">
              {g.header ? <div className="pw-askq-header">{g.header}</div> : null}
              <div className="pw-askq-question">{g.question}</div>
              <div className={`pw-askq-options${customFilled ? " dimmed" : ""}`} role="radiogroup" aria-label={g.question}>
                {g.options.map((opt, idx) => {
                  const selected = optionPicked && sel?.optionIndex === idx;
                  const recommended = g.recommended === idx;
                  return (
                    <button
                      key={idx}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`pw-askq-opt${selected ? " selected" : ""}`}
                      onClick={() => pickOption(g.id, idx)}
                    >
                      <span className="pw-askq-opt-main">
                        <span className="pw-askq-opt-label">{opt.label}</span>
                        {recommended ? <span className="pw-askq-badge">推荐</span> : null}
                      </span>
                      {opt.description ? <span className="pw-askq-opt-desc">{opt.description}</span> : null}
                    </button>
                  );
                })}
              </div>
              {g.allowCustom ? (
                <input
                  className="pw-askq-custom"
                  type="text"
                  placeholder="或自定义回答…"
                  value={customText}
                  disabled={optionPicked}
                  aria-label={`${g.question} 自定义回答`}
                  onChange={(e) => setCustom(g.id, e.target.value)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="pw-askq-foot">
        <span className="pw-askq-hint">{answeredAll ? "已全部作答" : `还有 ${unansweredCount} 组未作答`}</span>
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
