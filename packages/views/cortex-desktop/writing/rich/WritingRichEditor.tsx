// 富文本(rich)模式编辑器:tiptap/ProseMirror 所见即所得,落盘仍是 .md(移植/精简自 Kun WriteRichEditor)。
// 与 NoteCodeMirrorEditor 同款隔离:本组件顶层不 import 任何 @tiptap 运行时,全部在 useEffect 内动态 import,
// tiptap 类型用 `import type`(编译期擦除)。这样 tiptap 只在真正进入 rich 档时加载,不卷进 Next.js web 产物。
//
// 数据安全:进入编辑前先过 auditWriteMarkdownFidelity —— 不能无损往返(超大/解析错/漂移/丢文本)的文档
// 一律拒进富文本、渲染 fallback(CM live),保证磁盘文件不被静默改写。外部快照经 applyExternalMarkdownToEditor
// 做最小块级替换 + external-sync 标记(不当用户改动 re-emit)。onUpdate 把文档序列化回 Markdown 交给上层自动保存。
import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Editor } from "@tiptap/core";
import { extractClipboardImageFile } from "@cortex-work/core/writing/paste-image";
import type { NoteEditorSelection } from "../../personal/editor/NoteCodeMirrorEditor";
import type { WriteRichFidelity } from "./markdown-manager";
import { WritingRichToolbar } from "./WritingRichToolbar";

interface Props {
  // 当前文档 Markdown 源文本(来自上层 draft)。
  value: string;
  // 当前文件绝对路径:作为「开档审计 + 编辑器重建」的 key(切文件重建实例)。
  filePath: string | null;
  readOnly?: boolean;
  // 富文本序列化回 Markdown 后回吐给上层(驱动自动保存)。
  onChange: (markdown: string) => void;
  // 选区上报(与 CM 同 shape;富文本拿不到文档全局行号,startLine 近似为 1、endLine 近似为选区内行数)。
  onSelectionChange?: (selection: NoteEditorSelection | null) => void;
  // Mod-s 保存快捷键。
  onSaveShortcut?: () => void;
  // 保真审计结果回调(上层据此提示 / 记录回落原因)。
  onFidelityChange?: (fidelity: WriteRichFidelity) => void;
  // 序列化失败等错误提示。
  onToast?: (msg: string) => void;
  // tiptap 动态装载失败回调(弱网/损坏分包)。
  onLoadError?: (err: unknown) => void;
  // 本地图片显示解析:把原始(相对)src 解析成可渲染 URL(相对路径 → 绝对 → bridge.imageRead → data URL)。
  // 只影响显示,不影响序列化(节点仍存原始 src),故不破坏往返安全。
  resolveImageSrc?: (rawSrc: string) => Promise<string | null>;
  // 粘贴图片落盘(U1):把剪贴板图片 File 存到空间 img/,返回相对当前 md 的链接文本(如 img/x.png)。
  // 返回 null → 保存失败,不插入。未传该 prop(无 bridge/无空间)→ 不拦截默认粘贴。
  onPasteImage?: (file: File) => Promise<string | null>;
  // 审计不通过时渲染的回落编辑器(通常是 CM live)。
  fallback?: ReactNode;
}

type GateState = { fileKey: string; eligible: boolean };

function fileKeyOf(filePath: string | null): string {
  return (filePath ?? "").trim();
}

