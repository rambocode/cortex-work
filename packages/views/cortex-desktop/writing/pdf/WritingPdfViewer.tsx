// 写作工作区中栏的 PDF 只读阅读器(U5,参照 Kun WritePdfViewer 精简)。
// 能力:翻页 / 缩放 / 文本层选中 → 选中文本可引用进助手(sourceKind=pdf,带页码)。
//
// pdfjs-dist 是重依赖且 views 同时被 Next.js(web)与 electron-vite(desktop)双打包,故:
//   - 顶层只 `import type`(编译期擦除,不进任一产物);pdfjs 运行时代码全在 useEffect 内动态 import。
//   - worker 用 `new URL(..., import.meta.url)` 跨打包器写法(与 MonacoViewer 同范式);
//     创建失败时 pdfjs 自动降级主线程 fake worker(仅慢,不影响正确性)。
// PDF 原始字节经 bridge.writingReadPdf 从主进程取(渲染端不碰 window.desktopAPI);无该能力则显示不支持。
//
// 选区→引用:PDF 无行号,改用页码定位。选区快照计算抽成纯函数 pdfSelectionSnapshotFromSelection,
// 便于就近单测(用 jsdom 构造带 data-write-pdf-page 的 DOM 断言页码区间),无需真跑 pdfjs。
// 注:未移植 Kun 的「失焦后 committed 高亮 overlay」——原生选区高亮在聚焦期间已足够定位,overlay 延后。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
// 类型从 pdfjs-dist 根导入(带类型声明);运行时也动态 import 根入口(其 exports 的 import 即 build/pdf.mjs)。
// 不直接 import 子路径 "pdfjs-dist/build/pdf.mjs":该子路径无 .d.ts,typecheck 会 TS7016。
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useDesktopBridge } from "@cortex-work/core/provider";
import type { WritingSelectionSnapshot } from "@cortex-work/core/writing/prompt";

type PdfjsModule = typeof import("pdfjs-dist");

interface Props {
  // 当前打开的 PDF 绝对路径(树节点 key)。
  filePath: string;
  // 选区上报:PDF 文本层选中文本 → 快照(sourceKind=pdf + 页码);空选区/失焦到面板外传 null。
  onSelectionChange?: (selection: WritingSelectionSnapshot | null) => void;
}

// 取节点所属页码:向上找最近的 [data-write-pdf-page] 容器,读其 1-based 页码;找不到返回 null。
function pageFromNode(node: Node | null): number | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const pageElement = element?.closest<HTMLElement>("[data-write-pdf-page]");
  const page = Number(pageElement?.dataset.writePdfPage ?? "");
  return Number.isFinite(page) && page > 0 ? page : null;
}

// 纯函数:从一段 DOM Selection 计算 PDF 选区快照。选区为空/折叠/不在 root 内 → null。
// 页码取 anchor / focus 两端所在页的最小与最大(跨页选择时给区间)。导出供就近单测。
export function pdfSelectionSnapshotFromSelection(
  root: HTMLElement,
  selection: Selection | null,
): WritingSelectionSnapshot | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const anchorInside = selection.anchorNode ? root.contains(selection.anchorNode) : false;
  const focusInside = selection.focusNode ? root.contains(selection.focusNode) : false;
  if (!anchorInside || !focusInside) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const pageA = pageFromNode(selection.anchorNode);
  const pageB = pageFromNode(selection.focusNode);
  const pageStart = Math.min(pageA ?? pageB ?? 1, pageB ?? pageA ?? 1);
  const pageEnd = Math.max(pageA ?? pageB ?? pageStart, pageB ?? pageA ?? pageStart);
  return { text, charCount: text.length, sourceKind: "pdf", pageStart, pageEnd };
}

function formatSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

