// 文件列表右键菜单：fixed 定位 + 视口内收敛,点击外部/Escape/窗口失焦关闭。
// 删除走菜单内二次确认（首点变「确认删除？」),不弹系统对话框。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";

export interface FileCtxTarget {
  x: number;
  y: number;
  path: string; // 绝对路径
  name: string; // 展示名（文件名或仓库相对路径）
}

export function FileContextMenu({
  target,
  canOpen,
  onOpen,
  onInsertChat,
  onInsertTerminal,
  onDelete,
  onClose,
}: {
  target: FileCtxTarget;
  canOpen: boolean;
  onOpen: () => void;
  onInsertChat: () => void;
  onInsertTerminal: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: target.x, top: target.y });
  const [confirming, setConfirming] = useState(false);

  // 换了目标（在另一行再次右键）:重置删除确认态
  useEffect(() => setConfirming(false), [target]);

  // 防菜单溢出视口:渲染后按实际尺寸收敛
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      left: Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8)),
    });
  }, [target]);

  // 点击菜单外（含右键空白处的 mousedown）/Escape/窗口失焦:关闭
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

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div ref={ref} className="pw-ctx-menu" style={pos} role="menu" aria-label={`${target.name} 操作`}>
      {canOpen ? (
        <button className="pw-tb-menu-item" role="menuitem" onClick={act(onOpen)}>
          <Icon.Share size={13} />
          <span>打开</span>
        </button>
      ) : null}
      <button className="pw-tb-menu-item" role="menuitem" onClick={act(onInsertChat)}>
        <Icon.Send size={13} />
        <span>插入到聊天框</span>
      </button>
      <button className="pw-tb-menu-item" role="menuitem" onClick={act(onInsertTerminal)}>
        <Icon.Terminal size={13} />
        <span>插入到终端</span>
      </button>
      <div className="pw-tb-menu-sep" />
      <button
        className="pw-tb-menu-item is-danger"
        role="menuitem"
        onClick={confirming ? act(onDelete) : () => setConfirming(true)}
      >
        <Icon.X size={13} />
        <span>{confirming ? "确认删除？" : "删除"}</span>
      </button>
    </div>
  );
}
