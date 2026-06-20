import ReactDOM from "react-dom/client";
import { AgentTracePanel } from "@cortex-work/views/cortex-desktop";
import "./globals.css";

const bridge = window.desktopAPI?.personal;

/* eslint-disable i18next/no-literal-string -- dev-only diagnostics window labels are intentionally not localized. */
function AgentTraceWindow() {
  if (!bridge) {
    return <div className="agent-trace-window"><div className="pw-scard-empty">Desktop bridge 不可用</div></div>;
  }

  return (
    <main className="agent-trace-window">
      <div className="pw-trace-shell">
        <div className="pw-trace-title">
          <h1>Agent 调试跟踪</h1>
          <span>dev only</span>
        </div>
        <AgentTracePanel bridge={bridge} />
      </div>
    </main>
  );
}
/* eslint-enable i18next/no-literal-string */

ReactDOM.createRoot(document.getElementById("root")!).render(<AgentTraceWindow />);
