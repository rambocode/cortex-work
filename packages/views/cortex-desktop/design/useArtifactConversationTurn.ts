// 会话产物面板 → 发起会话的回合回流(设计稿与演示文稿共用)。
//
// 右栏面板里的动作(提纲审批、画布上的智能操作)必须回到左侧那条会话:活是它的 agent 干的,
// deck 的 MCP 会话状态也挂在它的 run 上(runId `artifact:<kind>:<docId>:`)。这些动作原本走
// 设计工作台的 sendDesignMessage / 助手栏种子,等于在后台另起一条用户看不见的对话——
// 左侧会话毫无动静,用户只能再手打一遍指令(用户实测)。
import { useEffect } from "react";
import type { ConversationArtifactRef, ProjectMeta, SessionMeta } from "@cortex-work/core";
import { usePersonalActions } from "@cortex-work/core/personal/messages";
import { waitForSessionIdle } from "@cortex-work/core/personal/sessionIdle";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import {
  clearArtifactTurnDispatcher,
  setArtifactTurnDispatcher,
  type ArtifactTurnDispatcher,
} from "@cortex-work/core/design/artifact-turn-dispatch";
import { buildConversationArtifactPrompt } from "../personal/artifactDispatch";

/**
 * 会话的工作目录:真实项目取其路径,无项目会话取创建时定下的 noProjectDir。
 * 与 PersonalChatArea 的合成项目同一语义(那里还要项目名等字段,这里只要路径)。
 */
export function sessionProjectPath(session: SessionMeta, projects: ProjectMeta[]): string {
  if (!session.projectId) return session.noProjectDir ?? "";
  return projects.find((p) => p.id === session.projectId)?.path ?? "";
}

/** 为当前打开的会话产物(设计稿 / 演示文稿)注册回合派发器。 */
export function useArtifactConversationTurn(artifact: ConversationArtifactRef): void {
  const { send } = usePersonalActions();
  // 绑定「打开该产物的那条会话」而非派发时的活动会话:等待 agent 说完这段时间里
  // 用户完全可能切到别的对话,发错地方比晚发更糟。
  const sessionId = usePersonalStore((s) => s.activeSessionId);

  useEffect(() => {
    if (!sessionId) return;
    const dispatcher: ArtifactTurnDispatcher = {
      workspaceRoot: artifact.workspaceRoot,
      documentId: artifact.documentId,
      async send(turn) {
        // 审批弹层在 agent 还在流式输出时就已可点。此刻直接发会在同一会话里起第二条
        // 并发 run(输出交错、resume 会话 id 互相覆盖),故先等这一轮落定。
        if (!(await waitForSessionIdle(sessionId))) return false;
        // 会话元数据按 id 现查:等待期间模型/权限档可能被改过,闭包里的旧快照会发错配置。
        const state = usePersonalStore.getState();
        const session = state.sessions.find((s) => s.id === sessionId);
        if (!session) return false;
        return send(
          session,
          sessionProjectPath(session, state.projects),
          turn.text,
          [],
          [buildConversationArtifactPrompt(artifact), turn.systemPrompt]
            .filter(Boolean)
            .join("\n\n"),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          artifact,
        );
      },
    };
    setArtifactTurnDispatcher(dispatcher);
    return () => clearArtifactTurnDispatcher(dispatcher);
  }, [artifact, sessionId, send]);
}