// base64 → 字节(渲染端浏览器环境;core 禁 node Buffer,故在 views 用 atob 逐字节解)。
function bytesFromBase64(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// 单页:挂载 / 缩放变化时把该页渲染进 canvas,并铺 pdfjs 文本层(供选中)。
function PdfPage({
  pdfjs,
  document: pdfDocument,
  pageNumber,
  scale,
}: {
  pdfjs: PdfjsModule;
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;

    const render = async (): Promise<void> => {
      const canvas = canvasRef.current;
      const textLayer = textLayerRef.current;
      if (!canvas || !textLayer) return;
      const page: PDFPageProxy = await pdfDocument.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      // 高分屏按 devicePixelRatio 放大位图密度,再用 CSS 尺寸缩回,避免模糊。
      const outputScale = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setSize({ width: viewport.width, height: viewport.height });

      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
      // pdfjs 5.x 的 RenderParameters 要求传 canvas(canvasContext 为向后兼容可选项),两者都给。
      const task = page.render({ canvas, canvasContext: context, viewport });
      renderTask = task;
      await task.promise;
      if (cancelled) return;

      // 文本层:pdfjs 用 --scale-factor 计算 span 字号定位,须与 viewport.scale 一致。
      textLayer.replaceChildren();
      textLayer.style.setProperty("--scale-factor", String(scale));
      const textContent = await page.getTextContent();
      if (cancelled) return;
      const renderer = new pdfjs.TextLayer({ textContentSource: textContent, container: textLayer, viewport });
      await renderer.render();
      page.cleanup();
    };

    void render().catch(() => undefined);
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfjs, pdfDocument, pageNumber, scale]);

  return (
    <div
      className="pw-writing-pdf-page"
      data-write-pdf-page={pageNumber}
      style={size ? { width: size.width, height: size.height } : undefined}
    >
      <canvas ref={canvasRef} className="pw-writing-pdf-canvas" />
      <div ref={textLayerRef} className="pw-writing-pdf-text-layer textLayer" />
    </div>
  );
}

