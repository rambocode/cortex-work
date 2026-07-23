import type { DesktopBridge } from "@cortex-work/core";
import { DocumentOverlay } from "./DocumentOverlay";

const DOCX_KIND = "docx";

export function DocxOverlay({
  path,
  name,
  bridge,
  onToast,
  onClose,
}: {
  path: string;
  name: string;
  bridge: DesktopBridge;
  onToast: (text: string) => void;
  onClose: () => void;
}) {
  return (
    <DocumentOverlay kind={DOCX_KIND} path={path} name={name} bridge={bridge} onToast={onToast} onClose={onClose} />
  );
}
