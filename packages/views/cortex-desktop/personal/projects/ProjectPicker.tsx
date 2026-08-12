// 项目选择器(当前唯一使用者:新会话落地页的 ProjectBar):
// 触发器显示当前项目名 /「不使用项目」/「选择项目」,
// 下拉面板(fixed 定位 + 点击外部/Esc 关闭,交互仿 ProjectMenu)含搜索框、
// 可见项目列表(当前项右侧 ✓)、「添加新项目」、可选「不使用项目」。
// Web 端 bridge 为 null,添加新项目按钮会因 pickDirectory 缺失而无操作。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { partitionProjects, useDesktopBridge, usePersonalStore } from "@cortex-work/core";

export function ProjectPicker({
  value,
  onChange,
  allowNoProject,
  noProjectChosen,
  disabled,
  onToast,
}: {
  value?: string;
  onChange: (projectId: string | undefined) => void;
  allowNoProject?: boolean;
  // value=undefined 时:true 显示「不使用项目」(已显式选/默认),false 显示「选择项目」占位。
  noProjectChosen?: boolean;
  disabled?: boolean;
  onToast: (text: string) => void;
}) {
  const bridge = useDesktopBridge();
  const projects = usePersonalStore((s) => s.projects);
  const addProject = usePersonalStore((s) => s.addProject);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState({ left: 0, top: 0 });

  // 选了具体项目显示项目名;value=undefined 时由 noProjectChosen 决定显示
  // 「不使用项目」还是「选择项目」(占位)。该状态由父组件持有(与会话创建路径一致)。
  const current = useMemo(() => projects.find((p) => p.id === value), [projects, value]);
  const label = current ? current.name : noProjectChosen ? "不使用项目" : "选择项目";

  const visible = useMemo(() => partitionProjects(projects).visible, [projects]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? visible.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      : visible;
  }, [visible, query]);

  // 打开时按触发器位置定位下拉(fixed),并据视口收敛。
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const panel = panelRef.current?.getBoundingClientRect();
    const width = panel?.width ?? 240;
    const height = panel?.height ?? 280;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    const top = Math.min(anchor.bottom + 4, window.innerHeight - height - 8);
    setPos({ left, top: Math.max(8, top) });
  }, [open, list.length]);

  // 点击外部 / Esc / 窗口失焦:关闭。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onBlur = () => setOpen(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  const pick = (projectId: string | undefined) => {
    onChange(projectId);
    setOpen(false);
    setQuery("");
  };

  const addNew = () => {
    void (async () => {
      try {
        const path = await bridge?.pickDirectory?.();
        if (!path) return;
        const proj = addProject(path);
        onToast(`已添加项目 ${proj.name}`);
        pick(proj.id);
      } catch (err) {
        onToast(`添加失败：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  return (
    <>
      <button
        ref={triggerRef}
        className="pw-proj-picker-trigger"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={current ? current.path : label}
      >
        <Icon.Folder size={13} />
        <span className="pw-proj-picker-label">{label}</span>
        <Icon.Chevron size={12} />
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="pw-proj-picker-panel"
          style={{ position: "fixed", left: pos.left, top: pos.top }}
          role="menu"
          aria-label="选择项目"
        >
          <div className="sb-row sb-search">
            <Icon.Search size={13} />
            <input
              className="sb-search-input"
              placeholder="检索项目（名称 / 路径）"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
            {query ? (
              <button className="sb-clear" onClick={() => setQuery("")} title="清除">
                ×
              </button>
            ) : null}
          </div>
          <div className="pw-proj-picker-list">
            {list.map((p) => (
              <button
                key={p.id}
                className="pw-tb-menu-item"
                role="menuitem"
                onClick={() => pick(p.id)}
                title={p.path}
              >
                <Icon.Folder size={13} />
                <span className="pw-proj-picker-item-name">{p.name}</span>
                {p.id === value ? <Icon.Check size={13} /> : null}
              </button>
            ))}
            {list.length === 0 ? (
              <div className="pw-empty-hint" style={{ padding: "4px 8px" }}>
                {query ? `没有匹配「${query}」的项目` : "还没有项目"}
              </div>
            ) : null}
          </div>
          <div className="pw-tb-menu-sep" />
          <button className="pw-tb-menu-item" role="menuitem" onClick={addNew}>
            <Icon.FolderPlus size={13} />
            <span>添加新项目</span>
          </button>
          {allowNoProject ? (
            <button className="pw-tb-menu-item" role="menuitem" onClick={() => pick(undefined)}>
              <Icon.X size={13} />
              <span>不使用项目</span>
              {value === undefined && noProjectChosen ? <Icon.Check size={13} /> : null}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
