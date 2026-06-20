// 个人工作区会话页输入框：ComposerShell 内核的会话绑定薄封装。把 session 派生量
// (agent/model/providerId/useOwnSkills) 摊平后转交内核,并启用 slash 命令与文件预览
// 「发送到 Chat」插入。

import type { PendingImage, PersonalAttachment, SessionMeta, ThinkingLevel } from "@cortex-work/core";
import { ComposerShell } from "./ComposerShell";

// slash 命令注册表（发送拦截在 PersonalChatArea.onSend）。/compact 仅 pi 会话有（压缩走 pi RPC）。
const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: "/clear", desc: "隐藏当前历史记录（可展开）" },
];
const PI_SLASH_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: "/compact", desc: "压缩当前会话上下文" },
];

export function PersonalComposer({
  session,
  running,
  editing,
  onCancelEdit,
  onSend,
  onStop,
  onSteer,
  onChangeModel,
  onChangePiModel,
  onChangePiThinking,
  onToggleSkills,
  onOpenFlashNote,
  onToast,
}: {
  session: SessionMeta;
  running: boolean;
  /** 编辑重发:正在编辑的历史用户消息(原文填入输入框,顶部出提示条)。 */
  editing?: { uid: string; text: string } | null;
  onCancelEdit?: () => void;
  onSend: (
    text: string,
    attachments: PersonalAttachment[],
    images?: PendingImage[],
  ) => void | boolean | Promise<void | boolean>;
  onStop: () => void;
  /** pi 运行中插话:注入当前轮（仅 pi 会话传入;ComposerShell 内部再按 isPi+running 门控）。 */
  onSteer?: (text: string) => void;
  onChangeModel: (model: string) => void;
  // pi 多通道:同时切换通道与模型。
  onChangePiModel: (channelId: string, model: string) => void;
  // pi 思考强度:会话级切换。
  onChangePiThinking: (level: ThinkingLevel) => void;
  onToggleSkills: () => void;
  /** 闪记图标入口:唤起闪记浮层(由壳注入,web 端缺省 → 隐藏)。 */
  onOpenFlashNote?: () => void;
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
      slashCommands={session.agent === "pi" ? [...SLASH_COMMANDS, ...PI_SLASH_COMMANDS] : SLASH_COMMANDS}
      acceptComposerInsert
      onSend={onSend}
      onStop={onStop}
      onSteer={onSteer}
      onChangeModel={onChangeModel}
      onChangePiModel={onChangePiModel}
      thinkingLevel={session.thinkingLevel}
      onChangePiThinking={onChangePiThinking}
      onToggleSkills={onToggleSkills}
      onOpenFlashNote={onOpenFlashNote}
      onCancelEdit={onCancelEdit}
      onToast={onToast}
    />
  );
}
