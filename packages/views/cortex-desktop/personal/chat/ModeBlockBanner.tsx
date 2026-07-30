// 运行模式拦截提示条:plan(计划/只读)模式下 agent 尝试被禁工具(写/执行)被拦时,
// 在消息流与输入框之间提示用户,点按钮即切「自动执行」并自动重发本轮 prompt。
// 数据源:usePersonalStore.modeBlockHints[sessionId]（瞬态,由 messages.ts 轮结束时写入,仅 plan 会触发）。

import type { SessionMeta } from "@cortex-work/core";
import { usePersonalActions, usePersonalStore } from "@cortex-work/core";
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
  // 文案按被拦类别选(提示仅由 plan 触发)。
  const msgKey =
    hint.category === "edit"
      ? "composer.modeBlock.planEdit"
      : hint.category === "tool"
        ? "composer.modeBlock.planTool"
        : "composer.modeBlock.planExec";

  // 一键切「自动执行」并重发:send 从 session.execPermission 派生线格式,故直接写 exec 单轴。
  const switchAndResend = () => {
    const promptText = hint.promptText;
    const patch = { execPermission: "auto" as const };
    updateSession(session.id, patch);
    setModeBlockHint(session.id, undefined);
    void send({ ...session, ...patch }, projectPath, promptText, []);
  };

  return (
    <div className="pw-mode-block" role="status">
      <span className="pw-mode-block-text">{t(msgKey, { name })}</span>
      <div className="pw-mode-block-actions">
        <button type="button" className="pw-mode-block-btn primary" onClick={switchAndResend}>
          {t("composer.modeBlock.switchFullAuto")}
        </button>
        <button type="button" className="pw-mode-block-btn" onClick={() => setModeBlockHint(session.id, undefined)}>
          {t("composer.modeBlock.dismiss")}
        </button>
      </div>
    </div>
  );
}
