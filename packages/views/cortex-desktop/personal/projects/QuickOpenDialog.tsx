// 「快速入口」命令面板对话框:输入即模糊搜索全量任务 + 项目/文件夹,↑↓ 选择、Enter 打开、Esc/遮罩关闭。
// 骨架复用 SessionSearchDialog 的 .pw-dlg-overlay / .pw-search-* 类,零新增 CSS;匹配逻辑委派 quickOpenSearch。
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTasks, useTaskProjects } from "@cortex-work/core/personal/tasks";
import { quickOpenSearch, type QuickOpenResult } from "./quickOpenSearch";

// 三类结果的左侧 kind 图标:project=任务簿、folder=文件夹、task=勾选。
function KindIcon({ kind }: { kind: QuickOpenResult["kind"] }) {
  if (kind === "folder") return <Icon.Folder size={15} />;
  if (kind === "task") return <Icon.Check size={15} />;
  return <Icon.Task size={15} />;
}

// 命令面板对话框。open=false 时返回 null(不挂载)。
export function QuickOpenDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (r: QuickOpenResult) => void;
}) {
  const tasks = useTasks().data ?? [];
  const projects = useTaskProjects().data ?? [];

  const [q, setQ] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 有 query 才跑匹配;空 query 结果为 [](显示 hint,不列全量)。
  const results = useMemo(() => quickOpenSearch(tasks, projects, q), [tasks, projects, q]);

  // 打开时清空 query、高亮归零并聚焦输入(挂载后再 focus,不抢其它焦点逻辑)。
  useEffect(() => {
    if (!open) return;
    setQ("");
    setActiveIdx(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // query 变化后高亮回到首条。
  useEffect(() => {
    setActiveIdx(0);
  }, [q]);

  if (!open) return null;

  const pick = (r: QuickOpenResult) => {
    onPick(r);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[activeIdx];
      if (r) pick(r);
    }
  };

  const hasQuery = q.trim().length > 0;

  return (
    <div className="pw-dlg-overlay" onClick={onClose}>
      <div
        className="pw-dlg pw-search-dlg"
        role="dialog"
        aria-modal="true"
        aria-label="快速入口"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="pw-search-input">
          <Icon.Search size={15} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索任务或项目…"
          />
        </div>
        <div className="pw-search-list">
          {!hasQuery ? (
            <div className="pw-search-hint">输入以搜索任务或项目</div>
          ) : results.length === 0 ? (
            <div className="pw-search-empty">没有匹配的结果</div>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.kind}:${r.id}`}
                className={`pw-search-row ${i === activeIdx ? "is-active" : ""}`}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => pick(r)}
              >
                {/* 左侧 kind 图标 + 标题聚成一组(内联布局,避免为分组新增 CSS 类);次要文字靠右。 */}
                <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
                  <KindIcon kind={r.kind} />
                  <span className="pw-search-row-title">{r.label}</span>
                </span>
                {r.sublabel ? (
                  <span className="pw-search-row-meta">
                    <span className="pw-search-row-proj">{r.sublabel}</span>
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
