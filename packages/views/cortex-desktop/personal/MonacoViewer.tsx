// Monaco 编辑器封装（borrowed from fanbox mona）。整个 views 包里唯一接触
// monaco-editor 的文件,且全部走 useEffect 内动态 import —— views 同时被
// Next.js(web) 打包,顶层 import 会把巨型依赖卷进 web 产物甚至构建失败。
// worker 用 new URL(...) 跨打包器写法,并按 language label 启动 Monaco 自带 worker;
// file:// 下创建失败时 Monaco 自动降级主线程（高亮 tokenizer 本就在主线程,不受影响）。

import { useEffect, useRef } from "react";
import type * as MonacoNS from "monaco-editor";

type MonacoApi = typeof MonacoNS;
type Editor = MonacoNS.editor.IStandaloneCodeEditor;

const THEME_NAME = "cortex-warm";
let themeDefined = false;

function ensureEnvironment(): void {
  const g = globalThis as { MonacoEnvironment?: unknown };
  if (g.MonacoEnvironment) return;
  g.MonacoEnvironment = {
    // language worker 内已注入对应 foreign module factory。若一律返回 editor.worker,
    // HTML/JSON/CSS/TS 会退回 $loadForeignModule 动态 import;ESM worker 没有 AMD
    // require.toUrl,最终在 FileAccessImpl.toUri 触发 undefined.toUrl。
    getWorker: (_workerId: string, label: string) => {
      if (label === "json") {
        return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), {
          type: "module",
        });
      }
      if (label === "css" || label === "scss" || label === "less") {
        return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), {
          type: "module",
        });
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), {
          type: "module",
        });
      }
      if (label === "typescript" || label === "javascript") {
        return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), {
          type: "module",
        });
      }
      return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), {
        type: "module",
      });
    },
  };
}

function ensureTheme(monaco: MonacoApi): void {
  if (themeDefined) return;
  themeDefined = true;
  // 对齐 warm 皮肤（终端 WARM_THEME 同源配色）。
  monaco.editor.defineTheme(THEME_NAME, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#FDF9EF",
      "editor.foreground": "#4a3f30",
      "editorLineNumber.foreground": "#b3a589",
      "editorCursor.foreground": "#cc785c",
      "editor.selectionBackground": "#cc785c33",
      "editor.lineHighlightBackground": "#00000008",
    },
  });
}

// 选区在编辑器内的可视坐标（相对编辑器容器,px）;选区滚出可视区时为 null。
export interface SelectionAnchor {
  left: number;
  top: number;
}

export function MonacoViewer({
  value,
  language,
  readOnly,
  wordWrap = false,
  onChange,
  onSelectionText,
  onSave,
}: {
  value: string; // 初始内容（换文件请用 key 重挂载）
  language: string;
  readOnly: boolean;
  wordWrap?: boolean;
  onChange?: (v: string) => void;
  // 预览态选区变化（空串 = 取消选择）。anchor 是选区末尾下方的可视坐标,
  // 供「发送到终端/Chat」浮动弹窗就地定位;滚动时会带新坐标重新回调。
  onSelectionText?: (text: string, anchor: SelectionAnchor | null) => void;
  onSave?: () => void; // 编辑态 ⌘S
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  // 回调走 ref,避免父组件每次渲染都重建编辑器。
  const cbRef = useRef({ onChange, onSelectionText, onSave });
  cbRef.current = { onChange, onSelectionText, onSave };

  useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    if (!host) return;

    void (async () => {
      let monaco: MonacoApi;
      try {
        ensureEnvironment();
        monaco = await import("monaco-editor");
      } catch {
        return; // 加载失败:保持空白,外层有「用默认应用打开」兜底
      }
      if (disposed || !hostRef.current) return;
      ensureTheme(monaco);

      const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim();
      const editor = monaco.editor.create(hostRef.current, {
        value,
        language,
        theme: THEME_NAME,
        readOnly,
        lineNumbers: "on",
        minimap: { enabled: false },
        automaticLayout: true,
        fontSize: 13,
        lineHeight: 1.7,
        fontFamily: mono || "ui-monospace, Menlo, monospace",
        scrollBeyondLastLine: false,
        renderWhitespace: "none",
        tabSize: 2,
        wordWrap: wordWrap ? "on" : "off",
        smoothScrolling: true,
        contextmenu: false,
      });
      editorRef.current = editor;

      editor.onDidChangeModelContent(() => {
        cbRef.current.onChange?.(editor.getValue());
      });
      // 选区末尾下方的可视坐标;滚出可视区/越界时返回 null（弹窗隐藏）。
      const anchorFor = (selection: MonacoNS.Selection): SelectionAnchor | null => {
        const p = editor.getScrolledVisiblePosition(selection.getEndPosition());
        if (!p) return null;
        const layout = editor.getLayoutInfo();
        const top = p.top + p.height + 6;
        if (p.top < 0 || top > layout.height - 8) return null;
        return { left: Math.max(8, Math.min(p.left, layout.width - 230)), top };
      };
      const emitSelection = () => {
        const model = editor.getModel();
        const selection = editor.getSelection();
        if (!model || !selection) return;
        const text = model.getValueInRange(selection);
        cbRef.current.onSelectionText?.(text, text ? anchorFor(selection) : null);
      };
      editor.onDidChangeCursorSelection(emitSelection);
      // 滚动时让弹窗跟随选区（滚出可视区则隐藏）。
      editor.onDidScrollChange(emitSelection);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        cbRef.current.onSave?.();
      });
    })();

    return () => {
      disposed = true;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
    // value 仅作初始内容;换文件由调用方用 key 重挂载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, wordWrap]);

  // 预览 ↔ 编辑切换不重建编辑器,只翻 readOnly。
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <div className="pw-monaco-host" ref={hostRef} />;
}
