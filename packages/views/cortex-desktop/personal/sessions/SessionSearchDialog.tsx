// 会话搜索弹窗：默认列出最近 10 条会话；输入后按标题/项目名过滤。键盘 ↑↓ 选择、Enter 进入、
// Esc 关闭；点击结果即切到对应会话（setActiveSession 会自动离开首页/自动化/时间线视图）。
// 复用 .pw-dlg-overlay 遮罩范式（见 PiToolConfirmDialog）。

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import { relTime } from "../layout/PersonalSidebar";

const RECENT_LIMIT = 10;
const MATCH_LIMIT = 50;

export function SessionSearchDialog() {
  const open = useCortexUIStore((s) => s.sessionSearchOpen);
  const setOpen = useCortexUIStore((s) => s.setSessionSearchOpen);
  const sessions = usePersonalStore((s) => s.sessions);
  const projects = usePersonalStore((s) => s.projects);
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);

  const [q, setQ] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const projName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);

  // 空查询 → 最近 N 条（按 updatedAt 降序,不含已归档）；有查询 → 标题/项目名子串匹配。
  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    // side 子会话只从父卡片进入；混进全局搜索会把它误当成一条普通顶层会话。
    const base = sessions.filter((s) => s.relation !== "side" && s.archivedAt == null);
    if (!query) {
      return [...base].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_LIMIT);
    }
    return base
      .filter((s) => {
        const pn = s.projectId ? (projName.get(s.projectId) ?? "") : "";
        return `${s.title} ${pn}`.toLowerCase().includes(query);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MATCH_LIMIT);
  }, [q, sessions, projName]);

  // 打开时重置查询并聚焦输入（弹窗已挂载后再 focus,不抢已有焦点的其它逻辑）。
  useEffect(() => {
    if (!open) return;
    setQ("");
    setActiveIdx(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // 查询变化后高亮回到首条。
  useEffect(() => {
    setActiveIdx(0);
  }, [q]);

  if (!open) return null;

  const close = () => setOpen(false);
  const pick = (id: string) => {
    setActiveSession(id);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[activeIdx];
      if (r) pick(r.id);
    }
  };

  return (
    <div className="pw-dlg-overlay" onClick={close}>
      <div
        className="pw-dlg pw-search-dlg"
        role="dialog"
        aria-modal="true"
        aria-label="搜索会话"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="pw-search-input">
          <Icon.Search size={15} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索会话标题或项目…"
          />
        </div>
        <div className="pw-search-list">
          {results.length === 0 ? (
            <div className="pw-search-empty">没有匹配的会话</div>
          ) : (
            <>
              {!q.trim() ? <div className="pw-search-hint">最近会话</div> : null}
              {results.map((s, i) => {
                const pn = s.projectId ? projName.get(s.projectId) : undefined;
                return (
                  <button
                    key={s.id}
                    className={`pw-search-row ${i === activeIdx ? "is-active" : ""}`}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => pick(s.id)}
                  >
                    <span className="pw-search-row-title">{s.title}</span>
                    <span className="pw-search-row-meta">
                      <span className="pw-search-row-proj">{pn ?? "无项目"}</span>
                      <span className="pw-search-row-time">{relTime(s.updatedAt)}</span>
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
