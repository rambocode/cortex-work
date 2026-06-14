// 个人工作区会话页输入框：ComposerShell 内核的会话绑定薄封装。把 session 派生量
// (agent/model/providerId/useOwnSkills) 摊平后转交内核,并启用 slash 命令与文件预览
// 「发送到 Chat」插入。

import type { PersonalAttachment, SessionMeta } from "@cortex-work/core";
import { ComposerShell } from "./ComposerShell";

// slash 命令注册表（发送拦截在 PersonalChatArea.onSend）。
const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: "/clear", desc: "隐藏当前历史记录（可展开）" },
];

export function PersonalComposer({
  session,
  running,
  editing,
  onCancelEdit,
  onSend,
  onStop,
  onChangeModel,
  onChangePiModel,
  onToggleSkills,
  onToast,
}: {
  session: SessionMeta;
  running: boolean;
  /** 编辑重发:正在编辑的历史用户消息(原文填入输入框,顶部出提示条)。 */
  editing?: { uid: string; text: string } | null;
  onCancelEdit?: () => void;
  onSend: (text: string, attachments: PersonalAttachment[]) => void;
  onStop: () => void;
  onChangeModel: (model: string) => void;
  // pi 多通道:同时切换通道与模型。
  onChangePiModel: (channelId: string, model: string) => void;
  onToggleSkills: () => void;
  onToast: (text: string) => void;
}) {
  return (
    <ComposerShell
      agent={session.agent}
      model={session.model}
      providerId={session.providerId}
      useOwnSkills={session.useOwnSkills === true}
      running={running}
      editing={editing}
      slashCommands={SLASH_COMMANDS}
      acceptComposerInsert
      onSend={onSend}
      onStop={onStop}
      onChangeModel={onChangeModel}
      onChangePiModel={onChangePiModel}
      onToggleSkills={onToggleSkills}
      onCancelEdit={onCancelEdit}
      onToast={onToast}
    />
  );
}
