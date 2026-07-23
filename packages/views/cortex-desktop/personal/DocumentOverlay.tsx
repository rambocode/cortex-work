import { useState } from "react";
import type { DesktopBridge } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { Icon } from "@cortex-work/ui/icons";
import type { InAppDocumentKind } from "./fileIcons";
import { DocumentViewer } from "./DocumentViewer";

export function DocumentOverlay({
  kind,
  path,
  name,
  bridge,
  onToast,
  onClose,
}: {
  kind: InAppDocumentKind;
  path: string;
  name: string;
  bridge: DesktopBridge;
  onToast: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("files");
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="pw-document-overlay">
      <div className="pw-editor-h pw-file-toolbar">
        <button className="pw-icon-btn" title={t(`${kind}.closePreview`)} onClick={onClose}>
          <Icon.Back size={14} />
        </button>
        <span className="pw-editor-name" title={path}>{name}</span>
        <div className="spacer" />
        {bridge.openPath ? (
          <button className="pw-ftb-btn" title={t("toolbar.openTitle")} onClick={() => void bridge.openPath!(path).catch(() => onToast(t("openFailed", { error: name })))}>
            {t("toolbar.open")}
          </button>
        ) : null}
        {bridge.revealInFolder ? (
          <button className="pw-ftb-btn" title={t("toolbar.revealTitle")} onClick={() => void bridge.revealInFolder!(path).catch(() => onToast(t("revealFailed")))}>
            {t("toolbar.reveal")}
          </button>
        ) : null}
        <button className="pw-icon-btn" title={t("toolbar.reload")} onClick={() => setReloadKey((key) => key + 1)}>
          <Icon.Workflow size={13} />
        </button>
      </div>
      <DocumentViewer kind={kind} filePath={path} fileName={name} bridge={bridge} reloadKey={reloadKey} onToast={onToast} />
    </div>
  );
}
