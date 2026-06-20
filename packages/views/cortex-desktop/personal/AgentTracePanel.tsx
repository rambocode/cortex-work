import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentTraceEvent, DesktopBridge } from "@cortex-work/core";

function formatTraceTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "--:--:--";
  const d = new Date(ts);
  return `${d.toLocaleTimeString("zh-CN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const pausedRef = useRef(false);
  const listRef = useRef<HTMLUListElement | null>(null);

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

  useEffect(() => {
    const el = listRef.current;
    if (!el || expandedId) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered.length, expandedId]);

  const clear = async () => {
    await bridge.agentTraceClear?.();
    setEvents([]);
    setExpandedId(null);
  };

  const togglePaused = () => {
    setPaused((value) => {
      const next = !value;
      pausedRef.current = next;
      return next;
    });
  };

  const toggleExpanded = (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
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
      <ul className="pw-trace-list" ref={listRef} aria-label="Agent trace console">
        {filtered.length === 0 ? (
          <li className="pw-trace-empty">暂无 trace 事件</li>
        ) : (
          filtered.map((event) => {
            const expanded = expandedId === event.id;
            return (
              <li
                key={event.id}
                className={`pw-trace-line ${expanded ? "is-expanded" : ""}`}
                aria-label={`${formatTraceTime(event.ts)} [${event.scope.toUpperCase()}] [${event.phase.toUpperCase()}] ${event.summary}`}
                tabIndex={0}
                onClick={() => toggleExpanded(event.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleExpanded(event.id);
                  }
                }}
              >
                <div className="pw-trace-line-main">
                  <span className="pw-trace-time">{formatTraceTime(event.ts)}</span>
                  <span className="pw-trace-token" data-scope={event.scope}>[{event.scope.toUpperCase()}]</span>
                  <span className="pw-trace-token" data-phase={event.phase.toLowerCase()}>[{event.phase.toUpperCase()}]</span>
                  <span className="pw-trace-summary">{event.summary}</span>
                  {event.agent ? <span className="pw-trace-meta-token">agent={event.agent}</span> : null}
                  {event.runId ? <span className="pw-trace-meta-token">run={event.runId}</span> : null}
                  {event.sessionId ? <span className="pw-trace-meta-token">session={event.sessionId}</span> : null}
                </div>
                {expanded && event.data != null ? <pre className="pw-trace-data">{traceDataPreview(event.data)}</pre> : null}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
/* eslint-enable i18next/no-literal-string */
