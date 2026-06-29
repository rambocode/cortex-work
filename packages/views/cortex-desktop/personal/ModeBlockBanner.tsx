// 运行模式拦截提示条:plan/accept-edits 模式下 agent 尝试被禁工具(写/执行)被拦时,
// 在消息流与输入框之间提示用户切档,点按钮即切换会话模式并自动重发本轮 prompt。
// 数据源:usePersonalStore.modeBlockHints[sessionId]（瞬态,由 messages.ts 轮结束时写入）。

import type { PermissionMode, SessionMeta } from "@cortex-work/core";
import { fromAdapterPermissions, usePersonalActions, usePersonalStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";

const AGENT_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

export function ModeBlockBanner({ session, projectPath }: { session: SessionMeta; projectPath: string }) {
  const { t } = useTranslation("chat");
  const hint = usePersonalStore((s) => s.modeBlockHints[session.id]);
  const running = usePersonalStore((s) => !!s.runningBySession[session.id]);
  const setModeBlockHint = usePersonalStore((s) => s.setModeBlockHint);
  const updateSession = usePersonalStore((s) => s.updateSession);
  const { send } = usePersonalActions();

  // 运行中不打扰(本轮还没结束);无提示则不渲染。
  if (!hint || running) return null;

  const name = AGENT_LABEL[session.agent] ?? session.agent;
  // 文案:按来源档 + 被拦类别选。
  const msgKey =
    hint.fromMode === "plan"
      ? hint.category === "edit"
        ? "composer.modeBlock.planEdit"
        : hint.category === "tool"
          ? "composer.modeBlock.planTool"
          : "composer.modeBlock.planExec"
      : "composer.modeBlock.acceptEditsExec";

  // 可切到的目标档:写类被拦 → accept-edits / full-auto;执行类 / 白名单外工具 → 仅 full-auto
  //（accept-edits 不放行任意工具,只有 full-auto 能让扩展工具跑起来）。
  const targets: PermissionMode[] = hint.category === "edit" ? ["accept-edits", "full-auto"] : ["full-auto"];

  const switchAndResend = (target: PermissionMode) => {
    const promptText = hint.promptText;
    // 目标线格式档 → 新两轴(exec/dir):离开 plan(exec=auto)并设目录范围(accept-edits→workspace /
    // full-auto→all)。send 现从 session.exec/dirPermission 派生,旧式塞 permissionMode 会被忽略,故必须写新两轴。
    const patch = fromAdapterPermissions(target, "auto");
    updateSession(session.id, patch);
    setModeBlockHint(session.id, undefined);
    void send({ ...session, ...patch }, projectPath, promptText, []);
  };

  return (
    <div className="pw-mode-block" role="status">
      <span className="pw-mode-block-text">{t(msgKey, { name })}</span>
      <div className="pw-mode-block-actions">
        {targets.map((target) => (
          <button
            key={target}
            type="button"
            className="pw-mode-block-btn primary"
            onClick={() => switchAndResend(target)}
          >
            {t(
              target === "accept-edits"
                ? "composer.modeBlock.switchAcceptEdits"
                : "composer.modeBlock.switchFullAuto",
            )}
          </button>
        ))}
        <button type="button" className="pw-mode-block-btn" onClick={() => setModeBlockHint(session.id, undefined)}>
          {t("composer.modeBlock.dismiss")}
        </button>
      </div>
    </div>
  );
}
