// 团队会话区（分身/成员 Contact，即 contact.kind 有值时由 CortexDesktopView 分流至此）：
// 在 ChatArea 导出的 ChatHeader/MessageStream/Composer 之上拼装团队态——真人不可聊、
// 分身离线/不可用、零消息空态、进行中禁用+取消、排队态、终态横幅，以及
// 「(runtime · 服务器工作区)」选择 pill + 弹层。ChatArea 本体零改动（已逼近行数上限）。
// 文案走 i18n common:teamChat.*。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useCortexActions, useServerWorkspaces, useTeamUIStore, useWorkspaceId } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  avatarOutcomeBanner,
  getAvatarSession,
  hasVisibleAvatarReply,
  isSessionBusy,
} from "@cortex-work/core/cortex/session-stream";
import type { Contact } from "@cortex-work/core/types";
import { ChatHeader, Composer, MessageStream, type ChatAreaProps } from "../ChatArea";
import { AvatarOutcomeBanner, BusyComposer, CenteredNotice, DisabledComposer } from "./TeamChatStates";
import { ServerWorkspacePicker } from "./ServerWorkspacePicker";

export function TeamChatArea({ contact, convo, onSelectFile, activeFile, onSend, onApprove, onToast }: ChatAreaProps) {
  // 取消动作经 useCortexActions 自服务（无需 CortexDesktopView 额外传 prop）；hooks 必须在早退前调用。
  const { t } = useTranslation();
  const wsId = useWorkspaceId();
  const { cancelSession } = useCortexActions(wsId);
  // 选择态用 hook 订阅（选定/清除工作区要触发本组件重渲，切换离线降级/可发送分支）。
  const selection = useTeamUIStore((s) => (contact ? s.selection[contact.id] : undefined));

  if (!contact) return <main className="chat" />;

  // 团队两级：真人条目不可聊；分身按在线三态区分（offline / unavailable / online）。
  const isHuman = contact.kind === "human";
  const isAvatar = contact.kind === "avatar";
  const offline = contact.agentStatus === "offline";
  const unavailable = contact.agentStatus === "unavailable";

  const session = isAvatar ? getAvatarSession(convo) : null;
  const busy = isSessionBusy(session);
  const busyHasReply = hasVisibleAvatarReply(session?.rows ?? []);
  const banner = avatarOutcomeBanner(session?.outcome);
  const handleCancel = () => cancelSession(contact.id, contact);

  if (isHuman) {
    // 真人可见不可聊，展示降级提示，无输入框。
    return (
      <main className="chat">
        <ChatHeader contact={contact} convo={convo} />
        <CenteredNotice contact={contact} title={contact.name} hint={t("teamChat.humanHint")} />
        <DisabledComposer text={t("teamChat.humanDisabled")} />
      </main>
    );
  }

  // 分身离线/不可用：可回看历史（有则渲染 MessageStream），但禁止发起、文案区分。
  // 注意：选定了服务器工作区时不受分身本体在线态限制（执行点在服务器 daemon），
  // 故仅在「未选服务器工作区」时才走离线降级。
  if (isAvatar && (offline || unavailable) && !selection) {
    const title = unavailable ? t("teamChat.unavailableTitle") : t("teamChat.offlineTitle");
    const hint = unavailable ? t("teamChat.unavailableHint") : t("teamChat.offlineHint");
    return (
      <main className="chat">
        <ChatHeader contact={contact} convo={convo} />
        {convo ? (
          <MessageStream
            contact={contact}
            convo={convo}
            onSelectFile={onSelectFile}
            activeFile={activeFile}
            onApprove={onApprove}
            markdownBodies
          />
        ) : (
          <CenteredNotice contact={contact} title={title} hint={hint} />
        )}
        <ComposerWithWorkspace contact={contact} onSend={onSend} onToast={onToast} disabledText={title} />
      </main>
    );
  }

  // 在线分身零消息空态：给出可发起提问的引导文案。
  if (isAvatar && !convo) {
    return (
      <main className="chat">
        <ChatHeader contact={contact} convo={convo} />
        <CenteredNotice contact={contact} title={contact.name} hint={t("teamChat.emptyHint")} />
        <ComposerWithWorkspace contact={contact} onSend={onSend} onToast={onToast} />
      </main>
    );
  }

  return (
    <main className="chat">
      <ChatHeader contact={contact} convo={convo} />
      <MessageStream
        contact={contact}
        convo={convo}
        onSelectFile={onSelectFile}
        activeFile={activeFile}
        onApprove={onApprove}
        markdownBodies={isAvatar}
      />
      {/* 终态横幅（非进行中且非 done 时）：明确告知会话结局，无静默失败。 */}
      {isAvatar && banner && !busy ? <AvatarOutcomeBanner text={banner} /> : null}
      {/* 输入区：进行中 → 禁用 + 取消（排队态含位次提示）；否则 Composer + 工作区选择 pill。 */}
      {isAvatar && busy ? (
        <BusyComposer
          phase={session?.phase ?? "running"}
          hasReply={busyHasReply}
          queuedBehind={session?.queuedBehind}
          onCancel={handleCancel}
        />
      ) : (
        <ComposerWithWorkspace contact={contact} onSend={onSend} onToast={onToast} />
      )}
    </main>
  );
}

// Composer + 服务器工作区选择 pill：pill 显示当前 (工作区名 · 共享/独立)，点开两级选择弹层。
// disabledText 非空时（分身离线且未选工作区）输入区退化为提示条，但 pill 仍可用——
// 选定工作区后组件树切回可发送路径。
function ComposerWithWorkspace({
  contact,
  onSend,
  onToast,
  disabledText,
}: {
  contact: Contact;
  onSend: (text: string) => void;
  onToast: (text: string) => void;
  disabledText?: string;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const selection = useTeamUIStore((s) => s.selection[contact.id]);
  const setSelection = useTeamUIStore((s) => s.setSelection);
  const { data } = useServerWorkspaces();
  const selected = selection
    ? data?.workspaces.find((w) => w.id === selection.serverWorkspaceId)
    : undefined;
  // 选择已失效（工作区被删/归档）→ 自动清除，回落分身直连语义（effect 中做，渲染期不写 store）。
  const staleSelection = !!selection && !!data && !selected;
  useEffect(() => {
    if (staleSelection) setSelection(contact.id, undefined);
  }, [staleSelection, contact.id, setSelection]);

  return (
    <div className="serverws-composer-wrap">
      <div className="serverws-pill-row">
        <button
          className={`serverws-pill ${selected ? "is-set" : ""}`}
          title={t("teamChat.pillTitle")}
          onClick={() => setPickerOpen((v) => !v)}
        >
          <Icon.Globe size={12} />
          <span>
            {selected
              ? `${selected.name} · ${selected.mode === "shared" ? t("teamChat.modeSharedShort") : t("teamChat.modeIsolatedShort")}`
              : t("teamChat.pillPlaceholder")}
          </span>
          <Icon.Chevron size={11} />
        </button>
        {selected ? (
          <button className="serverws-pill-clear" title={t("teamChat.pillClear")} onClick={() => setSelection(contact.id, undefined)}>
            <Icon.X size={11} />
          </button>
        ) : null}
        {pickerOpen ? <ServerWorkspacePicker targetId={contact.id} onClose={() => setPickerOpen(false)} /> : null}
      </div>
      {disabledText ? <DisabledComposer text={disabledText} /> : <Composer contact={contact} onSend={onSend} onToast={onToast} />}
    </div>
  );
}
