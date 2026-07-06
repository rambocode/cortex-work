// 写作工作区 diff 审阅视图(U6):对「基线 → 盘上新内容」以 @codemirror/merge 的 unifiedMergeView
// 呈现行级红绿 diff,只读,顶部「全部接受 / 全部拒绝」+ 逐块 accept/reject(merge 内置 chunk 控件)。
//
// KTD6:CM 相关包(含 @codemirror/merge)必须动态 import —— views 同时被 Next.js 双打包,顶层 import
// 会把编辑器卷进 web 产物。故本组件在 useEffect 内异步装载 CM,失败则降级为「仅两按钮」(全部接受/拒绝)。
//
// 裁决合成的不变量:全部接受 === 新版(next)、全部拒绝 === 基线(baseline),两条恒等由调用方直接给出,
// 无需读 CM 文档;逐块混合裁决时,待所有 chunk 处理完,读 CM 当前文档为最终合成文本回传 onResolve。
// 顶部两按钮由 React 渲染(不依赖 CM),故降级态仍可完成整体裁决,且逻辑可脱离 CM 单测。

import { useEffect, useRef, useState, type ReactElement } from "react";
import type { EditorView } from "@codemirror/view";

interface Props {
  // 当前审阅文件绝对路径(仅用于 CM key 稳定与展示)。
  path: string;
  // 旧版(diff original)与新版(diff modified)。
  baseline: string;
  next: string;
  // 裁决完成回调:传入最终合成文本(全接受=next、全拒绝=baseline、混合=CM 文档)。
  onResolve: (accepted: string) => void;
}

// merge 装载态:loading→加载中;ready→CM 已挂载可逐块;failed→降级仅两按钮。
type LoadState = "loading" | "ready" | "failed";

export function WritingDiffReview({ path, baseline, next, onResolve }: Props): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  // 最新 props / 回调走 ref:CM 的 updateListener 在异步装载后触发,需读到最新值。
  const baselineRef = useRef(baseline);
  const nextRef = useRef(next);
  const onResolveRef = useRef(onResolve);
  baselineRef.current = baseline;
  nextRef.current = next;
  onResolveRef.current = onResolve;

  // 挂载(按 path 重建):动态装载 CM + merge,建只读 unifiedMergeView。装载失败降级。
  useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    if (!host) return;
    setLoadState("loading");

    void (async () => {
      try {
        const [stateMod, viewMod, langMarkdown, mergeMod] = await Promise.all([
          import("@codemirror/state"),
          import("@codemirror/view"),
          import("@codemirror/lang-markdown"),
          import("@codemirror/merge"),
        ]);
        if (disposed || !hostRef.current) return;
        const { EditorState } = stateMod;
        const { EditorView } = viewMod;
        const { markdown } = langMarkdown;
        const { unifiedMergeView, getChunks } = mergeMod;

        const state = EditorState.create({
          // 文档初始为新版;unifiedMergeView 以 original=基线做对照,渲染红(删)绿(增)。
          doc: nextRef.current,
          extensions: [
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            EditorView.lineWrapping,
            markdown(),
            // gutter:false 收敛版心;逐块 accept/reject 由 merge 内置控件提供(mergeControls 默认开)。
            unifiedMergeView({ original: baselineRef.current, gutter: false }),
            // 逐块裁决把改动逐步并入文档;所有 chunk 处理完 → 读当前文档为最终合成,回传 onResolve。
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return;
              const data = getChunks(update.state);
              if (!data || data.chunks.length === 0) {
                // 微任务延后,避免在派发事务中重入。
                queueMicrotask(() => onResolveRef.current(update.state.doc.toString()));
              }
            }),
          ],
        });
        const view = new EditorView({ state, parent: hostRef.current });
        viewRef.current = view;
        setLoadState("ready");
      } catch (err) {
        // 弱网/损坏分包/CSP/jsdom:降级为仅两按钮,仍可整体裁决(计划 U6 降级契约)。
        console.error("[writing] @codemirror/merge 动态装载失败,降级为整体裁决", err);
        if (!disposed) setLoadState("failed");
      }
    })();

    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [path]);

  return (
    <div className="pw-writing-diff">
      <header className="pw-writing-diff-h" role="group" aria-label="改动审阅">
        <span className="pw-writing-diff-label">审阅改动</span>
        <div className="spacer" />
        {/* 全部拒绝 === 基线(直接给出,不读 CM,降级态亦可用)。 */}
        <button
          type="button"
          className="pw-tl-gen"
          onClick={() => onResolve(baseline)}
        >
          全部拒绝
        </button>
        {/* 全部接受 === 新版。 */}
        <button
          type="button"
          className="pw-tl-gen is-primary"
          onClick={() => onResolve(next)}
        >
          全部接受
        </button>
      </header>

      {loadState === "failed" ? (
        <div className="pw-writing-diff-fallback pw-empty-hint">
          无法加载逐块审阅视图,可整体接受或拒绝本次改动。
        </div>
      ) : null}

      {/* CM 宿主:ready 时挂 unifiedMergeView;failed 时隐藏(降级仅两按钮)。 */}
      <div
        ref={hostRef}
        className="pw-writing-diff-host"
        style={loadState === "failed" ? { display: "none" } : undefined}
      />
    </div>
  );
}
