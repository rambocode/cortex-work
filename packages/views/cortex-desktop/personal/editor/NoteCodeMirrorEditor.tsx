// 闪记写作面的 CodeMirror 6 编辑器(源码 / 实时预览两档共用一个实例)。移植自 Kun
// src/renderer/src/components/write/WriteMarkdownEditor.tsx,精简掉续写(inline-completion)、
// 术语联动、图片粘贴、选区浮动工具条、handleRef 等 Kun 专属能力(计划 U3/KTD6)。
//
// 全部 @codemirror/* 与本地 live-preview 扩展都在 useEffect 内动态 import —— views 同时被
// Next.js(web) 打包,顶层 import 会把编辑器卷进 web 产物(KTD3,平移 MonacoViewer 范式)。
// 类型用 `import type`(运行期擦除,不进打包图)。

import { useEffect, useRef } from "react";
import { extractClipboardImageFile } from "@cortex-work/core/writing/paste-image";
import type { AnnotationType, Compartment, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

type EditorSelectionFactory = typeof import("@codemirror/state").EditorSelection;

export type NoteEditorAppearance = "source" | "live";

// 编辑器选区快照:文本 + 字符偏移(from/to)+ 1-based 起止行号。空选区(from===to)上报 null。
// 写作工作区据此解禁「引用选中/润色」(R11);闪记等既有调用方不传该 prop,零改动。
export interface NoteEditorSelection {
  text: string;
  from: number;
  to: number;
  startLine: number;
  endLine: number;
}

type Props = {
  value: string;
  appearance: NoteEditorAppearance;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  // CodeMirror 动态装载失败时回调(弱网/损坏分包等)。调用方据此降级(如切到仅预览 + 提示)。
  onLoadError?: (err: unknown) => void;
  // 选区变化上报(可选):有选区传快照,空选区传 null。不传则不做选区计算(闪记无此需求)。
  onSelectionChange?: (selection: NoteEditorSelection | null) => void;
  // 粘贴图片落盘(U1,可选):写作 live/source 档注入。给剪贴板图片 File,返回要插入的相对 md 链接
  // (调用方已换算好,如 img/x.png);返回 null → 保存失败不插入。闪记不传该 prop → 零改动,走默认粘贴。
  onPasteImage?: (file: File) => Promise<string | null>;
};

export function NoteCodeMirrorEditor({
  value,
  appearance,
  readOnly = false,
  onChange,
  onSave,
  onLoadError,
  onSelectionChange,
  onPasteImage,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartmentRef = useRef<Compartment | null>(null);
  const livePreviewCompartmentRef = useRef<Compartment | null>(null);
  const editableCompartmentRef = useRef<Compartment | null>(null);
  // live-preview 扩展工厂与外部同步 annotation 在异步装载后才可用,经 ref 暴露给后续 effect。
  const buildLiveExtensionsRef = useRef<(() => Extension[]) | null>(null);
  const buildEditableExtensionsRef = useRef<((readOnly: boolean, appearance: NoteEditorAppearance) => Extension[]) | null>(null);
  const buildThemeRef = useRef<((appearance: NoteEditorAppearance) => Extension) | null>(null);
  const externalSyncAnnotationRef = useRef<AnnotationType<boolean> | null>(null);
  // EditorSelection 工厂(外部 value 同步保选区用),挂载时填入。
  const editorSelectionRef = useRef<EditorSelectionFactory | null>(null);

  // 回调与最新 props 走 ref,避免重建编辑器;异步装载完成时读到的也是最新值。
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const appearanceRef = useRef(appearance);
  const readOnlyRef = useRef(readOnly);
  const valueRef = useRef(value);
  const lastEmittedValueRef = useRef<string | null>(null);
  const onLoadErrorRef = useRef(onLoadError);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onPasteImageRef = useRef(onPasteImage);
  // 上次上报的选区签名(from:to),避免同一选区重复派发(光标移动会触发大量 selectionSet)。
  const lastSelectionKeyRef = useRef<string | null>(null);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  appearanceRef.current = appearance;
  readOnlyRef.current = readOnly;
  valueRef.current = value;
  onLoadErrorRef.current = onLoadError;
  onSelectionChangeRef.current = onSelectionChange;
  onPasteImageRef.current = onPasteImage;

  // 挂载一次:动态装载 CodeMirror + 本地扩展,建编辑器实例。
  useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    if (!host) return;

    void (async () => {
      let mods;
      try {
        const [state, view, commands, langMarkdown, languageData, language, livePreview] = await Promise.all([
          import("@codemirror/state"),
          import("@codemirror/view"),
          import("@codemirror/commands"),
          import("@codemirror/lang-markdown"),
          import("@codemirror/language-data"),
          import("@codemirror/language"),
          import("./markdownLivePreview"),
        ]);
        mods = { state, view, commands, langMarkdown, languageData, language, livePreview };
      } catch (err) {
        // 装载失败(弱网/损坏分包/CSP):保留诊断并上抛,让 FlashNoteEditor 降级(切「仅预览」+ 提示)。
        console.error("[notes] CodeMirror 动态装载失败", err);
        if (!disposed) onLoadErrorRef.current?.(err);
        return;
      }
      if (disposed || !hostRef.current) return;

      const { EditorState, EditorSelection, Annotation, Compartment } = mods.state;
      const { EditorView, keymap, drawSelection, highlightActiveLine } = mods.view;
      const { defaultKeymap, history, historyKeymap, indentWithTab } = mods.commands;
      const { markdown, markdownLanguage } = mods.langMarkdown;
      const { languages } = mods.languageData;
      const { bracketMatching, indentOnInput } = mods.language;
      const { writeMarkdownLivePreviewExtensions } = mods.livePreview;

      const themeCompartment = new Compartment();
      const livePreviewCompartment = new Compartment();
      const editableCompartment = new Compartment();
      const externalSyncAnnotation = Annotation.define<boolean>();
      themeCompartmentRef.current = themeCompartment;
      livePreviewCompartmentRef.current = livePreviewCompartment;
      editableCompartmentRef.current = editableCompartment;
      externalSyncAnnotationRef.current = externalSyncAnnotation;

      const buildTheme = (mode: NoteEditorAppearance) => {
        const sourceMode = mode === "source";
        return EditorView.theme({
          "&": {
            height: "100%",
            minWidth: "0",
            minHeight: "0",
            color: "var(--text-1)",
            backgroundColor: "transparent",
            fontFamily: sourceMode
              ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
              : "var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Noto Sans SC', sans-serif)",
            fontSize: sourceMode ? "14px" : "16px",
          },
          ".cm-scroller": { overflow: "auto", lineHeight: "1.75", backgroundColor: "transparent" },
          ".cm-content": {
            minHeight: "100%",
            // 三档统一版心:满宽 + 左右各留 70px。横向 70px 与「仅预览」的 .pw-todo-md 对齐;
            // 满宽由 CSS .pw-note-cm-host .cm-content(max-width:none)提供。
            padding: "clamp(28px, 5vh, 56px) 70px 120px",
            caretColor: "var(--accent)",
          },
          ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
          ".cm-selectionBackground": { backgroundColor: "var(--accent-soft)" },
          ".cm-content::selection, .cm-content *::selection": { backgroundColor: "var(--accent-soft)" },
          ".cm-gutters": { display: "none" },
          ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--text-1) 3%, transparent)" },
        });
      };

      const buildEditable = (ro: boolean, mode: NoteEditorAppearance) => [
        EditorState.readOnly.of(ro),
        EditorView.editable.of(!ro),
        EditorView.contentAttributes.of({
          spellcheck: ro ? "false" : "true",
          autocorrect: ro ? "off" : "on",
          autocapitalize: ro ? "off" : "sentences",
          "data-note-editor-mode": mode,
        }),
      ];

      const buildLive = () => writeMarkdownLivePreviewExtensions();

      buildThemeRef.current = buildTheme;
      buildEditableExtensionsRef.current = buildEditable;
      buildLiveExtensionsRef.current = buildLive;

      const initialAppearance = appearanceRef.current;
      const state = EditorState.create({
        doc: valueRef.current,
        extensions: [
          themeCompartment.of(buildTheme(initialAppearance)),
          livePreviewCompartment.of(initialAppearance === "live" ? buildLive() : []),
          editableCompartment.of(buildEditable(readOnlyRef.current, initialAppearance)),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          history(),
          drawSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          EditorView.lineWrapping,
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
            {
              key: "Mod-s",
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            // 选区上报:文档或选区变化时都重算。空选区(from===to)上报 null,同一选区去重不重复派发。
            if (onSelectionChangeRef.current && (update.selectionSet || update.docChanged)) {
              const { from, to } = update.state.selection.main;
              const key = `${from}:${to}`;
              if (key !== lastSelectionKeyRef.current) {
                lastSelectionKeyRef.current = key;
                if (from === to) {
                  onSelectionChangeRef.current(null);
                } else {
                  const doc = update.state.doc;
                  onSelectionChangeRef.current({
                    text: doc.sliceString(from, to),
                    from,
                    to,
                    startLine: doc.lineAt(from).number, // 1-based
                    endLine: doc.lineAt(to).number,
                  });
                }
              }
            }
            if (!update.docChanged) return;
            const isExternalSync = update.transactions.some((t) => t.annotation(externalSyncAnnotation));
            if (isExternalSync) return;
            const next = update.state.doc.toString();
            lastEmittedValueRef.current = next;
            onChangeRef.current(next);
          }),
          // 粘贴图片(U1):仅在注入了 onPasteImage(写作 live/source)且剪贴板含图片文件时拦截。
          // 落盘后把 ![](相对链接) 插到当前选区(经 updateListener 触发 onChange→自动保存)。
          // 只读 / 无 handler / 非图片粘贴 → return false 放行默认粘贴,不影响文本粘贴与闪记(零改动)。
          EditorView.domEventHandlers({
            paste: (event, view) => {
              const handler = onPasteImageRef.current;
              if (readOnlyRef.current || !handler) return false;
              const picked = extractClipboardImageFile(event.clipboardData?.items);
              if (!picked) return false;
              event.preventDefault();
              void handler(picked.file)
                .then((rel) => {
                  if (!rel || view.dom.isConnected === false) return;
                  const snippet = `![](${rel})`;
                  const { from, to } = view.state.selection.main;
                  view.dispatch({
                    changes: { from, to, insert: snippet },
                    selection: { anchor: from + snippet.length },
                  });
                })
                .catch(() => {
                  /* 保存失败:静默(上层经 bridge 调用处 toast),不阻断编辑 */
                });
              return true;
            },
          }),
        ],
      });

      const view = new EditorView({ state, parent: hostRef.current });
      viewRef.current = view;
      lastEmittedValueRef.current = valueRef.current;
      // 暴露给 EditorSelection 使用的引用(外部 value 同步 effect 需要)。
      editorSelectionRef.current = EditorSelection;
    })();

    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
      themeCompartmentRef.current = null;
      livePreviewCompartmentRef.current = null;
      editableCompartmentRef.current = null;
      externalSyncAnnotationRef.current = null;
      editorSelectionRef.current = null;
    };
    // 挂载一次;props 变化由下方 effect 经 compartment / 外部同步处理。
  }, []);

  // appearance / readOnly 变化 → 重配 compartment(不重建实例,不丢光标/滚动)。
  useEffect(() => {
    const view = viewRef.current;
    const themeCompartment = themeCompartmentRef.current;
    const livePreviewCompartment = livePreviewCompartmentRef.current;
    const editableCompartment = editableCompartmentRef.current;
    const buildTheme = buildThemeRef.current;
    const buildEditable = buildEditableExtensionsRef.current;
    const buildLive = buildLiveExtensionsRef.current;
    if (!view || !themeCompartment || !livePreviewCompartment || !editableCompartment) return;
    if (!buildTheme || !buildEditable || !buildLive) return;
    view.dispatch({
      effects: [
        themeCompartment.reconfigure(buildTheme(appearance)),
        livePreviewCompartment.reconfigure(appearance === "live" ? buildLive() : []),
        editableCompartment.reconfigure(buildEditable(readOnly, appearance)),
      ],
    });
  }, [appearance, readOnly]);

  // 外部 value 变化 → 同步进文档(带 externalSync annotation,不回灌触发 onChange)。
  useEffect(() => {
    const view = viewRef.current;
    const annotation = externalSyncAnnotationRef.current;
    const EditorSelection = editorSelectionRef.current;
    if (!view || !annotation || !EditorSelection) return;
    // 通常来自自身 onChange 回灌,引用相等即跳过,免每次按键全文比对。
    if (value === lastEmittedValueRef.current) return;
    const current = view.state.doc.toString();
    if (current === value) {
      lastEmittedValueRef.current = value;
      return;
    }
    const nextLength = value.length;
    const { anchor, head } = view.state.selection.main;
    lastEmittedValueRef.current = value;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: annotation.of(true),
      selection: EditorSelection.single(Math.min(anchor, nextLength), Math.min(head, nextLength)),
    });
  }, [value]);

  return <div ref={hostRef} className="pw-note-cm-host" />;
}
