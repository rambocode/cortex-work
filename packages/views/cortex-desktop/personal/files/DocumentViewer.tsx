import type { DesktopBridge } from "@cortex-work/core";
import type { InAppDocumentKind } from "../shared/fileIcons";
import { DocxViewer } from "./DocxViewer";
import { PdfViewer } from "./PdfViewer";
import { PptxViewer } from "./PptxViewer";

export function DocumentViewer({
  kind,
  filePath,
  fileName,
  bridge,
  reloadKey,
  onToast,
}: {
  kind: InAppDocumentKind;
  filePath: string;
  fileName: string;
  bridge: DesktopBridge;
  reloadKey?: number;
  onToast?: (text: string) => void;
}) {
  if (kind === "pdf") {
    return <PdfViewer filePath={filePath} fileName={fileName} bridge={bridge} reloadKey={reloadKey} onToast={onToast} />;
  }
  if (kind === "pptx") {
    return <PptxViewer filePath={filePath} fileName={fileName} bridge={bridge} reloadKey={reloadKey} onToast={onToast} />;
  }
  return <DocxViewer filePath={filePath} fileName={fileName} bridge={bridge} reloadKey={reloadKey} onToast={onToast} />;
}
