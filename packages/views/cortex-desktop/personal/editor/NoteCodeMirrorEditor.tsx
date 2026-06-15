// 闪记写作面的 CodeMirror 6 编辑器(源码 / 实时预览两档共用一个实例)。移植自 Kun
// src/renderer/src/components/write/WriteMarkdownEditor.tsx,精简掉续写(inline-completion)、
// 术语联动、图片粘贴、选区浮动工具条、handleRef 等 Kun 专属能力(计划 U3/KTD6)。
//
// 全部 @codemirror/* 与本地 live-preview 扩展都在 useEffect 内动态 import —— views 同时被
// Next.js(web) 打包,顶层 import 会把编辑器卷进 web 产物(KTD3,平移 MonacoViewer 范式)。
// 类型用 `import type`(运行期擦除,不进打包图)。

import { useEffect, useRef } from "react";
import type { AnnotationType, Compartment } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

type EditorSelectionFactory = typeof import("@codemirror/state").EditorSelection;

export type NoteEditorAppearance = "source" | "live";

type Props = {
  value: string;
  appearance: NoteEditorAppearance;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
};

export function NoteCodeMirrorEditor({
  value,
  appearance,
  readOnly = false,
  onChange,
  onSave,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartmentRef = useRef<Compartment | null>(null);
  const livePreviewCompartmentRef = useRef<Compartment | null>(null);
  const editableCompartmentRef = useRef<Compartment | null>(null);
  // live-preview 扩展工厂与外部同步 annotation 在异步装载后才可用,经 ref 暴露给后续 effect。
  const buildLiveExtensionsRef = useRef<(() => unknown[]) | null>(null);
  const buildEditableExtensionsRef = useRef<((readOnly: boolean, appearance: NoteEditorAppearance) => unknown[]) | null>(null);
  const buildThemeRef = useRef<((appearance: NoteEditorAppearance) => unknown) | null>(null);
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
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  appearanceRef.current = appearance;
  readOnlyRef.current = readOnly;
  valueRef.current = value;

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
      } catch {
        return; // 装载失败:保持空白,由 FlashNoteEditor 兜底(可切到「仅预览」或源码 textarea fallback)
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
            padding: sourceMode ? "20px 24px 56px" : "clamp(28px, 5vh, 56px) 24px 120px",
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

      buildThemeRef.current = buildTheme as (a: NoteEditorAppearance) => unknown;
      buildEditableExtensionsRef.current = buildEditable as (ro: boolean, a: NoteEditorAppearance) => unknown[];
      buildLiveExtensionsRef.current = buildLive as () => unknown[];

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
            if (!update.docChanged) return;
            const isExternalSync = update.transactions.some((t) => t.annotation(externalSyncAnnotation));
            if (isExternalSync) return;
            const next = update.state.doc.toString();
            lastEmittedValueRef.current = next;
            onChangeRef.current(next);
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
        themeCompartment.reconfigure(buildTheme(appearance) as never),
        livePreviewCompartment.reconfigure((appearance === "live" ? buildLive() : []) as never),
        editableCompartment.reconfigure(buildEditable(readOnly, appearance) as never),
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
