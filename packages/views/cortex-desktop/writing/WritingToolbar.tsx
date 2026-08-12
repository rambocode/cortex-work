// 写作工作区中栏顶部工具栏(视觉与交互对齐 Kun WriteWorkspaceToolbar):
//   自左向右:折叠左栏 | 文件名(粗体)/下方相对路径(与文件名相同则省)+ 字数 badge |
//     视图模式 pill(仅图标 + 下拉,档名在菜单项里;列 rich/live/preview/source 四档)| 字号下拉(当前值 + 预设档)|
//     sparkles(切右侧助手栏)| 保存按钮(状态并入图标)| 导出下拉(仅图标)。
// 占位克制:标题栏横向空间紧张,故控件一律走「图标 + 下拉」而非「图标 + 文字」;
//   保存状态**不常驻**——成功后短暂显示对勾即回落普通图标,不长期占一块位置(状态文案仍在 title 里)。
// 纯展示壳:文件名/字数/保存状态/模式/字号等由 WritingEditorPane 计算后注入;折叠与助手切换由
//   WritingWorkspace 注入(standalone 编辑器场景不传 → 对应按钮不渲染)。图标全用 lucide-react,与 Kun 对齐。
import { useEffect, useState, type ReactElement } from "react";
import {
  AlertCircle,
  Check,
  Crosshair,
  ChevronDown,
  Copy,
  Download,
  Eye,
  FileCode2,
  FilePenLine,
  Loader2,
  PanelLeft,
  Save,
  Sparkles,
  Type,
} from "lucide-react";
import {
  WRITING_FONT_SIZE_MAX,
  WRITING_FONT_SIZE_MIN,
  type WritingPreviewMode,
} from "@cortex-work/core/writing/spaces";
import { useDismissableMenu } from "../personal/shared/useDismissableMenu";

// 四档视图的图标 + 展示名(rich 富文本置首,默认档)。
const MODE_ITEMS: { mode: WritingPreviewMode; label: string; icon: ReactElement }[] = [
  { mode: "rich", label: "富文本", icon: <Type size={16} strokeWidth={1.85} /> },
  { mode: "live", label: "实时预览", icon: <FilePenLine size={16} strokeWidth={1.85} /> },
  { mode: "preview", label: "仅预览", icon: <Eye size={16} strokeWidth={1.85} /> },
  { mode: "source", label: "源码", icon: <FileCode2 size={16} strokeWidth={1.85} /> },
];

// 保存状态 → 保存按钮图标的形态/配色(CSS 按 data-status 上色)。
type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

// 字号下拉的预设档(取代原来的 − / + 步进器,省一半横向占位)。
// 只列常用档;持久化里的任意值仍原样显示在触发器上(不在档位里也不会被改写)。
const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 40, 48].filter(
  (px) => px >= WRITING_FONT_SIZE_MIN && px <= WRITING_FONT_SIZE_MAX,
);

// 「已保存」提示的驻留时长:短暂闪一下就回落,不在标题栏长期占位。
const SAVED_HINT_MS = 1600;

export interface WritingToolbarProps {
  fileName: string;
  fileLabel: string;
  charCount: number | null;
  hasTextFile: boolean;
  mode: WritingPreviewMode;
  onModeChange: (m: WritingPreviewMode) => void;
  // 编辑器装载失败被迫仅预览:锁定模式切换(仅 preview 可用)。
  modeLocked?: boolean;
  fontSizePx: number;
  onFontSizeChange?: (px: number) => void;
  saveStatus: SaveStatus;
  saveLabel: string;
  // 聚焦模式：开启后中栏只有光标所在行正常显色，其余内容变灰（不传 onFocusModeChange 则不渲染开关）。
  focusMode?: boolean;
  onFocusModeChange?: (on: boolean) => void;
  onSave: () => void;
  saveDisabled?: boolean;
  // 以下由 WritingWorkspace 注入;standalone 编辑器不传则对应控件不渲染。
  leftCollapsed?: boolean;
  onToggleLeft?: () => void;
  assistantOpen?: boolean;
  onToggleAssistant?: () => void;
  onCopyMarkdown?: () => void;
  onExportMarkdownCopy?: () => void;
  // 重型导出(U6):各项由 WritingEditorPane 注入(bridge 具备对应能力时才传;缺则该项不渲染)。
  onExportDocx?: () => void;
  onExportPdf?: () => void;
  onExportHtml?: () => void;
  onExportPng?: () => void;
  onCopyRichText?: () => void;
}

