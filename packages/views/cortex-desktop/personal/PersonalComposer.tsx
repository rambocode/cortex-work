// 个人工作区会话页输入框：ComposerShell 内核的会话绑定薄封装。把 session 派生量
// (agent/model/providerId/useOwnSkills) 摊平后转交内核,并启用 slash 命令与文件预览
// 「发送到 Chat」插入。

import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DEFAULT_AGENT_THINKING, prewarmPiSession, useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { AgentThinkingValue, DirPermission, ExecPermission, PendingDocFile, PendingImage, PersonalAttachment, SessionMeta } from "@cortex-work/core";
import { ComposerShell } from "./ComposerShell";
import { useSlashCommands } from "./useSlashCommands";

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
  // slash 命令(内建 + 已启用 skill),与新会话落地页共用同一 hook(见 useSlashCommands)。
  const slashCommands = useSlashCommands(session);

  // 会话预热:首字符输入时提前拉起 pi 进程(消除首轮冷启)。每会话只发一次请求
  // (prewarmedFor 去重,ComposerShell 每次非空变更都会调);实际开启/复用由 prewarmPiSession 幂等保证。
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  const prewarmedFor = useRef<string | null>(null);
  const handlePrewarm = useCallback(() => {
    if (!bridge || prewarmedFor.current === session.id) return;
    const project = usePersonalStore.getState().projects.find((p) => p.id === session.projectId);
    if (!project?.path) return;
    prewarmedFor.current = session.id;
    void prewarmPiSession(qc, bridge, session, project.path);
  }, [bridge, qc, session]);

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
      onPrewarm={handlePrewarm}
    />
  );
}
