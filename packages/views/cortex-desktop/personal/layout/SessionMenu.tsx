// 侧栏对话行「⋯」菜单(对齐 Codex):重命名 / 置顶 / 标记为未读 / 归档 / 删除。
// fixed 定位 + 渲染后按实际尺寸收敛进视口(与 ProjectMenu 同款),点击外部 / Esc / 窗口失焦关闭。
// 删除走菜单内二次确认(首点变「确认删除？」),不弹系统对话框。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";

export function SessionMenu({
  title,
  pinned,
  unread,
  archived,
  anchor,
  onRename,
  onTogglePin,
  onToggleUnread,
  onToggleArchive,
  onDelete,
  onClose,
}: {
  title: string;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  anchor: { x: number; y: number };
  onRename: () => void;
  onTogglePin: () => void;
  onToggleUnread: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });
  const [confirming, setConfirming] = useState(false);

  // 防溢出视口:行在侧栏底部时菜单向上收,右侧放不下时向左收。
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      left: Math.max(8, Math.min(anchor.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(anchor.y, window.innerHeight - rect.height - 8)),
    });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // 普通操作:执行后关闭。
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div ref={ref} className="pw-ctx-menu" style={pos} role="menu" aria-label={`${title} 操作`}>
      <button className="pw-tb-menu-item" role="menuitem" onClick={act(onRename)}>
        <Icon.Edit size={13} />
        <span>重命名</span>
      </button>
      {!archived ? (
        <button className="pw-tb-menu-item" role="menuitem" onClick={act(onTogglePin)}>
          <Icon.Pushpin size={13} />
          <span>{pinned ? "取消置顶" : "置顶"}</span>
        </button>
      ) : null}
      <button className="pw-tb-menu-item" role="menuitem" onClick={act(onToggleUnread)}>
        <Icon.Eye size={13} />
        <span>{unread ? "标记为已读" : "标记为未读"}</span>
      </button>
      <button className="pw-tb-menu-item" role="menuitem" onClick={act(onToggleArchive)}>
        {archived ? <Icon.Reply size={13} /> : <Icon.Archive size={13} />}
        <span>{archived ? "取消归档" : "归档"}</span>
      </button>
      <div className="pw-tb-menu-sep" />
      <button
        className="pw-tb-menu-item is-danger"
        role="menuitem"
        onClick={confirming ? act(onDelete) : () => setConfirming(true)}
      >
        <Icon.Trash size={13} />
        <span>{confirming ? "确认删除？" : "删除"}</span>
      </button>
    </div>
  );
}
