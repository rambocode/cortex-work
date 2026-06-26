// 下拉菜单关闭范式（与项目内其它菜单约定一致,见 ProjectMenu / TodosView 的 ArchiveMenu）：
// 点击外部 / Esc / 窗口失焦关闭;鼠标移出菜单区域短延迟自动收起,重新移入取消。
// 从 PersonalTopBar 抽出为独立 hook,供顶栏菜单与共享 AgentSelect 复用,避免 AgentSelect
// 回头 import PersonalTopBar 造成循环依赖。

import { useEffect, useRef, useState } from "react";

export function useDismissableMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  useEffect(() => cancelCloseTimer, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
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

  const onMouseLeave = () => {
    cancelCloseTimer();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, 220);
  };
  const onMouseEnter = () => cancelCloseTimer();

  return { open, setOpen, wrapRef, onMouseLeave, onMouseEnter };
}
