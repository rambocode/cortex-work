import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { DesktopBridge } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { Icon } from "@cortex-work/ui/icons";
import { base64ToArrayBuffer } from "./binaryPreview";

type Status = "loading" | "ready" | "tooLarge" | "error";

interface PresentationViewer {
  slideCount: number;
  goToSlide: (index: number) => Promise<void>;
  setZoom: (percent: number) => Promise<void>;
  setFitMode: (mode: "contain" | "none") => Promise<void>;
  destroy: () => void;
}

export function PptxViewer({
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PresentationViewer | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [slideIndex, setSlideIndex] = useState(0);
  const [slideCount, setSlideCount] = useState(0);
  const [zoom, setZoomValue] = useState(100);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const controller = new AbortController();
    let cancelled = false;
    body.replaceChildren();
    viewerRef.current = null;
    setStatus("loading");
    setError("");
    setSlideIndex(0);
    setSlideCount(0);
    setZoomValue(100);

    void (async () => {
      try {
        if (!bridge.readFileBinary) throw new Error(t("pptx.unsupported"));
        const result = await bridge.readFileBinary(filePath);
        if (cancelled) return;
        if (result.truncated || !result.data) {
          setStatus("tooLarge");
          return;
        }
        const { PptxViewer: LocalPptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
        if (cancelled) return;
        const viewer = await LocalPptxViewer.open(base64ToArrayBuffer(result.data), body, {
          renderMode: "slide",
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          lazySlides: true,
          lazyMedia: true,
          pdfjs: false,
          fitMode: "contain",
          signal: controller.signal,
          onSlideChange: (index) => {
            if (!cancelled) setSlideIndex(index);
          },
        });
        if (cancelled) {
          viewer.destroy();
          return;
        }
        viewerRef.current = viewer;
        setSlideCount(viewer.slideCount);
        setStatus("ready");
      } catch (cause) {
        if (cancelled || (cause instanceof Error && cause.name === "AbortError")) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      viewerRef.current?.destroy();
      viewerRef.current = null;
      body.replaceChildren();
    };
  }, [bridge, filePath, reloadKey, retryKey, t]);

  const openInSystem = () => {
    void bridge
      .openPath?.(filePath)
      .catch((cause: unknown) => onToast?.(t("openFailed", { error: cause instanceof Error ? cause.message : String(cause) })));
  };

  const goToSlide = (index: number) => {
    const nextIndex = Math.min(slideCount - 1, Math.max(0, index));
    setSlideIndex(nextIndex);
    void viewerRef.current?.goToSlide(nextIndex).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    });
  };

  const changeZoom = (delta: number) => {
    const nextZoom = Math.min(200, Math.max(50, zoom + delta));
    setZoomValue(nextZoom);
    void viewerRef.current?.setFitMode("none").then(() => viewerRef.current?.setZoom(nextZoom)).catch(() => {});
  };

  const fitSlide = () => {
    setZoomValue(100);
    void viewerRef.current?.setFitMode("contain").catch(() => {});
  };

  const handleLinkClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    try {
      const url = new URL(href);
      if ((url.protocol === "http:" || url.protocol === "https:") && bridge.openExternal) {
        void bridge.openExternal(url.toString()).catch(() => {});
      }
    } catch {
      // 相对地址和非安全协议不离开本地预览器。
    }
  };

  return (
    <div
      className="pw-document-viewer pw-pptx-viewer"
      aria-busy={status === "loading"}
      aria-label={t("pptx.previewAria", { name: fileName })}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") goToSlide(slideIndex - 1);
        if (event.key === "ArrowRight") goToSlide(slideIndex + 1);
      }}
    >
      {status === "ready" ? (
        <div className="pw-document-controls" aria-label={t("pptx.controls")}>
          <button type="button" aria-label={t("pptx.previousSlide")} disabled={slideIndex <= 0} onClick={() => goToSlide(slideIndex - 1)}>‹</button>
          <span>{slideIndex + 1} / {slideCount}</span>
          <button type="button" aria-label={t("pptx.nextSlide")} disabled={slideIndex >= slideCount - 1} onClick={() => goToSlide(slideIndex + 1)}>›</button>
          <span className="pw-document-divider" aria-hidden />
          <button type="button" aria-label={t("pptx.zoomOut")} disabled={zoom <= 50} onClick={() => changeZoom(-10)}>−</button>
          <span aria-live="polite">{zoom}%</span>
          <button type="button" aria-label={t("pptx.zoomIn")} disabled={zoom >= 200} onClick={() => changeZoom(10)}>+</button>
          <button type="button" className="pw-document-fit" aria-label={t("pptx.fitSlide")} onClick={fitSlide}>{t("pptx.fit")}</button>
        </div>
      ) : null}
      {status === "loading" ? (
        <div className="pw-document-state" role="status"><Icon.Workflow size={18} /><span>{t("pptx.loading")}</span></div>
      ) : null}
      {status === "tooLarge" ? (
        <div className="pw-document-state" role="alert">
          <Icon.File size={22} />
          <strong>{t("pptx.tooLargeTitle")}</strong>
          <span>{t("pptx.tooLargeHint")}</span>
          {bridge.openPath ? <button type="button" className="pw-ftb-btn is-primary" onClick={openInSystem}>{t("pptx.openSystem")}</button> : null}
        </div>
      ) : null}
      {status === "error" ? (
        <div className="pw-document-state" role="alert">
          <Icon.File size={22} />
          <strong>{t("pptx.failedTitle")}</strong>
          <span>{error}</span>
          <div className="pw-document-state-actions">
            <button type="button" className="pw-ftb-btn is-primary" onClick={() => setRetryKey((key) => key + 1)}>{t("pptx.retry")}</button>
            {bridge.openPath ? <button type="button" className="pw-ftb-btn" onClick={openInSystem}>{t("pptx.openSystem")}</button> : null}
          </div>
        </div>
      ) : null}
      <div
        className="pw-document-canvas pw-pptx-canvas"
        aria-hidden={status !== "ready"}
        style={{ visibility: status === "ready" ? "visible" : "hidden" }}
        onClick={handleLinkClick}
      >
        <div ref={bodyRef} className="pw-pptx-body" />
      </div>
    </div>
  );
}