export function WritingToolbar({
  fileName,
  fileLabel,
  charCount,
  hasTextFile,
  mode,
  onModeChange,
  modeLocked = false,
  fontSizePx,
  onFontSizeChange,
  saveStatus,
  saveLabel,
  onSave,
  saveDisabled = false,
  focusMode = false,
  onFocusModeChange,
  leftCollapsed = false,
  onToggleLeft,
  assistantOpen = true,
  onToggleAssistant,
  onCopyMarkdown,
  onExportMarkdownCopy,
  onExportDocx,
  onExportPdf,
  onExportHtml,
  onExportPng,
  onCopyRichText,
}: WritingToolbarProps): ReactElement {
  const modeMenu = useDismissableMenu();
  const exportMenu = useDismissableMenu();
  const fontMenu = useDismissableMenu();
  // 「已保存」不常驻:落盘成功后对勾闪 SAVED_HINT_MS 就回落普通保存图标。
  // status 从别的态再回到 saved(下一次保存)时 effect 重跑,提示会再闪一次。
  const [savedHint, setSavedHint] = useState(false);
  useEffect(() => {
    if (saveStatus !== "saved") {
      setSavedHint(false);
      return;
    }
    setSavedHint(true);
    const timer = setTimeout(() => setSavedHint(false), SAVED_HINT_MS);
    return () => clearTimeout(timer);
  }, [saveStatus]);
  const current = MODE_ITEMS.find((m) => m.mode === mode) ?? MODE_ITEMS[0]!;
  const modeDisabled = !hasTextFile || modeLocked;
  // 有任一导出/复制能力即展示导出下拉;各项在菜单内按注入与否单独渲染。
  const hasHeavyExport = !!(onExportDocx || onExportPdf || onExportHtml || onExportPng || onCopyRichText);
  const canExport = hasTextFile && (onCopyMarkdown || onExportMarkdownCopy || hasHeavyExport);

  return (
    // 左栏折叠时,中栏工具栏移到窗口最左 → 加红绿灯安全内缩(is-inset)。
    <header className={`pw-wt${leftCollapsed && onToggleLeft ? " is-inset" : ""}`}>
      <div className="pw-wt-left">
        {/* 只在折叠态渲染:展开态的折叠按钮已移到左栏顶部(返回按钮右边,与被折叠的对象同侧)。
            左栏折叠后整条 display:none,这里就是唯一能把它展开的入口。 */}
        {onToggleLeft && leftCollapsed ? (
          <button
            type="button"
            className="pw-wt-icon-btn"
            onClick={onToggleLeft}
            title="展开侧栏"
            aria-label="展开侧栏"
          >
            <PanelLeft size={16} strokeWidth={1.75} />
          </button>
        ) : null}
        {/* 文件名前不再放图标:标题本身已足够表意,图标只是重复占宽。 */}
        <div className="pw-wt-file-meta">
          <div className="pw-wt-file-name" title={fileName}>
            {fileName}
          </div>
          <div className="pw-wt-file-sub">
            {/* fileLabel 是相对空间根的路径。文件就在根目录时它恰好等于文件名,那行小字
                就成了标题的重复(用户实测反馈),此时省略;在子目录里仍显示以保留定位信息。 */}
            {fileLabel !== fileName ? (
              <span className="pw-wt-file-path" title={fileLabel}>
                {fileLabel}
              </span>
            ) : null}
            {charCount != null ? (
              <span className="pw-wt-count">{`字数 ${charCount}`}</span>
            ) : null}
          </div>
        </div>
      </div>

      {/* 视图模式 pill + 下拉 */}
      <div className="pw-wt-modes" ref={modeMenu.wrapRef}>
        <button
          type="button"
          className="pw-wt-mode-pill"
          disabled={modeDisabled}
          onClick={() => modeMenu.setOpen((v) => !v)}
          title={`视图模式：${current.label}`}
          aria-label={`视图模式：${current.label}`}
          aria-haspopup="menu"
          aria-expanded={modeMenu.open}
        >
          {/* 触发器只显示当前档的图标 + chevron:档名在展开的菜单项里给（icon + 文字），
              收起后省下的横向空间留给右侧的字号/导出等控件。title/aria 仍带档名，
              不靠图标形状传达语义。 */}
          {current.icon}
          <ChevronDown size={14} strokeWidth={1.9} className={modeMenu.open ? "is-open" : ""} />
        </button>
        {modeMenu.open ? (
          <div className="pw-wt-menu pw-wt-mode-menu" role="menu">
            {MODE_ITEMS.map((item) => {
              // 装载失败时仅 preview 可选,其它档禁用。
              const itemDisabled = modeLocked && item.mode !== "preview";
              return (
                <button
                  key={item.mode}
                  type="button"
                  role="menuitem"
                  className={`pw-wt-menu-item${item.mode === mode ? " is-active" : ""}`}
                  disabled={itemDisabled}
                  onClick={() => {
                    onModeChange(item.mode);
                    modeMenu.setOpen(false);
                  }}
                >
                  <span className="pw-wt-menu-item-l">
                    {item.icon}
                    <span>{item.label}</span>
                  </span>
                  {item.mode === mode ? <span className="pw-wt-menu-on">ON</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="pw-wt-actions">
        {/* 字号下拉(取代 − / + 步进器:同样的功能,一半的占位) */}
        {hasTextFile ? (
          <div className="pw-wt-font" ref={fontMenu.wrapRef}>
            <button
              type="button"
              className="pw-wt-font-trigger"
              title={`编辑器字号：${fontSizePx}px`}
              aria-label="编辑器字号"
              aria-haspopup="menu"
              aria-expanded={fontMenu.open}
              onClick={() => fontMenu.setOpen((v) => !v)}
            >
              <span className="pw-wt-font-val">{fontSizePx}</span>
              <ChevronDown size={12} strokeWidth={1.9} className={fontMenu.open ? "is-open" : ""} />
            </button>
            {fontMenu.open ? (
              <div className="pw-wt-menu pw-wt-font-menu" role="menu">
                {FONT_SIZE_OPTIONS.map((px) => (
                  <button
                    key={px}
                    type="button"
                    role="menuitemradio"
                    aria-checked={px === fontSizePx}
                    className={`pw-wt-menu-item${px === fontSizePx ? " is-active" : ""}`}
                    onClick={() => {
                      onFontSizeChange?.(px);
                      fontMenu.setOpen(false);
                    }}
                  >
                    <span className="pw-wt-menu-item-l">{`${px} px`}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 聚焦模式开关:仅文本档有光标概念,纯预览档不渲染 */}
        {onFocusModeChange && hasTextFile ? (
          <button
            type="button"
            className={`pw-wt-icon-btn${focusMode ? " is-on" : ""}`}
            onClick={() => onFocusModeChange(!focusMode)}
            title={focusMode ? "退出聚焦模式" : "聚焦模式：只高亮当前行"}
            aria-label={focusMode ? "退出聚焦模式" : "开启聚焦模式"}
            aria-pressed={focusMode}
          >
            <Crosshair size={16} strokeWidth={1.85} />
          </button>
        ) : null}

        {/* 助手栏开合 */}
        {onToggleAssistant ? (
          <button
            type="button"
            className={`pw-wt-icon-btn${assistantOpen ? " is-on" : ""}`}
            onClick={onToggleAssistant}
            title={assistantOpen ? "隐藏写作助手" : "显示写作助手"}
            aria-label={assistantOpen ? "隐藏写作助手" : "显示写作助手"}
            aria-pressed={assistantOpen}
          >
            <Sparkles size={16} strokeWidth={1.85} />
          </button>
        ) : null}

        {/* 手动保存:状态并入这一个图标(保存中转圈 / 刚存好打勾 / 出错告警 / 有改动带点),
            状态文案只进 title,不再单独占一块常驻 pill。 */}
        <button
          type="button"
          className="pw-wt-icon-btn pw-wt-save-btn"
          data-status={savedHint ? "saved-hint" : saveStatus}
          onClick={onSave}
          disabled={saveDisabled}
          title={`保存（${saveLabel}）`}
          aria-label={`保存，当前状态：${saveLabel}`}
        >
          {saveStatus === "error" ? (
            <AlertCircle size={16} strokeWidth={1.85} />
          ) : saveStatus === "saving" ? (
            <Loader2 size={16} strokeWidth={1.85} className="pw-wt-spin" />
          ) : savedHint ? (
            <Check size={16} strokeWidth={2} />
          ) : (
            <Save size={16} strokeWidth={1.85} />
          )}
        </button>

        {/* 导出下拉(复制 Markdown / 导出 .md 副本) */}
        {canExport ? (
          <div className="pw-wt-export" ref={exportMenu.wrapRef}>
            <button
              type="button"
              className="pw-wt-menu-btn"
              onClick={() => exportMenu.setOpen((v) => !v)}
              title="导出"
              aria-label="导出"
              aria-haspopup="menu"
              aria-expanded={exportMenu.open}
            >
              {/* 只留图标:文字「导出」在标题栏里是纯占位,语义由 title/aria-label 承担。 */}
              <Download size={16} strokeWidth={1.85} />
            </button>
            {exportMenu.open ? (
              <div className="pw-wt-menu pw-wt-export-menu" role="menu">
                {onCopyMarkdown ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="pw-wt-menu-item"
                    onClick={() => {
                      onCopyMarkdown();
                      exportMenu.setOpen(false);
                    }}
                  >
                    <span className="pw-wt-menu-item-l">复制全文(Markdown)</span>
                    <Copy size={14} strokeWidth={1.9} className="pw-wt-menu-item-icon" />
                  </button>
                ) : null}
                {onExportMarkdownCopy ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="pw-wt-menu-item"
                    onClick={() => {
                      onExportMarkdownCopy();
                      exportMenu.setOpen(false);
                    }}
                  >
                    <span className="pw-wt-menu-item-l">导出 .md 副本…</span>
                    <span className="pw-wt-menu-item-tag">md</span>
                  </button>
                ) : null}
                {/* 重型导出(U6):复制富文本 + DOCX/PDF/HTML/PNG。各项 bridge 具备时才注入渲染。 */}
                {onCopyRichText ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="pw-wt-menu-item"
                    onClick={() => {
                      onCopyRichText();
                      exportMenu.setOpen(false);
                    }}
                  >
                    <span className="pw-wt-menu-item-l">复制富文本</span>
                    <Copy size={14} strokeWidth={1.9} className="pw-wt-menu-item-icon" />
                  </button>
                ) : null}
                {onExportDocx ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="pw-wt-menu-item"
                    onClick={() => {
                      onExportDocx();
                      exportMenu.setOpen(false);
                    }}
                  >
                    <span className="pw-wt-menu-item-l">导出 Word…</span>
                    <span className="pw-wt-menu-item-tag">docx</span>
                  </button>
                ) : null}
                {onExportPdf ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="pw-wt-menu-item"
                    onClick={() => {
                      onExportPdf();
                      exportMenu.setOpen(false);
                    }}
                  >
                    <span className="pw-wt-menu-item-l">导出 PDF…</span>
                    <span className="pw-wt-menu-item-tag">pdf</span>
                  </button>
                ) : null}
                {onExportHtml ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="pw-wt-menu-item"
                    onClick={() => {
                      onExportHtml();
                      exportMenu.setOpen(false);
                    }}
                  >
                    <span className="pw-wt-menu-item-l">导出 HTML…</span>
                    <span className="pw-wt-menu-item-tag">html</span>
                  </button>
                ) : null}
                {onExportPng ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="pw-wt-menu-item"
                    onClick={() => {
                      onExportPng();
                      exportMenu.setOpen(false);
                    }}
                  >
                    <span className="pw-wt-menu-item-l">导出图片…</span>
                    <span className="pw-wt-menu-item-tag">png</span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}
