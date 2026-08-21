// 团队会话的状态化 UI 小件（自 feat/team-avatar-invocation 分支迁入并扩展排队态）：
// CenteredNotice（降级/空态提示）/ DisabledComposer（不可发起）/ BusyComposer（进行中 +
// 排队中）/ AvatarOutcomeBanner（终态横幅）。文案走 i18n common:teamChat.*。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import type { Contact } from "@cortex-work/core/types";
import type { AvatarSessionState } from "@cortex-work/core/cortex/session-stream";

// 居中的降级/空态提示块（真人不可聊、分身离线/不可用、分身零消息）。
export function CenteredNotice({ contact, title, hint }: { contact: Contact; title: string; hint: string }) {
  return (
    <div className="msgs">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--text-3)",
          fontSize: 13,
          flexDirection: "column",
          gap: 10,
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: contact.avatar.bg,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 600,
            fontSize: 16,
          }}
        >
          {contact.avatar.initials}
        </div>
        <div style={{ color: "var(--text-1)", fontSize: 14, fontWeight: 500 }}>{title}</div>
        <div style={{ maxWidth: 320 }}>{hint}</div>
      </div>
    </div>
  );
}

// 不可发起会话时替代输入框的静态提示条（保持底部占位一致，避免布局跳动）。
export function DisabledComposer({ text }: { text: string }) {
  return (
    <div className="composer-wrap">
      <div className="composer" style={{ opacity: 0.75 }}>
        <div className="input-area" style={{ color: "var(--text-4)", fontSize: 13, padding: "10px 4px" }}>
          {text}
        </div>
      </div>
    </div>
  );
}

// 会话进行中的输入区替身：禁用输入 + 取消按钮（取消后 partial 保留）。
// phase 分四态文案：排队（服务器共享工作区被占用）/ 等待拥有者确认 / 收尾中 / 思考中。
// 实时已等待秒数:纯本地计时(挂载即从 0 起算,busy 结束时组件卸载自然清零)——跳动的秒数
// 本身即证明「仍在等待、并非冻结」,零额外数据层改动。
export function BusyComposer({
  phase,
  hasReply,
  queuedBehind,
  onCancel,
}: {
  phase: AvatarSessionState["phase"];
  hasReply?: boolean;
  queuedBehind?: number;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const hint =
    phase === "queued"
      ? queuedBehind && queuedBehind > 0
        ? t("teamChat.queuedAhead", { n: queuedBehind })
        : t("teamChat.queuedWaiting")
      : phase === "waiting_approval"
        ? t("teamChat.waitingApproval")
        : hasReply
          ? t("teamChat.finishing")
          : t("teamChat.thinking");
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);
  return (
    <div className="composer-wrap">
      <div className="composer" style={{ opacity: 0.85 }}>
        <div className="input-area" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 4px" }}>
          <span className="spinner" />
          <span style={{ color: "var(--text-3)", fontSize: 13, flex: 1 }}>
            {hint}
            {elapsed > 0 ? t("teamChat.waitedFor", { s: elapsed }) : ""}
          </span>
          <button
            className="btn danger-ghost"
            onClick={onCancel}
            title={phase === "queued" ? t("teamChat.cancelQueue") : t("teamChat.cancelAsk")}
          >
            <Icon.X size={13} />
            {t("teamChat.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

// 会话终态横幅：非 done 的终态在输入区上方给出明确提示（8 终态各自文案，见 session-stream）。
export function AvatarOutcomeBanner({ text }: { text: string }) {
  return (
    <div
      className="avatar-outcome-banner"
      style={{
        margin: "0 16px 8px",
        padding: "8px 12px",
        borderRadius: 8,
        background: "var(--surface-2, rgba(0,0,0,0.04))",
        color: "var(--text-2)",
        fontSize: 12.5,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}
