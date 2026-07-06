// 写作工作区整窗覆盖层(fixed inset-0):cortex 侧对 Kun「写作台」的对等物,与设计工作台同构。
// 组装左(WritingSidebar 空间+文件树)/ 中(编辑器,U5 接入)/ 右(写作助手,U8 接入)三栏。
// 照 DesignWorkspace 的覆盖层与卸载语义:writingOpen 为瞬态,返回按钮 closeWriting 回落首页。
// 挂载时 ensureDefaultSpace:首次进入以 fs:writingWorkspaceRoot 建默认空间(Documents/cortex/writing)。
import { useEffect, useState, type ReactElement } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core/provider";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { useWritingSpacesStore, type WritingSpacesState } from "@cortex-work/core/writing/spaces";
import { useWritingWorkspaceStore } from "@cortex-work/core/writing/workspace-store";
import { WritingSidebar } from "./WritingSidebar";

// 从空间 store 状态派生空间元素类型,避免为 WritingSpace 单独加 core 导出。
type WritingSpace = WritingSpacesState["spaces"][number];

// 中/右栏在 U4 为占位。留好稳定 props 接口供 U5(编辑器)/U8(助手)替换实现,
// 避免后续单元反复改 WritingWorkspace 的组装。

// 中栏编辑器占位:U5 换成 WritingEditorPane(三档编辑 + 自动保存 + 磁盘基线)。
function WritingEditorPanePlaceholder({ filePath }: { filePath: string | null }): ReactElement {
  return (
    <div className="pw-writing-editor pw-writing-placeholder">
      {filePath ? (
        <div className="pw-writing-editor-head" title={filePath}>
          {filePath.split(/[/\\]/).pop()}
        </div>
      ) : null}
      <div className="pw-writing-placeholder-body">
        {filePath ? "编辑器占位(U5 接入三档编辑)" : "从左侧选择或新建一个文件开始写作"}
      </div>
    </div>
  );
}

// 右栏写作助手占位:U8 换成 WritingAssistantPanel(快捷动作 + 选中引用 + 发送/中断 + 会话管理)。
function WritingAssistantPanelPlaceholder({ space }: { space: WritingSpace | null }): ReactElement {
  return (
    <div className="pw-writing-assistant pw-writing-placeholder">
      <div className="pw-writing-placeholder-body">
        {space ? "写作助手占位(U8 接入)" : "先选择一个写作空间"}
      </div>
    </div>
  );
}

export function WritingWorkspace(): ReactElement {
  const bridge = useDesktopBridge();
  const closeWriting = usePersonalStore((s) => s.closeWriting);
  const spaces = useWritingSpacesStore((s) => s.spaces);
  const activeSpaceId = useWritingSpacesStore((s) => s.activeSpaceId);
  const ensureDefaultSpace = useWritingSpacesStore((s) => s.ensureDefaultSpace);
  const currentFile = useWritingWorkspaceStore((s) => s.currentFile);

  const [toast, setToast] = useState<string | null>(null);
  const activeSpace = spaces.find((s) => s.id === activeSpaceId) ?? null;

  // 首次进入:无空间时以默认根建一个空间(已有空间则 no-op)。仅挂载时跑一次。
  useEffect(() => {
    void ensureDefaultSpace(bridge);
  }, [bridge, ensureDefaultSpace]);

  // toast 自动消失(3s)。
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    // 整窗接管:fixed 覆盖层盖住个人工作区侧栏,自成左/中/右三栏。与 settings 同级(z-40)。
    <div className="pw-writing-root">
      {/* 顶部窄条:作拖拽区(避让 macOS 红绿灯)并放返回按钮。ds-drag/ds-no-drag 复用设计工作台既有类 */}
      <div className="pw-writing-topbar ds-drag">
        <button
          type="button"
          className="pw-writing-back ds-no-drag"
          title="返回"
          aria-label="返回"
          onClick={() => closeWriting()}
        >
          <Icon.Back size={15} />
          <span>返回</span>
        </button>
        <span className="pw-writing-title ds-no-drag">写作</span>
      </div>

      <div className="pw-writing-body">
        <div className="pw-writing-left">
          <WritingSidebar onToast={setToast} />
        </div>
        <div className="pw-writing-center">
          <WritingEditorPanePlaceholder filePath={currentFile} />
        </div>
        <div className="pw-writing-right">
          <WritingAssistantPanelPlaceholder space={activeSpace} />
        </div>
      </div>

      {toast ? (
        <div className="pw-writing-toast" role="status">
          <button type="button" onClick={() => setToast(null)}>
            {toast}
          </button>
        </div>
      ) : null}
    </div>
  );
}
