// 下拉菜单关闭范式（与项目内其它菜单约定一致,见 ProjectMenu / TodosView 的 ArchiveMenu）：
// 点击外部 / Esc / 窗口失焦关闭;鼠标移出菜单区域短延迟自动收起,重新移入取消。
// 从 PersonalTopBar 抽出为独立 hook,供顶栏菜单与共享 AgentSelect 复用,避免 AgentSelect
// 回头 import PersonalTopBar 造成循环依赖。
// closeOnWindowBlur 选项：**表单型浮层**（阶段编辑/项目设置，内含原生 date input）须传 false——
// 原生日期选择日历是独立系统弹层，打开即抢走窗口焦点，若跟随 blur 关闭会导致「一点日历浮层就消失」。
// 同理表单型浮层不要挂返回的 onMouseEnter/onMouseLeave（悬停自动收起同样会被日历触发）。

import { useEffect, useRef, useState } from "react";

export function useDismissableMenu(opts?: { closeOnWindowBlur?: boolean }) {
  const closeOnWindowBlur = opts?.closeOnWindowBlur ?? true;
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
    if (closeOnWindowBlur) window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      if (closeOnWindowBlur) window.removeEventListener("blur", onBlur);
    };
  }, [open, closeOnWindowBlur]);

  const onMouseLeave = () => {
    cancelCloseTimer();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, 220);
  };
  const onMouseEnter = () => cancelCloseTimer();

  // 对外暴露的 setOpen 先取消 mouseLeave 定时器再更新状态,
  // 防止残留定时器与 onClick toggle 竞态导致菜单闪现即消失。
  const setOpenSafe: typeof setOpen = (action) => {
    cancelCloseTimer();
    setOpen(action);
  };

  return { open, setOpen: setOpenSafe, wrapRef, onMouseLeave, onMouseEnter };
}
