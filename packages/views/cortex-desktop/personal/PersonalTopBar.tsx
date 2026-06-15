// 个人工作区「中栏」顶部头：取代旧的全宽 TitleBar 在个人区的职责。
// 三栏各自顶天后,中栏顶部承担窗口拖拽区 + 标题 + 更新按钮 + 右栏面板下拉。
// 拖拽区由 CSS .pw-col-head 的 -webkit-app-region: drag 提供,交互子元素 no-drag。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import { UpdateButton } from "../UpdateButton";

export function PersonalCenterHeader() {
  return (
    <div className="pw-col-head pw-center-head">
      <span className="pw-col-head-title">个人工作区</span>
      <div className="spacer" />
      <UpdateButton />
      <PersonalPanelControls />
    </div>
  );
}

// 终端开关 + 右栏面板下拉（选择 文件 / Skills / Tasks 视图,或收起面板）。
// 下拉:点击展开;光标移出菜单区域延时自动收起;点击外部 / Esc / 窗口失焦关闭。
function PersonalPanelControls() {
  const rightOpen = useCortexUIStore((s) => s.rightOpen);
  const toggleRight = useCortexUIStore((s) => s.toggleRight);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const terminalOpen = usePersonalStore((s) => s.terminalOpen);
  const toggleTerminal = usePersonalStore((s) => s.toggleTerminal);
  const rightView = usePersonalStore((s) => s.rightView);
  const setRightView = usePersonalStore((s) => s.setRightView);

  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  useEffect(() => cancelCloseTimer, []);

  // 点击外部 / Esc / 窗口失焦关闭（与项目内其它菜单约定一致,见 ProjectMenu）。
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const onBlur = () => setMenuOpen(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [menuOpen]);

  // 鼠标移出菜单区域后短暂延迟自动收起;重新移入则取消（见 TodosView 的 ArchiveMenu）。
  const onMenuLeave = () => {
    cancelCloseTimer();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setMenuOpen(false);
    }, 220);
  };
  const onMenuEnter = () => cancelCloseTimer();

  const pick = (view: "files" | "skills" | "todos") => {
    setRightView(view);
    if (!rightOpen) setRightOpen(true);
    setMenuOpen(false);
  };

  return (
    <>
      <button
        className={`icon-btn ${terminalOpen ? "is-on" : ""}`}
        title={terminalOpen ? "收起终端" : "打开终端"}
        onClick={toggleTerminal}
      >
        <Icon.Terminal />
      </button>
      <div className="tb-divider" />
      <div
        className="pw-tb-menu-wrap"
        ref={wrapRef}
        onMouseLeave={onMenuLeave}
        onMouseEnter={onMenuEnter}
      >
        <button
          className={`icon-btn ${rightOpen ? "is-on" : ""}`}
          title="右侧面板"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Icon.Sidebar />
          <Icon.Chevron size={9} />
        </button>
        {menuOpen ? (
          <div className="pw-tb-menu" role="menu">
            <button className="pw-tb-menu-item" role="menuitem" onClick={() => pick("files")}>
              <Icon.Folder size={14} />
              <span>文件</span>
              {rightOpen && rightView === "files" ? <Icon.Check size={13} /> : null}
            </button>
            <button className="pw-tb-menu-item" role="menuitem" onClick={() => pick("skills")}>
              <Icon.Sparkle size={14} />
              <span>Skills</span>
              {rightOpen && rightView === "skills" ? <Icon.Check size={13} /> : null}
            </button>
            <button className="pw-tb-menu-item" role="menuitem" onClick={() => pick("todos")}>
              <Icon.Task size={14} />
              <span>Tasks</span>
              {rightOpen && rightView === "todos" ? <Icon.Check size={13} /> : null}
            </button>
            <button
              className="pw-tb-menu-item"
              role="menuitem"
              onClick={() => {
                toggleTerminal?.();
                setMenuOpen(false);
              }}
            >
              <Icon.Terminal size={14} />
              <span>终端</span>
              {terminalOpen ? <Icon.Check size={13} /> : null}
            </button>
            <div className="pw-tb-menu-sep" />
            <button
              className="pw-tb-menu-item"
              role="menuitem"
              onClick={() => {
                toggleRight();
                setMenuOpen(false);
              }}
            >
              <Icon.Sidebar size={14} />
              <span>{rightOpen ? "收起右侧面板" : "展开右侧面板"}</span>
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
