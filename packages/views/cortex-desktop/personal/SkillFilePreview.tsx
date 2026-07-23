// Skills 面板右侧文件预览:按文件类型分派到既有叶子查看器,与「左侧文件树常驻」组成两栏。
// 与 FilesView 预览的区别:这里不含 git diff / 选区发送到终端 / 右键菜单,只做「看 + 就地编辑保存」。
// - .md/.markdown/.mdx → 默认 MarkdownView 渲染(贴合截图),头部「编辑」切到 textarea + 保存。
// - 其它文本/代码(json/py/ts/txt…)→ MonacoViewer,只读为主,「编辑」切可写 + ⌘S/保存。
// - docx/pdf/pptx → DocumentViewer;xlsx/csv → SheetViewer;图片 → imageReadAny 回读内联 <img>。
// - 其余二进制(压缩/媒体/字体/老 office 等)→ 占位 + 交系统默认程序打开。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import type { DesktopBridge } from "@cortex-work/core";
import {
  FileIcon,
  fileIconSpec,
  inAppDocumentKind,
  isOpenExternalLike,
  isSpreadsheetLike,
} from "./fileIcons";
import { langForName, wordWrapForName } from "./monacoLang";
import { MonacoViewer } from "./MonacoViewer";
import { MarkdownView } from "./MarkdownView";
import { DocumentViewer } from "./DocumentViewer";
import { SheetViewer } from "./sheet/SheetViewer";

const isMarkdownName = (name: string) => /\.(md|markdown|mdx)$/i.test(name);

type PreviewKind = "document" | "sheet" | "image" | "external" | "markdown" | "code";

// 单一职责:把文件名归一到某个预览分支。顺序有讲究——docx/pdf/pptx、xlsx/csv、图片都属于
// isOpenExternalLike 的二进制,必须在 external 兜底之前先被各自的内置查看器拦截。
function previewKind(name: string): PreviewKind {
  if (inAppDocumentKind(name)) return "document";
  if (isSpreadsheetLike(name)) return "sheet";
  if (fileIconSpec(name)?.shape === "image") return "image";
  if (isOpenExternalLike(name)) return "external";
  if (isMarkdownName(name)) return "markdown";
  return "code";
}

function TitleIcon({ name }: { name: string }) {
  return fileIconSpec(name) ? <FileIcon name={name} size={14} /> : <Icon.File size={14} />;
}

// 图片分支:经 bridge.imageReadAny 回读为 dataURL 内联展示(复用 ChatInlineImage 同源能力)。
function ImagePreview({ path, name, bridge }: { path: string; name: string; bridge: DesktopBridge }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = bridge.imageReadAny;
    if (!read) {
      setFailed(true);
      return;
    }
    setDataUrl(null);
    setFailed(false);
    read(path).then(
      (r) => alive && setDataUrl(r.dataUrl),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [path, bridge]);

  if (failed) return <div className="pw-skill-preview-empty">无法读取图片</div>;
  if (!dataUrl) return <div className="pw-skill-preview-empty" aria-busy="true">加载中…</div>;
  return (
    <div className="pw-skill-img">
      <img src={dataUrl} alt={name} />
    </div>
  );
}

export function SkillFilePreview({
  path,
  name,
  bridge,
  onToast,
  onClose,
}: {
  path: string;
  name: string;
  bridge: DesktopBridge;
  onToast: (text: string) => void;
  onClose: () => void;
}) {
  const kind = previewKind(name);
  const isText = kind === "markdown" || kind === "code";

  // 文本类共用的读取/编辑/保存态(沿用原 PromptEditor 逻辑)。非文本类不读文本内容。
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isText) return;
    let cancelled = false;
    setContent(null);
    setDirty(false);
    setEditMode(false);
    setError(null);
    bridge
      .readFile(path)
      .then((res) => {
        if (cancelled) return;
        setContent(res.content);
        setTruncated(res.truncated);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, path, isText]);

  const save = async () => {
    if (content === null || truncated) return;
    try {
      await bridge.writeFile(path, content);
      setDirty(false);
      onToast(`已保存 ${name}`);
    } catch (err) {
      onToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const openExternally = () => {
    void bridge.openPath?.(path).catch((e) => onToast(`打开失败：${e instanceof Error ? e.message : String(e)}`));
  };

  // 可就地编辑保存的类型(文本 + 未截断);二进制/文档/表格不走本头部的编辑按钮。
  const canEdit = isText && !truncated && content !== null;

  return (
    <div className="pw-skill-preview">
      <div className="pw-editor-h pw-file-toolbar">
        <button className="pw-icon-btn" title="返回列表" onClick={onClose}>
          <Icon.Back size={14} />
        </button>
        <TitleIcon name={name} />
        <span className="pw-editor-name" title={path}>
          {name}
          {dirty ? <span className="pw-dirty">●</span> : null}
        </span>
        <div className="spacer" />
        {truncated ? <span className="pw-readonly">文件过大 · 只读</span> : null}
        {canEdit ? (
          editMode ? (
            <button className="pw-ftb-btn is-primary" title="保存" onClick={() => void save()} disabled={!dirty}>
              <Icon.Check size={12} /> 保存
            </button>
          ) : (
            <button className="pw-ftb-btn" title="编辑" onClick={() => setEditMode(true)}>
              <Icon.Edit size={12} /> 编辑
            </button>
          )
        ) : null}
        {bridge.openPath ? (
          <button className="pw-ftb-btn" title="用系统默认程序打开" onClick={openExternally}>
            打开
          </button>
        ) : null}
      </div>

      {kind === "document" ? (
        <div className="pw-skill-doc">
          <DocumentViewer
            kind={inAppDocumentKind(name)!}
            filePath={path}
            fileName={name}
            bridge={bridge}
            onToast={onToast}
          />
        </div>
      ) : kind === "sheet" ? (
        <div className="pw-skill-sheet">
          <SheetViewer filePath={path} fileName={name} bridge={bridge} onToast={onToast} />
        </div>
      ) : kind === "image" ? (
        <ImagePreview path={path} name={name} bridge={bridge} />
      ) : kind === "external" ? (
        <div className="pw-skill-external pw-skill-preview-empty">
          <Icon.File size={22} />
          <div>此文件类型不支持内置预览</div>
          {bridge.openPath ? (
            <button className="btn primary" onClick={openExternally}>
              用系统程序打开
            </button>
          ) : null}
        </div>
      ) : error ? (
        <div className="pw-editor-error">{error}</div>
      ) : content === null ? (
        <div className="pw-editor-loading">加载中…</div>
      ) : kind === "markdown" && !editMode ? (
        // .md 默认渲染态(贴合截图 Description 观感);点「编辑」切到下方 textarea 源码编辑。
        <div className="pw-skill-md">
          <div className="pw-todo-md">
            <MarkdownView content={content} />
          </div>
        </div>
      ) : kind === "markdown" ? (
        <textarea
          className="pw-editor-ta"
          value={content}
          readOnly={truncated}
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
          }}
          spellCheck={false}
        />
      ) : (
        // 代码/纯文本:Monaco 高亮,只读为主,「编辑」切可写。换文件用 key 重挂载。
        <div className="pw-skill-code pw-mona-wrap">
          <MonacoViewer
            key={path}
            value={content}
            language={langForName(name)}
            wordWrap={wordWrapForName(name)}
            readOnly={!editMode}
            onChange={(v) => {
              setContent(v);
              if (editMode) setDirty(v !== content);
            }}
            onSave={() => void save()}
          />
        </div>
      )}
    </div>
  );
}
