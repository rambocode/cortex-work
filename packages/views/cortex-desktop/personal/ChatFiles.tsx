// 用户消息气泡内的文档附件回显。个人工作区传 onOpenFile 时 chip 可点并复用文件预览路由;
// 团队侧不传时保持只读。内容仍由 agent 经 extract_document 按需读取。
import { Icon } from "@cortex-work/ui/icons";
import type { ChatFileRef } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";

export function ChatFiles({
  files,
  onOpenFile,
}: {
  files: ChatFileRef[];
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useTranslation("files");
  return (
    <div className="msg-file-row">
      {files.map((f) =>
        onOpenFile ? (
          <button
            key={f.path}
            type="button"
            className="msg-file is-clickable"
            title={f.name}
            aria-label={t("previewAttachmentAria", { name: f.name })}
            onClick={() => onOpenFile(f.path)}
          >
            <Icon.File size={14} />
            <span className="msg-file-name">{f.name}</span>
          </button>
        ) : (
          <span key={f.path} className="msg-file" title={f.name}>
            <Icon.File size={14} />
            <span className="msg-file-name">{f.name}</span>
          </span>
        ),
      )}
    </div>
  );
}
