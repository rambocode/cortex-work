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
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core/provider";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { writingFontStackFor } from "@cortex-work/core/writing/typography";
import { useWritingWorkspaceStore } from "@cortex-work/core/writing/workspace-store";
import { useWritingReviewStore } from "@cortex-work/core/writing/review-manager";
import { createWritingAttribution } from "@cortex-work/core/writing/attribution";
import type { WritingSelectionSnapshot } from "@cortex-work/core/writing/prompt";
import type { NoteEditorSelection } from "../personal/editor/NoteCodeMirrorEditor";
import { WritingSidebar } from "./WritingSidebar";
import { WritingEditorPane, type WritingEditorPaneHandle } from "./WritingEditorPane";
import { WritingAssistantPanel } from "./WritingAssistantPanel";

// 三栏宽度契约(与 cortex-desktop.css 的 .pw-writing-left/center/right 保持一致):
// 左栏固定 260、中栏保底 560(Kun MAIN_MIN_WIDTH)、右侧助手栏固定 360。
// 窗口窄于「左(若展开)+ 中保底 + 右」时自动收起助手栏让位(body overflow 已 hidden,不再横向滚动)。
const LEFT_W = 260;
const CENTER_MIN_W = 560;
const RIGHT_W = 360;

export function WritingWorkspace(): ReactElement {
  const bridge = useDesktopBridge();
  const closeWriting = usePersonalStore((s) => s.closeWriting);
  const spaces = useWritingSpacesStore((s) => s.spaces);
  const activeSpaceId = useWritingSpacesStore((s) => s.activeSpaceId);
  const ensureDefaultSpace = useWritingSpacesStore((s) => s.ensureDefaultSpace);
  const currentFile = useWritingWorkspaceStore((s) => s.currentFile);

  // 编辑器视图偏好(持久化在 spaces store,跨空间共享):视图档位 + 字号。
  const previewMode = useWritingSpacesStore((s) => s.previewMode);
  const setPreviewMode = useWritingSpacesStore((s) => s.setPreviewMode);
  const fontSizePx = useWritingSpacesStore((s) => s.fontSizePx);
  const setFontSizePx = useWritingSpacesStore((s) => s.setFontSizePx);
  // 排版：字体预设/custom → CSS font-family 栈;行距无单位。作用于中栏四档(CM/预览/rich)。
  const fontPreset = useWritingSpacesStore((s) => s.fontPreset);
  const customFontFamily = useWritingSpacesStore((s) => s.customFontFamily);
  const lineHeight = useWritingSpacesStore((s) => s.lineHeight);
  const fontFamily = writingFontStackFor(fontPreset, customFontFamily);

  const [toast, setToast] = useState<string | null>(null);
  // 左栏折叠 / 右侧助手栏开合(顶栏两个按钮控制;瞬态,不持久化)。
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(true);
  // 窄窗自适应:跟踪窗口宽度(覆盖层 fixed inset-0 占满整窗,innerWidth 即容器宽)。
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // narrow:放不下「左(若展开)+ 中保底 + 右」三栏。assistantOpen 保留为用户意图不被改写,
  // 实际显示 = 意图 && !narrow —— 窄窗自动收起助手栏保证中栏可用,拖宽后自动恢复。
  const narrow = windowWidth < (leftCollapsed ? 0 : LEFT_W) + CENTER_MIN_W + RIGHT_W;
  const assistantVisible = assistantOpen && !narrow;
  // 窄窗下手动打开助手:先折叠左栏腾出 260px;连中+右都放不下时提示并放弃打开。
  const toggleAssistant = () => {
    if (assistantVisible) {
      setAssistantOpen(false);
      return;
    }
    if (windowWidth < CENTER_MIN_W + RIGHT_W) {
      setToast("窗口过窄,无法打开助手面板");
      return;
    }
    if (narrow && !leftCollapsed) setLeftCollapsed(true);
    setAssistantOpen(true);
  };
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
  // 当前活跃空间根走 ref:供 dirChanged 回调失效检索索引时读最新值(订阅回调闭包只建一次)。
  const activeSpaceRootRef = useRef<string | null>(activeSpace?.root ?? null);
  activeSpaceRootRef.current = activeSpace?.root ?? null;

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
    // 目录变化:归因控制器处理 + 失效当前空间的检索索引(U4),下次助手发送重建索引读到最新内容。
    const offDir = bridge.onDirChanged?.(() => {
      ctrl.handleDirChanged();
      const root = activeSpaceRootRef.current;
      if (root) bridge.writingRetrievalInvalidate?.(root);
    });
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

  // 切文件时清空选区(U5):PDF↔文本、文件↔文件切换后旧选区快照失效,由新档编辑器/阅读器重新上报。
  useEffect(() => {
    setSelection(null);
  }, [currentFile]);

  // toast 自动消失(3s)。
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    // 整窗接管:fixed 覆盖层盖住个人工作区侧栏,自成左/中/右三栏(通栏:各列贯穿到顶,无横跨三栏的顶栏)。
    <div className="pw-writing-root">
      <div className="pw-writing-body">
        <div className={`pw-writing-left${leftCollapsed ? " is-collapsed" : ""}`}>
          {/* 左栏顶部贴顶拖拽条(避让 macOS 红绿灯)+ 返回按钮 + 折叠按钮。取代原横跨三栏的顶栏。 */}
          <div className="pw-writing-left-titlebar ds-drag">
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
            {/* 折叠按钮紧跟返回,与被折叠的对象同在左栏。
                注意只有**展开态**能放这儿:.pw-writing-left.is-collapsed 是 display:none,
                折叠后整条 titlebar 一起消失 —— 展开入口由中栏顶栏那个按钮承担
                (WritingToolbar 里那个只在 leftCollapsed 时渲染,两者互补不重复)。 */}
            <button
              type="button"
              className="pw-writing-left-toggle ds-no-drag"
              title="折叠侧栏"
              aria-label="折叠侧栏"
              onClick={() => setLeftCollapsed(true)}
            >
              <Icon.Sidebar size={15} />
            </button>
          </div>
          <WritingSidebar
            onToast={setToast}
            onRegisterRefresh={(fn) => {
              refreshTreeRef.current = fn;
            }}
          />
        </div>
        <div
          className="pw-writing-center"
          // 排版 CSS 变量:字号/字体/行距经此作用于中栏四档编辑器与预览(设置节/顶栏步进 → 变量 → 生效)。
          style={
            {
              ["--pw-writing-font-size" as string]: `${fontSizePx}px`,
              ["--pw-writing-font-family" as string]: fontFamily,
              ["--pw-writing-line-height" as string]: `${lineHeight}`,
            } as CSSProperties
          }
        >
          <WritingEditorPane
            ref={editorRef}
            path={currentFile}
            onToast={setToast}
            spaceRoot={activeSpace?.root}
            mode={previewMode}
            onModeChange={setPreviewMode}
            fontSizePx={fontSizePx}
            onFontSizeChange={setFontSizePx}
            leftCollapsed={leftCollapsed}
            onToggleLeft={() => setLeftCollapsed((v) => !v)}
            // 传实际显示值(而非用户意图):窄窗被自动收起时,工具栏 sparkles 状态与实际一致。
            assistantOpen={assistantVisible}
            onToggleAssistant={toggleAssistant}
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
            // PDF 文本层选区(U5):直接给写作选区快照(sourceKind=pdf + 页码),与 CM 选区汇入同一 state。
            onPdfSelectionChange={setSelection}
            // 脏态遇外部改动的冲突审阅入口:基线=编辑器当前内容,新版=盘上内容(复用同一 diff 通道)。
            onConflict={({ path, baseline, disk }) =>
              useWritingReviewStore
                .getState()
                .beginReview({ path, baseline, next: disk, origin: "conflict" })
            }
          />
        </div>
        <div className={`pw-writing-right${assistantVisible ? "" : " is-hidden"}`}>
          <WritingAssistantPanel
            space={activeSpace}
            activeFilePath={currentFile}
            // 编辑器实时选区(R11):有选区时润色卡/引用按钮解禁。
            selection={selection}
            hasPendingReview={hasPendingReview}
            onFlushBeforeSend={() => editorRef.current?.flushNow()}
            // edit 类快捷指令:对当前选区就地改写(→ 红绿 diff 审阅)。返回结果供面板提示。
            onRunInlineEdit={(instruction) =>
              editorRef.current?.runInlineEditOnSelection(instruction) ??
              Promise.resolve({ ok: false, reason: "no-editor" })
            }
            onToast={setToast}
            // 面板顶栏折叠按钮(对齐 Kun):与工具栏 sparkles 开关共用同一 assistantOpen。
            onCollapse={() => setAssistantOpen(false)}
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
