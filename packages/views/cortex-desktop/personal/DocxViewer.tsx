import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { DesktopBridge } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { Icon } from "@cortex-work/ui/icons";

type Status = "loading" | "ready" | "tooLarge" | "error";

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function DocxViewer({
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [zoomMode, setZoomMode] = useState<"fit" | "manual">("fit");
  const [fitZoom, setFitZoom] = useState(1);
  const [manualZoom, setManualZoom] = useState(1);

  const recalculateFitZoom = useCallback(() => {
    const viewport = viewportRef.current;
    const page = bodyRef.current?.querySelector<HTMLElement>("section.cortex-docx");
    if (!viewport || !page) return;
    const pageWidth = page.offsetWidth || page.getBoundingClientRect().width;
    const available = Math.max(0, viewport.clientWidth - 48);
    if (pageWidth > 0 && available > 0) {
      setFitZoom(Math.min(1, Math.max(0.5, available / pageWidth)));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const body = bodyRef.current;
    const styles = styleRef.current;
    if (!body || !styles) return;

    body.replaceChildren();
    styles.replaceChildren();
    setStatus("loading");
    setError("");

    void (async () => {
      try {
        if (!bridge.readFileBinary) throw new Error("当前环境不支持 Word 文档预览");
        const result = await bridge.readFileBinary(filePath);
        if (cancelled) return;
        if (result.truncated || !result.data) {
          setStatus("tooLarge");
          return;
        }
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        await renderAsync(base64ToArrayBuffer(result.data), body, styles, {
          className: "cortex-docx",
          inWrapper: true,
          renderAltChunks: false,
          renderComments: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          useBase64URL: true,
        });
        if (!cancelled) setStatus("ready");
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      body.replaceChildren();
      styles.replaceChildren();
    };
  }, [bridge, filePath, reloadKey, retryKey]);

  useEffect(() => {
    if (status !== "ready") return;
    recalculateFitZoom();
    if (typeof ResizeObserver === "undefined" || !viewportRef.current) return;
    const observer = new ResizeObserver(recalculateFitZoom);
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [status, recalculateFitZoom]);

  const openInSystem = () => {
    void bridge
      .openPath?.(filePath)
      .catch((cause: unknown) => onToast?.(t("openFailed", { error: cause instanceof Error ? cause.message : String(cause) })));
  };

  const handleLinkClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    const href = link.getAttribute("href") ?? "";
    event.preventDefault();
    if (href.startsWith("#")) return;
    try {
      const url = new URL(href);
      if ((url.protocol === "http:" || url.protocol === "https:") && bridge.openExternal) {
        void bridge.openExternal(url.toString()).catch(() => {});
      }
    } catch {
      // 非 URL / 非安全协议一律不离开预览器。
    }
  };

  const effectiveZoom = zoomMode === "fit" ? fitZoom : manualZoom;
  const changeZoom = (delta: number) => {
    setManualZoom(Math.min(1.5, Math.max(0.5, Math.round((effectiveZoom + delta) * 10) / 10)));
    setZoomMode("manual");
  };

  return (
    <div
      className="pw-docx-viewer"
      aria-busy={status === "loading"}
      aria-label={t("docx.previewAria", { name: fileName })}
    >
      <div ref={styleRef} className="pw-docx-styles" aria-hidden />
      {status === "ready" ? (
        <div className="pw-docx-controls" aria-label={t("docx.zoomControls")}>
          <button type="button" aria-label={t("docx.zoomOut")} onClick={() => changeZoom(-0.1)} disabled={effectiveZoom <= 0.5}>
            −
          </button>
          <span aria-live="polite">{Math.round(effectiveZoom * 100)}%</span>
          <button type="button" aria-label={t("docx.zoomIn")} onClick={() => changeZoom(0.1)} disabled={effectiveZoom >= 1.5}>
            +
          </button>
          <button
            type="button"
            className="pw-docx-fit"
            aria-label={t("docx.fitWidth")}
            aria-pressed={zoomMode === "fit"}
            onClick={() => setZoomMode("fit")}
          >
            {t("docx.fit")}
          </button>
        </div>
      ) : null}
      {status === "loading" ? (
        <div className="pw-docx-state" role="status">
          <Icon.Workflow size={18} />
          <span>{t("docx.loading")}</span>
        </div>
      ) : null}
      {status === "tooLarge" ? (
        <div className="pw-docx-state" role="alert">
          <Icon.File size={22} />
          <strong>{t("docx.tooLargeTitle")}</strong>
          <span>{t("docx.tooLargeHint")}</span>
          {bridge.openPath ? (
            <button type="button" className="pw-ftb-btn is-primary" onClick={openInSystem}>
              {t("docx.openSystem")}
            </button>
          ) : null}
        </div>
      ) : null}
      {status === "error" ? (
        <div className="pw-docx-state" role="alert">
          <Icon.File size={22} />
          <strong>{t("docx.failedTitle")}</strong>
          <span>{error}</span>
          <div className="pw-docx-state-actions">
            <button type="button" className="pw-ftb-btn is-primary" onClick={() => setRetryKey((key) => key + 1)}>
              {t("docx.retry")}
            </button>
            {bridge.openPath ? (
              <button type="button" className="pw-ftb-btn" onClick={openInSystem}>
                {t("docx.openSystem")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div ref={viewportRef} className="pw-docx-canvas" hidden={status !== "ready"}>
        <div
          ref={bodyRef}
          className="pw-docx-body"
          style={{ zoom: effectiveZoom } as CSSProperties}
          onClick={handleLinkClick}
        />
      </div>
    </div>
  );
}
