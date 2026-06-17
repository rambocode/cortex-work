// pi extension 工具确认弹窗（阶段3）。pi extension 的 tool_call hook 调 ctx.ui.confirm() →
// extension_ui_request{confirm} → 入 store piUiPending 队列 → 本模态显队首 → 用户决策回写
// extension_ui_response{confirmed|cancelled} → pi 放行/阻断工具。复用 AutomationDialog 的
// .pw-dlg-overlay/.pw-dlg 外壳（遮罩 + stopPropagation + ESC）。RPC 串行 → 通常队列 ≤1。

import { useEffect } from "react";
import { respondPiUi, useDesktopBridge, usePersonalStore } from "@cortex-work/core";

export function PiToolConfirmDialog() {
  const bridge = useDesktopBridge();
  // 只消费 confirm 队首（usePersonalPiUi 已只入队 confirm）。
  const pending = usePersonalStore((s) => s.piUiPending[0]);

  const active = pending && pending.request.method === "confirm" ? pending : undefined;
  const id = active?.request.id;
  const uiSessionId = active?.uiSessionId;

  // ESC = 取消（cancelled,pi 侧等价拒绝）。依赖 id 变化重绑,确保关闭的是当前请求。
  useEffect(() => {
    if (!active || !id || !uiSessionId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") respondPiUi(bridge, uiSessionId, id, { cancelled: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, id, uiSessionId, bridge]);

  if (!active || !id || !uiSessionId || active.request.method !== "confirm") return null;
  const { title, message } = active.request;

  const decide = (payload: { confirmed: boolean } | { cancelled: true }) =>
    respondPiUi(bridge, uiSessionId, id, payload);

  return (
    <div className="pw-dlg-overlay" onClick={() => decide({ cancelled: true })}>
      <div
        className="pw-dlg pw-confirm-dlg"
        role="dialog"
        aria-modal="true"
        aria-label="工具执行确认"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pw-confirm-head">{title}</div>
        {message ? <div className="pw-confirm-body">{message}</div> : null}
        <div className="pw-confirm-foot">
          <button className="btn" onClick={() => decide({ confirmed: false })}>
            拒绝
          </button>
          <button className="btn primary" onClick={() => decide({ confirmed: true })}>
            允许
          </button>
        </div>
      </div>
    </div>
  );
}
