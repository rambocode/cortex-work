// 写作工作区整窗覆盖层(fixed inset-0):cortex 侧对 Kun「写作台」的对等物,与设计工作台同构。
// 组装左(WritingSidebar 空间+文件树)/ 中(WritingEditorPane 三档编辑)/ 右(WritingAssistantPanel 助手)三栏。
// 照 DesignWorkspace 的覆盖层与卸载语义:writingOpen 为瞬态,返回按钮 closeWriting 回落首页。
//
// U9 全链接线:本容器是 agent 改稿回路的编排点——
//   run-manager 事件(bridge.onCliEvent/onCliExit)+ watch dirChanged → attribution 归因 →
//     agent 改动    → review-manager.beginReview(编辑器 pendingReview 订阅后自动切审阅态并冻结自动保存);
//     外部改动      → 编辑器句柄 handleExternalChange(干净静默刷新 / 脏走 onConflict → beginReview);
//     非当前文件改动 → 刷新文件树(经 sidebar 注册的 refresh)。
//   发送前 flush 由助手面板经 editorRef.flushNow 触发(确保 agent 读到最新盘面)。
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core/provider";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { useWritingWorkspaceStore } from "@cortex-work/core/writing/workspace-store";
import { useWritingReviewStore } from "@cortex-work/core/writing/review-manager";
import { createWritingAttribution } from "@cortex-work/core/writing/attribution";
import type { WritingSelectionSnapshot } from "@cortex-work/core/writing/prompt";
import type { NoteEditorSelection } from "../personal/editor/NoteCodeMirrorEditor";
import { WritingSidebar } from "./WritingSidebar";
import { WritingEditorPane, type WritingEditorPaneHandle } from "./WritingEditorPane";
import { WritingAssistantPanel } from "./WritingAssistantPanel";

export function WritingWorkspace(): ReactElement {
  const bridge = useDesktopBridge();
  const closeWriting = usePersonalStore((s) => s.closeWriting);
  const spaces = useWritingSpacesStore((s) => s.spaces);
  const activeSpaceId = useWritingSpacesStore((s) => s.activeSpaceId);
  const ensureDefaultSpace = useWritingSpacesStore((s) => s.ensureDefaultSpace);
  const currentFile = useWritingWorkspaceStore((s) => s.currentFile);

  const [toast, setToast] = useState<string | null>(null);
  // 编辑器实时选区(R11):CM onSelectionChange → 此 state → 助手面板 selection prop。
  // 空选区/非编辑态为 null,润色卡与「引用选中」据此解禁。
  const [selection, setSelection] = useState<WritingSelectionSnapshot | null>(null);
  const activeSpace = spaces.find((s) => s.id === activeSpaceId) ?? null;

  // 当前打开文件是否有未处理审阅(禁发新回合 R13;传给助手面板做发送门控)。
  const hasPendingReview = useWritingReviewStore((s) =>
    currentFile ? currentFile in s.pending : false,
  );

  // 编辑器命令式句柄(flushNow / handleExternalChange / markDeleted)。
  const editorRef = useRef<WritingEditorPaneHandle | null>(null);
  // sidebar 注册进来的「重扫文件树」;归因命中非当前文件时调用。
  const refreshTreeRef = useRef<(() => void) | null>(null);
  // currentFile / bridge 走 ref,供归因控制器的稳定回调读最新值(控制器仅创建一次)。
  const currentFileRef = useRef(currentFile);
  currentFileRef.current = currentFile;
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  // 归因控制器:整窗生命周期内单实例(懒建),卸载时 dispose。回调经 ref/getState 读最新,保持稳定。
  const attributionRef = useRef<ReturnType<typeof createWritingAttribution> | null>(null);
  if (!attributionRef.current) {
    attributionRef.current = createWritingAttribution({
      getCurrentFile: () => currentFileRef.current,
      readFile: async (p) => {
        const b = bridgeRef.current;
        if (!b?.readFile) throw new Error("no readFile");
        return (await b.readFile(p)).content;
      },
      // agent 改动:入队审阅(编辑器订阅 pending 后自动切审阅态 + 冻结自动保存)。
      onAgentChange: ({ path, baseline, disk }) =>
        useWritingReviewStore
          .getState()
          .beginReview({ path, baseline, next: disk, origin: "agent" }),
      // 外部改动:交编辑器句柄自判干净刷新 / 脏冲突(脏走 onConflict)。
      onExternalChange: () => void editorRef.current?.handleExternalChange(),
      // 非当前文件:刷新文件树。
      onTreeRefresh: () => refreshTreeRef.current?.(),
    });
  }

  // 订阅 CLI 事件流 + 目录变化,转发给归因控制器(与 run-manager / sidebar 的订阅并存互不干扰)。
  useEffect(() => {
    if (!bridge) return;
    const ctrl = attributionRef.current;
    if (!ctrl) return;
    const offEvent = bridge.onCliEvent((runId, event) => ctrl.handleCliEvent(runId, event));
    const offExit = bridge.onCliExit((exit) => ctrl.handleCliExit(exit));
    const offDir = bridge.onDirChanged?.(() => ctrl.handleDirChanged());
    return () => {
      offEvent();
      offExit();
      offDir?.();
    };
  }, [bridge]);

  // 卸载(关覆盖层)时 dispose 归因控制器,停止后续异步回调。
  useEffect(() => {
    return () => {
      attributionRef.current?.dispose();
    };
  }, []);

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
          <WritingSidebar
            onToast={setToast}
            onRegisterRefresh={(fn) => {
              refreshTreeRef.current = fn;
            }}
          />
        </div>
        <div className="pw-writing-center">
          <WritingEditorPane
            ref={editorRef}
            path={currentFile}
            onToast={setToast}
            // CM 选区 → WritingSelectionSnapshot(charCount 取选中文本长度;空选区传 null)。
            onSelectionChange={(sel: NoteEditorSelection | null) =>
              setSelection(
                sel
                  ? {
                      text: sel.text,
                      charCount: sel.text.length,
                      lineStart: sel.startLine,
                      lineEnd: sel.endLine,
                    }
                  : null,
              )
            }
            // 脏态遇外部改动的冲突审阅入口:基线=编辑器当前内容,新版=盘上内容(复用同一 diff 通道)。
            onConflict={({ path, baseline, disk }) =>
              useWritingReviewStore
                .getState()
                .beginReview({ path, baseline, next: disk, origin: "conflict" })
            }
          />
        </div>
        <div className="pw-writing-right">
          <WritingAssistantPanel
            space={activeSpace}
            activeFilePath={currentFile}
            // 编辑器实时选区(R11):有选区时润色卡/引用按钮解禁。
            selection={selection}
            hasPendingReview={hasPendingReview}
            onFlushBeforeSend={() => editorRef.current?.flushNow()}
            onToast={setToast}
          />
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
