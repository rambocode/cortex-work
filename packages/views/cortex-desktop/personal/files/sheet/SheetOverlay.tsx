// 聊天区内的表格预览浮层:无项目会话没有右栏 FilesView 上下文,xlsx/csv 链接
// 点击时在聊天区就地盖一层 SheetViewer(有项目的会话仍走右栏预览,不用本组件)。
// 自带父目录 watch → 喂给 SheetViewer 的外部变更检测(agent 改完文件自动重载闭环)。
import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import type { DesktopBridge } from "@cortex-work/core";
import { SheetViewer } from "./SheetViewer";

export function SheetOverlay({
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
  const { t } = useTranslation("files");
  const [dirty, setDirty] = useState(false);
  const [dirTick, setDirTick] = useState(0);

  // 监听文件父目录:无项目会话没有 FilesView 的目录 watch,浮层自建一份。
  // watch id 用路径限定,避免与 FilesView 的 project.id watch 互相顶掉。
  useEffect(() => {
    if (!bridge.watchDir) return;
    const dir = path.slice(0, path.lastIndexOf("/")) || path;
    const watchId = `sheet-overlay:${path}`;
    void bridge.watchDir(watchId, dir).catch(() => {
      /* 监听失败(权限等):放弃自动重载,保存/编辑不受影响 */
    });
    const off = bridge.onDirChanged?.((id) => {
      if (id === watchId) setDirTick((v) => v + 1);
    });
    return () => {
      off?.();
      bridge.unwatchDir?.(watchId);
    };
  }, [bridge, path]);

  const close = () => {
    // 有未保存编辑时确认后再关(关闭即丢弃,SheetViewer 卸载)。
    if (dirty && !window.confirm(t("sheet.closeDirtyConfirm"))) return;
    onClose();
  };

  return (
    <div className="pw-sheet-overlay">
      <div className="pw-editor-h pw-file-toolbar">
        <button className="pw-icon-btn" title={t("sheet.closePreview")} onClick={close}>
          <Icon.Back size={14} />
        </button>
        <span className="pw-editor-name" title={path}>
          {name}
          {dirty ? <span className="pw-dirty">●</span> : null}
        </span>
        <div className="spacer" />
        {bridge.openPath ? (
          <button
            className="pw-ftb-btn"
            title={t("toolbar.openTitle")}
            onClick={() => void bridge.openPath!(path).catch(() => onToast(t("openFailed", { error: name })))}
          >
            {t("toolbar.open")}
          </button>
        ) : null}
        {bridge.revealInFolder ? (
          <button
            className="pw-ftb-btn"
            title={t("toolbar.revealTitle")}
            onClick={() => void bridge.revealInFolder!(path).catch(() => onToast(t("revealFailed")))}
          >
            {t("toolbar.reveal")}
          </button>
        ) : null}
      </div>
      <SheetViewer
        key={path}
        filePath={path}
        fileName={name}
        bridge={bridge}
        onToast={onToast}
        onDirtyChange={setDirty}
        dirChangeTick={dirTick}
      />
    </div>
  );
}
