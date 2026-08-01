// 写作工作区中栏顶部工具栏(视觉与交互对齐 Kun WriteWorkspaceToolbar):
//   自左向右:折叠左栏 | 文件名(粗体)/下方相对路径(与文件名相同则省)+ 字数 badge |
//     视图模式 pill(仅图标 + 下拉,档名在菜单项里;列 rich/live/preview/source 四档)| 字号步进器(− px +)|
//     sparkles(切右侧助手栏)| 保存按钮 | 保存状态字 | 导出下拉(复制 Markdown / 导出 .md 副本)。
// 纯展示壳:文件名/字数/保存状态/模式/字号等由 WritingEditorPane 计算后注入;折叠与助手切换由
//   WritingWorkspace 注入(standalone 编辑器场景不传 → 对应按钮不渲染)。图标全用 lucide-react,与 Kun 对齐。
import { type ReactElement } from "react";
import {
  ChevronDown,
  Copy,
  Download,
  Eye,
  FileCode2,
  FilePenLine,
  Minus,
  PanelLeft,
  Plus,
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

// 保存状态 → 状态 pill 的配色 data 值(CSS 按 data-status 上色,绿=已保存,对齐 Kun)。
type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

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
        {/* 字号步进器 */}
        {hasTextFile ? (
          <div className="pw-wt-font" role="group" aria-label="编辑器字号">
            <button
              type="button"
              className="pw-wt-font-btn"
              title="减小字号"
              aria-label="减小字号"
              disabled={fontSizePx <= WRITING_FONT_SIZE_MIN}
              onClick={() => onFontSizeChange?.(fontSizePx - 1)}
            >
              <Minus size={14} strokeWidth={2} />
            </button>
            <span className="pw-wt-font-val">{fontSizePx}</span>
            <button
              type="button"
              className="pw-wt-font-btn"
              title="增大字号"
              aria-label="增大字号"
              disabled={fontSizePx >= WRITING_FONT_SIZE_MAX}
              onClick={() => onFontSizeChange?.(fontSizePx + 1)}
            >
              <Plus size={14} strokeWidth={2} />
            </button>
          </div>
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

        {/* 手动保存 */}
        <button
          type="button"
          className="pw-wt-icon-btn"
          onClick={onSave}
          disabled={saveDisabled}
          title="保存"
          aria-label="保存"
        >
          <Save size={16} strokeWidth={1.85} />
        </button>

        {/* 保存状态字(绿=已保存) */}
        <span className="pw-wt-save" data-status={saveStatus} title="保存状态">
          {saveLabel}
        </span>

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
              <Download size={16} strokeWidth={1.85} />
              <span className="pw-wt-export-label">导出</span>
              <ChevronDown size={14} strokeWidth={1.9} className={exportMenu.open ? "is-open" : ""} />
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
