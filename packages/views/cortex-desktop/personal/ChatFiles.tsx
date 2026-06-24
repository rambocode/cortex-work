// 用户消息气泡内的文档附件回显(只展示名称/类型,不读内容——内容由 agent 经 extract_document
// 按需读取)。与 ChatImages 平行;本期为只读 chip,不可点。
import { Icon } from "@cortex-work/ui/icons";
import type { ChatFileRef } from "@cortex-work/core";

export function ChatFiles({ files }: { files: ChatFileRef[] }) {
  return (
    <div className="msg-file-row">
      {files.map((f) => (
        <span key={f.path} className="msg-file" title={f.name}>
          <Icon.File size={14} />
          <span className="msg-file-name">{f.name}</span>
        </span>
      ))}
    </div>
  );
}