export function WritingPdfViewer({ filePath, onSelectionChange }: Props): ReactElement {
  const bridge = useDesktopBridge();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const selectionTimerRef = useRef<number | null>(null);

  const [pdfjs, setPdfjs] = useState<PdfjsModule | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [size, setSize] = useState(0);
  const [scale, setScale] = useState(1.15);
  const [pageInput, setPageInput] = useState("1");
  const [currentPage, setCurrentPage] = useState(1);
  const pageCount = doc?.numPages ?? 0;

  // onSelectionChange 走 ref:selectionchange 监听闭包只建一次,读 ref 取最新回调。
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  // 加载 PDF:动态 import pdfjs(首次)+ 配 worker → bridge 取字节 → getDocument。path 变化重载。
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setLoading(true);
    setError("");
    setDoc(null);
    onSelectionChangeRef.current?.(null);

    const load = async (): Promise<void> => {
      const mod = await import("pdfjs-dist");
      if (cancelled) return;
      // worker 跨打包器写法;失败时不阻断(pdfjs 降级主线程)。
      try {
        mod.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).href;
      } catch {
        /* 无法解析 worker URL → pdfjs 用主线程 fake worker */
      }
      setPdfjs(mod);

      if (!bridge?.writingReadPdf) {
        setError("当前环境不支持打开 PDF");
        setLoading(false);
        return;
      }
      const res = await bridge.writingReadPdf({ path: filePath });
      if (cancelled) return;
      if (!res.ok) {
        setError(res.message);
        setLoading(false);
        return;
      }
      setSize(res.size);
      const task = mod.getDocument({ data: bytesFromBase64(res.base64), isEvalSupported: false });
      const pdf = await task.promise;
      if (cancelled) {
        void pdf.destroy();
        return;
      }
      loaded = pdf;
      setDoc(pdf);
      setCurrentPage(1);
      setPageInput("1");
      setLoading(false);
    };

    void load().catch((reason: unknown) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });

    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [bridge, filePath]);

  // 缩放变化收敛选区(overlay 未移植,防止旧选区页码停留在错位快照上)。
  useEffect(() => {
    onSelectionChangeRef.current?.(null);
  }, [scale]);

  // 文本层选中 → 计算快照上报。用 selectionchange 去抖(0ms)避免高频触发;选区移出阅读器不清(保留快照)。
  useEffect(() => {
    const handle = (): void => {
      const root = rootRef.current;
      if (!root) return;
      if (selectionTimerRef.current != null) window.clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = window.setTimeout(() => {
        selectionTimerRef.current = null;
        const snap = pdfSelectionSnapshotFromSelection(root, window.getSelection());
        // 选区在阅读器内(有快照)→ 上报;选区落到面板外(null)时保留上次快照,便于「引用当前选区」。
        if (snap) onSelectionChangeRef.current?.(snap);
      }, 0);
    };
    window.document.addEventListener("selectionchange", handle);
    return () => {
      window.document.removeEventListener("selectionchange", handle);
      if (selectionTimerRef.current != null) window.clearTimeout(selectionTimerRef.current);
    };
  }, []);

  const scrollToPage = useCallback(
    (page: number): void => {
      const clamped = Math.max(1, Math.min(pageCount || 1, Math.round(page)));
      setCurrentPage(clamped);
      setPageInput(String(clamped));
      pageRefs.current.get(clamped)?.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    [pageCount],
  );

  const relLabel = filePath.split(/[/\\]/).pop() || filePath;

  return (
    <div ref={rootRef} className="pw-writing-pdf-viewer">
      {/* 阅读器工具栏:文件名 + 大小 | 缩放 | 翻页 */}
      <header className="pw-writing-pdf-toolbar">
        <div className="pw-writing-pdf-file" title={filePath}>
          {relLabel}
          {size ? <span className="pw-writing-pdf-size"> · {formatSize(size)}</span> : null}
        </div>
        <div className="pw-writing-pdf-zoom" role="group" aria-label="缩放">
          <button
            type="button"
            aria-label="缩小"
            title="缩小"
            onClick={() => setScale((v) => Math.max(0.6, Number((v - 0.1).toFixed(2))))}
          >
            −
          </button>
          <span className="pw-writing-pdf-zoom-val">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            aria-label="放大"
            title="放大"
            onClick={() => setScale((v) => Math.min(2.6, Number((v + 0.1).toFixed(2))))}
          >
            +
          </button>
        </div>
        <div className="pw-writing-pdf-pager" role="group" aria-label="翻页">
          <button
            type="button"
            aria-label="上一页"
            title="上一页"
            disabled={currentPage <= 1}
            onClick={() => scrollToPage(currentPage - 1)}
          >
            ‹
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              scrollToPage(Number(pageInput));
            }}
          >
            <input
              className="pw-writing-pdf-page-input"
              aria-label="页码"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
            />
            <span className="pw-writing-pdf-page-total"> / {pageCount || "-"}</span>
          </form>
          <button
            type="button"
            aria-label="下一页"
            title="下一页"
            disabled={!pageCount || currentPage >= pageCount}
            onClick={() => scrollToPage(currentPage + 1)}
          >
            ›
          </button>
        </div>
      </header>

      <div className="pw-writing-pdf-scroller" ref={scrollerRef}>
        {loading ? (
          <div className="pw-writing-pdf-hint">加载中…</div>
        ) : error ? (
          <div className="pw-writing-pdf-hint is-error">打开 PDF 失败：{error}</div>
        ) : pdfjs && doc ? (
          <div className="pw-writing-pdf-pages">
            {Array.from({ length: doc.numPages }, (_, i) => i + 1).map((pageNumber) => (
              <div
                key={pageNumber}
                className="pw-writing-pdf-page-wrap"
                ref={(node) => {
                  if (node) pageRefs.current.set(pageNumber, node);
                  else pageRefs.current.delete(pageNumber);
                }}
              >
                <PdfPage pdfjs={pdfjs} document={doc} pageNumber={pageNumber} scale={scale} />
                <div className="pw-writing-pdf-page-label">第 {pageNumber} 页</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* pdfjs 文本层样式:让文本层透明覆盖在 canvas 之上、可原生选中。scoped 到本阅读器,不注入全局。
          注意 CSS 内不写块注释,避免与 TS 块注释收尾符冲突(仓库 CSS 注释红线)。 */}
      <style>{PDF_TEXT_LAYER_CSS}</style>
    </div>
  );
}

// pdfjs 文本层最小样式(官方 text_layer_builder 精简):透明文本、绝对定位、可选中高亮。
const PDF_TEXT_LAYER_CSS = `
.pw-writing-pdf-page { position: relative; }
.pw-writing-pdf-canvas { display: block; }
.pw-writing-pdf-text-layer.textLayer {
  position: absolute;
  text-align: initial;
  inset: 0;
  overflow: clip;
  opacity: 1;
  line-height: 1;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  z-index: 1;
}
.pw-writing-pdf-text-layer.textLayer span,
.pw-writing-pdf-text-layer.textLayer br {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0 0;
}
.pw-writing-pdf-text-layer.textLayer ::selection {
  background: rgba(90, 130, 255, 0.35);
}
`;
