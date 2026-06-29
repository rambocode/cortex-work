// 个人工作区会话页输入框：ComposerShell 内核的会话绑定薄封装。把 session 派生量
// (agent/model/providerId/useOwnSkills) 摊平后转交内核,并启用 slash 命令与文件预览
// 「发送到 Chat」插入。

import { DEFAULT_AGENT_THINKING, usePiEnabledSkills } from "@cortex-work/core";
import type { AgentThinkingValue, DirPermission, ExecPermission, PendingDocFile, PendingImage, PersonalAttachment, SessionMeta } from "@cortex-work/core";
import { ComposerShell, type SlashCommand } from "./ComposerShell";

// 内建 slash 命令(发送拦截在 PersonalChatArea.onSend）。kind:"builtin" = 选中即执行。
// /compact 仅 pi 会话有（压缩走 pi RPC）。
const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "/clear", desc: "隐藏当前历史记录（可展开）", kind: "builtin" },
];
const PI_SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "/compact", desc: "压缩当前会话上下文", kind: "builtin" },
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
  onChangeThinking,
  onChangeExecPermission,
  onChangeDirPermission,
  onToggleSubagentOrchestration,
  onToggleSkills,
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
    docFiles?: PendingDocFile[],
  ) => void | boolean | Promise<void | boolean>;
  onStop: () => void;
  /** pi 运行中插话:注入当前轮（仅 pi 会话传入;ComposerShell 内部再按 isPi+running 门控）。 */
  onSteer?: (text: string) => void;
  onChangeModel: (model: string) => void;
  // pi 多通道:同时切换通道与模型。
  onChangePiModel: (channelId: string, model: string) => void;
  // 思考强度:非 Pi 更新 effort;Pi 更新 thinkingLevel。
  onChangeThinking: (value: AgentThinkingValue) => void;
  onChangeExecPermission: (p: ExecPermission) => void;
  onChangeDirPermission: (d: DirPermission) => void;
  onToggleSubagentOrchestration: () => void;
  onToggleSkills: () => void;
  onToast: (text: string) => void;
}) {
  // pi 风格动态 skills(U4):仅 pi 会话非空(hook 内按 agent/useOwnSkills/桥门控)。
  // 映射为 /skill:<name>(kind:"skill" → 选中插入待填参,KTD4),排在内建命令之后(减少异步弹入位移)。
  const piSkills = usePiEnabledSkills(session);
  const skillCommands: SlashCommand[] = piSkills.map((s) => ({
    cmd: `/skill:${s.name}`,
    desc: s.description,
    argHint: s.argumentHint,
    kind: "skill",
  }));
  const builtins = session.agent === "pi" ? [...SLASH_COMMANDS, ...PI_SLASH_COMMANDS] : SLASH_COMMANDS;
  const slashCommands = [...builtins, ...skillCommands];

  return (
    <ComposerShell
      agent={session.agent}
      model={session.model}
      providerId={session.providerId}
      useOwnSkills={session.useOwnSkills === true}
      running={running}
      editing={editing}
      slashCommands={slashCommands}
      acceptComposerInsert
      onSend={onSend}
      onStop={onStop}
      onSteer={onSteer}
      onChangeModel={onChangeModel}
      onChangePiModel={onChangePiModel}
      thinkingValue={session.agent === "pi" ? session.thinkingLevel : (session.effort ?? DEFAULT_AGENT_THINKING)}
      onChangeThinking={onChangeThinking}
      execPermission={session.execPermission}
      onChangeExecPermission={onChangeExecPermission}
      dirPermission={session.dirPermission}
      onChangeDirPermission={onChangeDirPermission}
      subagentOrchestration={session.subagentOrchestration === true}
      onToggleSubagentOrchestration={onToggleSubagentOrchestration}
      onToggleSkills={onToggleSkills}
      onCancelEdit={onCancelEdit}
      onToast={onToast}
    />
  );
}
