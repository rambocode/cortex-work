// 消费方还包含不加载 vite/client 的 Next.js tsconfig，需显式带入 worker asset 模块声明。
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./pdfjs-worker.d.ts" />

import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { Icon } from "@cortex-work/ui/icons";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { base64ToArrayBuffer } from "./binaryPreview";

type Status = "loading" | "ready" | "tooLarge" | "error";

export function PdfViewer({
  filePath,
  fileName,
  bridge,
  reloadKey = 0,
  onToast,
}: {
  filePath: string;
  fileName: string;
  bridge: DesktopBridge;
  reloadKey?: number;
  onToast?: (text: string) => void;
}) {
  const { t } = useTranslation("files");
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoomMode, setZoomMode] = useState<"fit" | "manual">("fit");
  const [fitZoom, setFitZoom] = useState(1);
  const [manualZoom, setManualZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<(typeof import("pdfjs-dist/legacy/build/pdf.mjs"))["getDocument"]> | undefined;
    setStatus("loading");
    setError("");
    setPageNumber(1);
    setPageCount(0);
    documentRef.current = null;

    void (async () => {
      try {
        if (!bridge.readFileBinary) throw new Error(t("pdf.unsupported"));
        const result = await bridge.readFileBinary(filePath);
        if (cancelled) return;
        if (result.truncated || !result.data) {
          setStatus("tooLarge");
          return;
        }
        const [pdfjs, worker] = await Promise.all([
          import("pdfjs-dist/legacy/build/pdf.mjs"),
          import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
        ]);
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        loadingTask = pdfjs.getDocument({
          data: new Uint8Array(base64ToArrayBuffer(result.data)),
          isEvalSupported: false,
          useWorkerFetch: false,
        });
        const document = await loadingTask.promise;
        if (cancelled) {
          await document.destroy();
          return;
        }
        documentRef.current = document;
        setPageCount(document.numPages);
        setStatus("ready");
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      const document = documentRef.current;
      documentRef.current = null;
      if (document) void document.destroy();
      else void loadingTask?.destroy();
    };
  }, [bridge, filePath, reloadKey, retryKey, t]);

  const recalculateFitZoom = useCallback(async () => {
    const document = documentRef.current;
    const viewport = viewportRef.current;
    if (!document || !viewport) return;
    try {
      const page = await document.getPage(pageNumber);
      const natural = page.getViewport({ scale: 1 });
      const available = Math.max(0, viewport.clientWidth - 48);
      if (natural.width > 0 && available > 0) {
        setFitZoom(Math.min(2, Math.max(0.5, available / natural.width)));
      }
    } catch {
      // 页面切换或卸载时的测量失败由实际渲染流程处理。
    }
  }, [pageNumber]);

  useEffect(() => {
    if (status !== "ready") return;
    void recalculateFitZoom();
    if (typeof ResizeObserver === "undefined" || !viewportRef.current) return;
    const observer = new ResizeObserver(() => void recalculateFitZoom());
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [status, recalculateFitZoom]);

  const effectiveZoom = zoomMode === "fit" ? fitZoom : manualZoom;
  useEffect(() => {
    const document = documentRef.current;
    const canvas = canvasRef.current;
    if (status !== "ready" || !document || !canvas) return;
    let cancelled = false;
    renderTaskRef.current?.cancel();

    void (async () => {
      try {
        const page = await document.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: effectiveZoom });
        const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
        const context = canvas.getContext("2d");
        if (!context) throw new Error(t("pdf.canvasUnavailable"));
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const task = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        renderTaskRef.current = task;
        await task.promise;
      } catch (cause) {
        if (cancelled || (cause instanceof Error && cause.name === "RenderingCancelledException")) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [effectiveZoom, pageNumber, status, t]);

  const openInSystem = () => {
    void bridge
      .openPath?.(filePath)
      .catch((cause: unknown) => onToast?.(t("openFailed", { error: cause instanceof Error ? cause.message : String(cause) })));
  };

  const changeZoom = (delta: number) => {
    setManualZoom(Math.min(2, Math.max(0.5, Math.round((effectiveZoom + delta) * 10) / 10)));
    setZoomMode("manual");
  };

  return (
    <div className="pw-document-viewer pw-pdf-viewer" aria-busy={status === "loading"} aria-label={t("pdf.previewAria", { name: fileName })}>
      {status === "ready" ? (
        <div className="pw-document-controls" aria-label={t("pdf.controls")}>
          <button type="button" aria-label={t("pdf.previousPage")} disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => value - 1)}>
            ‹
          </button>
          <span>{pageNumber} / {pageCount}</span>
          <button type="button" aria-label={t("pdf.nextPage")} disabled={pageNumber >= pageCount} onClick={() => setPageNumber((value) => value + 1)}>
            ›
          </button>
          <span className="pw-document-divider" aria-hidden />
          <button type="button" aria-label={t("pdf.zoomOut")} disabled={effectiveZoom <= 0.5} onClick={() => changeZoom(-0.1)}>
            −
          </button>
          <span aria-live="polite">{Math.round(effectiveZoom * 100)}%</span>
          <button type="button" aria-label={t("pdf.zoomIn")} disabled={effectiveZoom >= 2} onClick={() => changeZoom(0.1)}>
            +
          </button>
          <button type="button" className="pw-document-fit" aria-label={t("pdf.fitWidth")} aria-pressed={zoomMode === "fit"} onClick={() => setZoomMode("fit")}>
            {t("pdf.fit")}
          </button>
        </div>
      ) : null}
      {status === "loading" ? <PreviewState icon={<Icon.Workflow size={18} />} text={t("pdf.loading")} /> : null}
      {status === "tooLarge" ? (
        <PreviewState
          alert
          icon={<Icon.File size={22} />}
          title={t("pdf.tooLargeTitle")}
          text={t("pdf.tooLargeHint")}
          actions={bridge.openPath ? <button type="button" className="pw-ftb-btn is-primary" onClick={openInSystem}>{t("pdf.openSystem")}</button> : null}
        />
      ) : null}
      {status === "error" ? (
        <PreviewState
          alert
          icon={<Icon.File size={22} />}
          title={t("pdf.failedTitle")}
          text={error}
          actions={
            <>
              <button type="button" className="pw-ftb-btn is-primary" onClick={() => setRetryKey((key) => key + 1)}>{t("pdf.retry")}</button>
              {bridge.openPath ? <button type="button" className="pw-ftb-btn" onClick={openInSystem}>{t("pdf.openSystem")}</button> : null}
            </>
          }
        />
      ) : null}
      <div
        ref={viewportRef}
        className="pw-document-canvas pw-pdf-canvas"
        aria-hidden={status !== "ready"}
        style={{ visibility: status === "ready" ? "visible" : "hidden" }}
      >
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}

function PreviewState({
  alert = false,
  icon,
  title,
  text,
  actions,
}: {
  alert?: boolean;
  icon: React.ReactNode;
  title?: string;
  text: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="pw-document-state" role={alert ? "alert" : "status"}>
      {icon}
      {title ? <strong>{title}</strong> : null}
      <span>{text}</span>
      {actions ? <div className="pw-document-state-actions">{actions}</div> : null}
    </div>
  );
}