export function WritingRichEditor({
  value,
  filePath,
  readOnly = false,
  onChange,
  onSelectionChange,
  onSaveShortcut,
  onFidelityChange,
  onToast,
  onLoadError,
  resolveImageSrc,
  onPasteImage,
  fallback,
}: Props): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  // 上次由本端 emit / 同步进编辑器的值:用于抑制自回声(避免把自己序列化的结果再当外部快照重灌)。
  const lastEmittedValueRef = useRef<string | null>(null);
  const [gate, setGate] = useState<GateState | null>(null);
  const gateRef = useRef<GateState | null>(null);
  gateRef.current = gate;
  // 已建的编辑器实例(state,供浮动工具条使用);选区浮层锚点 + 重渲染信号。
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [selRect, setSelRect] = useState<{ top: number; left: number } | null>(null);
  const [selRev, setSelRev] = useState(0);
  // 是否正在用鼠标拖拽选择:拖拽过程中不显示工具条(否则跟随选区实时移动会抖动),
  // 待 pointerup(松开鼠标)或双击结束后再一次性定位显示。
  const pointerSelectingRef = useRef(false);
  // pointer 监听的卸载器(在异步建编辑器时装上,effect 清理时调用)。
  const pointerCleanupRef = useRef<(() => void) | null>(null);

  // 回调与最新 props 走 ref,避免把它们塞进编辑器重建依赖。
  const readOnlyRef = useRef(readOnly);
  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onSaveShortcutRef = useRef(onSaveShortcut);
  const onFidelityChangeRef = useRef(onFidelityChange);
  const onToastRef = useRef(onToast);
  const onLoadErrorRef = useRef(onLoadError);
  const resolveImageSrcRef = useRef(resolveImageSrc);
  const onPasteImageRef = useRef(onPasteImage);
  readOnlyRef.current = readOnly;
  onChangeRef.current = onChange;
  onSelectionChangeRef.current = onSelectionChange;
  onSaveShortcutRef.current = onSaveShortcut;
  onFidelityChangeRef.current = onFidelityChange;
  onToastRef.current = onToast;
  onLoadErrorRef.current = onLoadError;
  resolveImageSrcRef.current = resolveImageSrc;
  onPasteImageRef.current = onPasteImage;

  const fileKey = fileKeyOf(filePath);
  const eligible = gate?.fileKey === fileKey ? gate.eligible : null;

  // 计算工具条锚点(选区上方居中的视口坐标);空选区或坐标不可得时回 null。
  const computeSelRect = (editor: Editor): { top: number; left: number } | null => {
    const { from, to } = editor.state.selection;
    if (from === to) return null;
    const text = editor.state.doc.textBetween(from, to, "\n", " ");
    if (!text) return null;
    try {
      const start = editor.view.coordsAtPos(from);
      const end = editor.view.coordsAtPos(to);
      return { top: Math.min(start.top, end.top), left: (start.left + end.right) / 2 };
    } catch {
      return null;
    }
  };

  // 选区浮层定位:拖拽选择中隐藏(避免实时抖动),非拖拽(键盘选择/双击/程序化)才更新锚点。
  const updateToolbarAnchor = (editor: Editor): void => {
    if (pointerSelectingRef.current) {
      setSelRect(null);
      return;
    }
    setSelRect(computeSelRect(editor));
    setSelRev((v) => v + 1);
  };

  // 选区变化:①上报选区(即时,供润色/引用;不产生视觉抖动;富文本无廉价全局行号,startLine 近似 1、
  //           endLine 近似 1+换行数);②更新工具条锚点(拖拽中隐藏,松开/双击后显示)。
  const emitSelection = (editor: Editor): void => {
    const cb = onSelectionChangeRef.current;
    const { from, to } = editor.state.selection;
    const text = from === to ? "" : editor.state.doc.textBetween(from, to, "\n", " ");
    if (!text) {
      cb?.(null);
    } else {
      const nl = text.match(/\n/g)?.length ?? 0;
      cb?.({ text, from, to, startLine: 1, endLine: 1 + nl });
    }
    updateToolbarAnchor(editor);
  };

  // 审计每一份「外部来源」的内容(开档 / 盘上被改)。本端自己序列化的输出天然无损,不重复审计。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mm = await import("./markdown-manager");
      if (cancelled) return;
      if (value === lastEmittedValueRef.current && gateRef.current?.fileKey === fileKey) return;
      const fidelity = mm.auditWriteMarkdownFidelity(value);
      onFidelityChangeRef.current?.(fidelity);
      setGate((current) => {
        if (current?.fileKey === fileKey && current.eligible === fidelity.eligible) return current;
        return { fileKey, eligible: fidelity.eligible };
      });
      if (!fidelity.eligible) {
        lastEmittedValueRef.current = null;
        return;
      }
      const editor = editorRef.current;
      if (editor && !editor.isDestroyed) {
        const sync = await import("./markdown-sync");
        if (cancelled) return;
        if (sync.applyExternalMarkdownToEditor(editor, value)) {
          lastEmittedValueRef.current = value;
        }
      }
    })().catch(() => {
      /* 动态 import 失败在下方 build effect 亦会触发 onLoadError */
    });
    return () => {
      cancelled = true;
    };
  }, [value, fileKey]);

  // 审计通过 + host 就绪 + 尚无实例 → 动态装载 tiptap 并建编辑器(每个 eligible 文件建一次)。
  useEffect(() => {
    if (eligible !== true || !hostRef.current) return;
    if (editorRef.current) return;
    let disposed = false;
    let built: Editor | null = null;
    void (async () => {
      let core, mm, sync;
      try {
        [core, mm, sync] = await Promise.all([
          import("@tiptap/core"),
          import("./markdown-manager"),
          import("./markdown-sync"),
        ]);
      } catch (err) {
        console.error("[writing-rich] tiptap 动态装载失败", err);
        if (!disposed) onLoadErrorRef.current?.(err);
        return;
      }
      if (disposed || !hostRef.current) return;

      const { Editor: EditorCtor, Extension } = core;
      const manager = mm.getWriteMarkdownManager();
      // Mod-s 保存扩展(与 CM 的 Mod-s 对齐)。
      const saveShortcut = Extension.create({
        name: "writingRichSave",
        addKeyboardShortcuts() {
          return {
            "Mod-s": () => {
              onSaveShortcutRef.current?.();
              return true;
            },
          };
        },
      });

      const editor = new EditorCtor({
        element: hostRef.current,
        extensions: [
          ...mm.buildWriteRichExtensions({
            // 经 ref 读最新解析器,保持扩展在编辑器生命周期内稳定配置。
            resolveImage: (src) => resolveImageSrcRef.current?.(src) ?? Promise.resolve(null),
          }),
          saveShortcut,
        ],
        content: mm.parseWriteMarkdown(value),
        editable: !readOnlyRef.current,
        editorProps: {
          attributes: {
            class: "write-rich-editor",
            "data-write-editor-mode": "rich",
            spellcheck: readOnlyRef.current ? "false" : "true",
          },
          // 粘贴图片(U1):剪贴板含图片文件且注入了 onPasteImage 时拦截,落盘后插入 image 节点(src=相对链接);
          // 只读、无 handler、或非图片粘贴一律 return false 放行默认粘贴(不影响文本/其它内容粘贴)。
          handlePaste: (_view, event) => {
            const handler = onPasteImageRef.current;
            if (readOnlyRef.current || !handler) return false;
            const picked = extractClipboardImageFile(event.clipboardData?.items);
            if (!picked) return false;
            void handler(picked.file)
              .then((rel) => {
                if (!rel) return;
                const inst = editorRef.current;
                if (inst && !inst.isDestroyed) inst.chain().focus().setImage({ src: rel, alt: "" }).run();
              })
              .catch((err) => {
                onToastRef.current?.(
                  `粘贴图片失败：${err instanceof Error ? err.message : String(err)}`,
                );
              });
            return true;
          },
        },
        onUpdate({ editor: instance, transaction }) {
          // 外部同步事务:只更新选区,不 emit onChange(否则会把 agent/外部刚写的内容按归一化重写回盘)。
          if (transaction.getMeta(sync.WRITING_RICH_EXTERNAL_SYNC_META)) {
            emitSelection(instance);
            return;
          }
          try {
            const markdown = manager.serialize(instance.state.doc.toJSON());
            lastEmittedValueRef.current = markdown;
            onChangeRef.current(markdown);
          } catch (err) {
            onToastRef.current?.(
              `富文本序列化失败：${err instanceof Error ? err.message : String(err)}`,
            );
          }
          emitSelection(instance);
        },
        onSelectionUpdate({ editor: instance }) {
          emitSelection(instance);
        },
      });

      editorRef.current = editor;
      built = editor;
      setActiveEditor(editor);
      lastEmittedValueRef.current = value;
      emitSelection(editor);

      // 鼠标拖拽选择:按下即进入拖拽态并隐藏工具条;松开(pointerup 挂 window,鼠标可能在编辑器外抬起)
      // 后退出拖拽态并对最终选区定位显示。双击选词也会走 pointerdown→pointerup,于抬起时显示。
      const onPointerDown = (): void => {
        pointerSelectingRef.current = true;
        setSelRect(null);
      };
      const onPointerUp = (): void => {
        if (!pointerSelectingRef.current) return;
        pointerSelectingRef.current = false;
        const inst = editorRef.current;
        if (inst && !inst.isDestroyed) updateToolbarAnchor(inst);
      };
      editor.view.dom.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointerup", onPointerUp);
      pointerCleanupRef.current = () => {
        editor.view.dom.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointerup", onPointerUp);
      };
    })();

    return () => {
      disposed = true;
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
      pointerSelectingRef.current = false;
      const editor = built ?? editorRef.current;
      editor?.destroy();
      editorRef.current = null;
      setActiveEditor(null);
      setSelRect(null);
    };
    // 编辑器每 eligible 文件建一次;value/文件变化经上面的审计 effect 流入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, fileKey]);

  // readOnly 变化 → 切换可编辑(不重建实例)。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!readOnly);
  }, [readOnly]);

  // 审计不通过:顶部黄条提示 + 回落编辑器(CM live)。
  if (eligible === false) {
    return (
      <div className="pw-writing-rich-fallback">
        <div className="pw-writing-rich-fallback-note" role="status">
          该文档含富文本无法无损表示的内容,已回落到普通编辑器以保护原文。
        </div>
        <div className="pw-writing-rich-fallback-body">{fallback}</div>
      </div>
    );
  }

  return (
    <>
      <div ref={hostRef} className="pw-writing-rich-host" />
      {/* 选区浮动工具条:仅在可编辑 + 有文本选区时浮现(position:fixed,不占布局) */}
      {activeEditor && selRect && !readOnly ? (
        <WritingRichToolbar
          editor={activeEditor}
          top={selRect.top}
          left={selRect.left}
          revision={selRev}
        />
      ) : null}
    </>
  );
}
