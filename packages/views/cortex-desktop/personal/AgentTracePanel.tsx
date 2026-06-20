import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentTraceEvent, DesktopBridge } from "@cortex-work/core";

function formatTraceTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "--:--:--";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function traceDataPreview(data: unknown): string {
  if (data == null) return "";
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/* eslint-disable i18next/no-literal-string -- dev-only diagnostics labels are intentionally not localized. */
export function AgentTracePanel({ bridge }: { bridge: DesktopBridge }) {
  const [events, setEvents] = useState<AgentTraceEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const pausedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void bridge.agentTraceList?.().then((list) => {
      if (alive) setEvents(list);
    });
    const off = bridge.onAgentTrace?.((event) => {
      setEvents((prev) => (pausedRef.current ? prev : [...prev, event].slice(-500)));
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [bridge]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return events;
    return events.filter((event) =>
      [event.scope, event.phase, event.summary, event.runId, event.sessionId, event.agent]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [events, query]);

  const clear = async () => {
    await bridge.agentTraceClear?.();
    setEvents([]);
  };

  const togglePaused = () => {
    setPaused((value) => {
      const next = !value;
      pausedRef.current = next;
      return next;
    });
  };

  return (
    <div className="pw-trace-panel">
      <div className="pw-trace-toolbar">
        <input
          className="pw-set-input pw-trace-search"
          value={query}
          placeholder="过滤 scope / phase / runId"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="pw-trace-count">{filtered.length} / {events.length}</span>
        <button className="pw-tl-gen" onClick={togglePaused}>
          {paused ? "继续" : "暂停"}
        </button>
        <button className="pw-tl-gen" onClick={() => void clear()} disabled={!bridge.agentTraceClear}>
          清空
        </button>
      </div>
      <div className="pw-trace-list">
        {filtered.length === 0 ? (
          <div className="pw-scard-empty">暂无 trace 事件</div>
        ) : (
          filtered
            .slice()
            .reverse()
            .map((event) => (
              <details key={event.id} className="pw-trace-item">
                <summary>
                  <span className="pw-trace-time">{formatTraceTime(event.ts)}</span>
                  <span className="pw-trace-chip">{event.scope}</span>
                  <span className="pw-trace-chip">{event.phase}</span>
                  <span className="pw-trace-summary">{event.summary}</span>
                </summary>
                <div className="pw-trace-meta">
                  {event.agent ? <span>agent={event.agent}</span> : null}
                  {event.runId ? <span>run={event.runId}</span> : null}
                  {event.sessionId ? <span>session={event.sessionId}</span> : null}
                </div>
                {event.data != null ? <pre className="pw-trace-data">{traceDataPreview(event.data)}</pre> : null}
              </details>
            ))
        )}
      </div>
    </div>
  );
}
/* eslint-enable i18next/no-literal-string */
