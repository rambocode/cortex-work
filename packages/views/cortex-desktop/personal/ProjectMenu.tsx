// 侧边栏项目「⋯」菜单：fixed 定位 + 视口内收敛,点击外部/Escape/窗口失焦关闭。
// 一级菜单含 Open in →（二级面板：编辑器列表 + 在访达中显示）、时间线、置顶、归档、删除;
// 删除走菜单内二次确认（首点变「确认删除？」),不弹系统对话框。archived 时菜单收窄。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { EditorInfo, ProjectMeta } from "@cortex-work/core";

export function ProjectMenu({
  project,
  archived,
  editors,
  anchor,
  onClose,
  onToast,
}: {
  project: ProjectMeta;
  archived: boolean;
  editors: EditorInfo[];
  anchor: { x: number; y: number };
  onClose: () => void;
  onToast: (text: string) => void;
}) {
  const bridge = useDesktopBridge();
  const openTimeline = usePersonalStore((s) => s.openTimeline);
  const updateProject = usePersonalStore((s) => s.updateProject);
  const archiveProject = usePersonalStore((s) => s.archiveProject);
  const removeProject = usePersonalStore((s) => s.removeProject);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });
  const [confirming, setConfirming] = useState(false);
  // 二级面板:"open" = Open in 编辑器列表;null = 一级菜单。
  const [panel, setPanel] = useState<null | "open">(null);

  // 防菜单溢出视口:渲染后（含二级面板切换导致尺寸变化）按实际尺寸收敛。
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      left: Math.max(8, Math.min(anchor.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(anchor.y, window.innerHeight - rect.height - 8)),
    });
  }, [anchor, panel]);

  // 点击菜单外/Escape/窗口失焦:关闭
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

  const togglePin = act(() => {
    const pinned = !!project.pinnedAt;
    updateProject(project.id, { pinnedAt: pinned ? undefined : Date.now() });
    onToast(pinned ? `已取消置顶 ${project.name}` : `已置顶 ${project.name}`);
  });

  const doArchive = act(() => {
    archiveProject(project.id);
    onToast(`已归档 ${project.name}`);
  });

  const doUnarchive = act(() => {
    updateProject(project.id, { archivedAt: undefined });
    onToast(`已取消归档 ${project.name}`);
  });

  const doRemove = act(() => {
    removeProject(project.id);
    onToast(`已移出工作区 ${project.name}`);
  });

  const openInEditor = (editor: EditorInfo) => {
    void (async () => {
      try {
        await bridge?.openInEditor?.(project.path, editor.id);
      } catch (err) {
        onToast(`打开失败：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    onClose();
  };

  const reveal = act(() => {
    void bridge?.revealInFolder?.(project.path);
  });

  return (
    <div ref={ref} className="pw-ctx-menu" style={pos} role="menu" aria-label={`${project.name} 操作`}>
      {panel === "open" ? (
        <>
          <button className="pw-tb-menu-item" role="menuitem" onClick={() => setPanel(null)}>
            <Icon.Back size={13} />
            <span>返回</span>
          </button>
          <div className="pw-tb-menu-sep" />
          {editors.map((ed) => (
            <button key={ed.id} className="pw-tb-menu-item" role="menuitem" onClick={() => openInEditor(ed)}>
              <Icon.Code size={13} />
              <span>{ed.name}</span>
            </button>
          ))}
          {editors.length > 0 ? <div className="pw-tb-menu-sep" /> : null}
          <button className="pw-tb-menu-item" role="menuitem" onClick={reveal}>
            <Icon.Folder size={13} />
            <span>在访达中显示</span>
          </button>
        </>
      ) : (
        <>
          <button className="pw-tb-menu-item" role="menuitem" onClick={() => setPanel("open")}>
            <Icon.Share size={13} />
            <span>Open in</span>
            <Icon.Chevron size={11} />
          </button>
          <button className="pw-tb-menu-item" role="menuitem" onClick={act(() => openTimeline(project.id))}>
            <Icon.Clock size={13} />
            <span>时间线</span>
          </button>
          {!archived ? (
            <button className="pw-tb-menu-item" role="menuitem" onClick={togglePin}>
              <Icon.Pin size={13} />
              <span>{project.pinnedAt ? "取消置顶" : "置顶"}</span>
            </button>
          ) : null}
          {archived ? (
            <button className="pw-tb-menu-item" role="menuitem" onClick={doUnarchive}>
              <Icon.Folder size={13} />
              <span>取消归档</span>
            </button>
          ) : (
            <button className="pw-tb-menu-item" role="menuitem" onClick={doArchive}>
              <Icon.Fwd size={13} />
              <span>归档</span>
            </button>
          )}
          <div className="pw-tb-menu-sep" />
          <button
            className="pw-tb-menu-item is-danger"
            role="menuitem"
            onClick={confirming ? doRemove : () => setConfirming(true)}
          >
            <Icon.X size={13} />
            <span>{confirming ? "确认删除？" : "删除"}</span>
          </button>
        </>
      )}
    </div>
  );
}
