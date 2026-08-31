import { useCallback, useEffect, useMemo, useState } from "react";
import { useDesktopBridge } from "@cortex-work/core";
import type {
  ImChannel,
  ImChannelInput,
  ImMode,
  ImPlatform,
  ImPlatformSpec,
} from "@cortex-work/core/desktop/im-types";
import { BareSelect, SecretField, SettingCard, SRow, SwitchRow } from "./settingsControls";

const PLATFORM_LABELS: Record<ImPlatform, string> = {
  wecom: "企业微信", feishu: "飞书", lark: "Lark", slack: "Slack", telegram: "Telegram",
  dingtalk: "钉钉", mattermost: "Mattermost", wechat: "微信", qqbot: "QQ Bot", yunzhijia: "云之家",
};
const MODE_LABELS: Record<ImMode, string> = { webhook: "Webhook", websocket: "长连接", longpoll: "长轮询" };

interface CredentialMeta { label: string; desc: string; placeholder?: string; secret?: boolean; optional?: boolean }
const CREDENTIAL_META: Record<string, CredentialMeta> = {
  bot_id: { label: "机器人 ID", desc: "在平台机器人详情或开发配置中复制。" },
  bot_secret: { label: "机器人密钥", desc: "机器人详情中的 Secret。", secret: true },
  corp_id: { label: "企业 ID (Corp ID)", desc: "企业微信管理后台 → 我的企业 → 企业信息。" },
  agent_secret: { label: "应用 Secret", desc: "企业微信自建应用详情页的 Secret。", secret: true },
  token: { label: "回调 Token", desc: "企业微信接收消息配置中自行设置的 Token。", secret: true },
  encoding_aes_key: { label: "EncodingAESKey", desc: "企业微信接收消息配置中的 43 位加密密钥。", secret: true },
  corp_agent_id: { label: "Agent ID", desc: "企业微信自建应用详情页中的 AgentId。" },
  app_id: { label: "App ID", desc: "平台开发者后台的应用凭据。" },
  app_secret: { label: "App Secret", desc: "平台开发者后台的应用密钥。", secret: true },
  verification_token: { label: "Verification Token", desc: "事件订阅或回调配置中的校验 Token。", secret: true },
  encrypt_key: { label: "Encrypt Key", desc: "事件订阅的加密密钥；未启用加密时可留空。", secret: true, optional: true },
  app_token: { label: "App-Level Token", desc: "Slack Socket Mode Token，以 xapp- 开头。", secret: true, placeholder: "xapp-…" },
  bot_token: { label: "Bot Token", desc: "机器人访问令牌。", secret: true },
  signing_secret: { label: "Signing Secret", desc: "Slack Basic Information → App Credentials。", secret: true },
  secret_token: { label: "Webhook Secret Token", desc: "Telegram setWebhook 时设置的 secret_token。", secret: true, optional: true },
  client_id: { label: "Client ID / AppKey", desc: "钉钉应用详情页的 Client ID (AppKey)。" },
  client_secret: { label: "Client Secret / AppSecret", desc: "应用详情页的 Client Secret。", secret: true },
  card_template_id: { label: "AI 卡片模板 ID", desc: "启用钉钉流式卡片时填写；不填则完整回复。", optional: true },
  site_url: { label: "Mattermost 地址", desc: "Mattermost 站点根地址。", placeholder: "https://chat.example.com" },
  outgoing_token: { label: "Outgoing Webhook Token", desc: "Mattermost Outgoing Webhook 的 Token。", secret: true },
  bot_user_id: { label: "Bot User ID", desc: "用于过滤机器人自己的消息。", optional: true },
  ilink_bot_id: { label: "iLink Bot ID", desc: "扫码确认后由微信自动返回。" },
  send_msg_url: { label: "消息发送地址", desc: "云之家机器人配置提供的 send_msg_url。", placeholder: "https://…" },
  secret: { label: "签名密钥", desc: "机器人安全设置中的签名 Secret。", secret: true, optional: true },
};

const MODE_FIELDS: Partial<Record<ImPlatform, Partial<Record<ImMode, string[]>>>> = {
  wecom: { websocket: ["bot_id", "bot_secret"], webhook: ["corp_id", "agent_secret", "token", "encoding_aes_key", "corp_agent_id"] },
  feishu: { websocket: ["app_id", "app_secret"], webhook: ["app_id", "app_secret", "verification_token", "encrypt_key"] },
  lark: { websocket: ["app_id", "app_secret"], webhook: ["app_id", "app_secret", "verification_token", "encrypt_key"] },
  slack: { websocket: ["app_token", "bot_token"], webhook: ["bot_token", "signing_secret"] },
  telegram: { longpoll: ["bot_token"], webhook: ["bot_token", "secret_token"] },
  dingtalk: { websocket: ["client_id", "client_secret", "card_template_id"], webhook: ["client_id", "client_secret", "card_template_id"] },
  mattermost: { webhook: ["site_url", "bot_token", "outgoing_token", "bot_user_id"] },
  wechat: { longpoll: ["bot_token", "ilink_bot_id"] },
  qqbot: { websocket: ["app_id", "client_secret"] },
  yunzhijia: { webhook: ["send_msg_url", "secret", "app_id", "app_secret"], websocket: ["send_msg_url", "secret", "app_id", "app_secret"] },
};

const PLATFORM_GUIDES: Partial<Record<ImPlatform, { text: string; url: string }>> = {
  wecom: { text: "打开企业微信管理后台", url: "https://work.weixin.qq.com/wework_admin/frame" },
  feishu: { text: "打开飞书开放平台", url: "https://open.feishu.cn/app" },
  lark: { text: "打开 Lark Developer Console", url: "https://open.larksuite.com/app" },
  slack: { text: "打开 Slack Apps", url: "https://api.slack.com/apps" },
  telegram: { text: "查看 Telegram Bot API", url: "https://core.telegram.org/bots/api" },
  dingtalk: { text: "打开钉钉开放平台", url: "https://open-dev.dingtalk.com/" },
  qqbot: { text: "打开 QQ 开放平台", url: "https://q.qq.com/" },
};

function emptyDraft(spec: ImPlatformSpec): ImChannelInput {
  return { id: "", name: "", platform: spec.platform, mode: spec.defaultMode, outputMode: "stream", sessionMode: "user", enabled: true, target: { kind: "personal" }, credentials: {} };
}

export function ImSettingsSection() {
  const bridge = useDesktopBridge();
  const [channels, setChannels] = useState<ImChannel[]>([]);
  const [specs, setSpecs] = useState<ImPlatformSpec[]>([]);
  const [draft, setDraft] = useState<ImChannelInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wechatQr, setWechatQr] = useState<{ qrcode: string; qrcodeUrl: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge?.imListChannels || !bridge.imListPlatformSpecs) return;
    const [nextChannels, nextSpecs] = await Promise.all([bridge.imListChannels(), bridge.imListPlatformSpecs()]);
    setChannels(nextChannels);
    setSpecs(nextSpecs);
  }, [bridge]);
  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [refresh]);

  const spec = useMemo(() => specs.find((item) => item.platform === draft?.platform), [draft?.platform, specs]);
  const fields = draft ? MODE_FIELDS[draft.platform]?.[draft.mode] ?? spec?.credentialFields ?? [] : [];
  const existing = draft?.id ? channels.find((item) => item.id === draft.id) : undefined;
  const missingFields = fields.filter((field) => !CREDENTIAL_META[field]?.optional && !draft?.credentials?.[field]?.trim());
  const canSave = !!draft?.name.trim() && (!!existing?.hasCredentials || missingFields.length === 0)
    && (draft?.target.kind !== "team" || (!!draft.target.workspaceId?.trim() && !!draft.target.agentId?.trim()));

  const openGuide = (url: string) => { void bridge?.openExternal?.(url); };
  const edit = (channel: ImChannel) => { setError(""); setDraft({ ...channel, credentials: {} }); };
  const save = async () => {
    if (!draft || !bridge?.imUpsertChannel || !canSave) return;
    setBusy(true); setError("");
    try { await bridge.imUpsertChannel(draft); setDraft(null); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (!bridge?.imDeleteChannel) return;
    setBusy(true);
    try { await bridge.imDeleteChannel(id); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const loginWechat = async () => {
    if (!bridge?.imWechatQrCode || !bridge.imWechatQrStatus || !draft) return;
    setBusy(true); setError("");
    try {
      const qr = await bridge.imWechatQrCode(); setWechatQr(qr); openGuide(qr.qrcodeUrl);
      for (;;) {
        const status = await bridge.imWechatQrStatus(qr.qrcode);
        if (status.status === "confirmed" && status.botToken && status.ilinkBotId) {
          setDraft((current) => current ? { ...current, credentials: { bot_token: status.botToken!, ilink_bot_id: status.ilinkBotId! } } : current);
          setWechatQr(null); break;
        }
        if (status.status === "expired") throw new Error("二维码已过期，请重新获取");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  if (!bridge?.imListChannels) return null;
  const guide = draft ? PLATFORM_GUIDES[draft.platform] : undefined;

  return <div className="pw-im-settings">
    <div className="pw-dlg-title">IM 渠道</div>
    <div className="pw-dlg-desc">连接一个机器人后，外部消息会进入指定的 Cortex 工作区，并由所选 Agent 回复。</div>
    {error ? <div className="pw-im-error" role="alert">{error}</div> : null}

    <SettingCard title="渠道">
      {channels.length === 0 ? <div className="pw-im-empty"><strong>还没有渠道</strong><span>选择一个平台，按向导填入机器人凭据。</span></div> : channels.map((channel) =>
        <div className="pw-srow pw-im-channel" key={channel.id}>
          <div className="pw-srow-l"><span className="pw-srow-lbl">{channel.name}</span><span className="pw-srow-desc">{PLATFORM_LABELS[channel.platform]} · {MODE_LABELS[channel.mode]} · {channel.target.kind === "personal" ? "个人工作区" : "团队工作区"}</span></div>
          <div className="pw-im-channel-state"><span className={channel.enabled ? "is-online" : ""}>{channel.enabled ? "已启用" : "已停用"}</span><button className="pw-btn-sm" onClick={() => edit(channel)}>配置</button><button className="pw-btn-sm pw-btn-sm--danger" disabled={busy} onClick={() => void remove(channel.id)}>删除</button></div>
        </div>)}
      <div className="pw-im-add"><button className="pw-btn-sm" disabled={!specs.length || busy} onClick={() => setDraft(emptyDraft(specs[0]!))}>添加 IM 渠道</button></div>
    </SettingCard>

    {draft ? <div className="pw-im-editor">
      <div className="pw-im-steps"><span className="is-active">1 平台</span><i /><span className="is-active">2 凭据</span><i /><span className="is-active">3 工作区</span></div>
      <SettingCard title={draft.id ? `配置 ${draft.name}` : "添加渠道"}>
        <SRow label="渠道名称" desc="用于在 Cortex 中区分不同机器人。"><input className="pw-set-input" value={draft.name} placeholder="例如：研发群机器人" onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></SRow>
        <SRow label="平台"><BareSelect value={draft.platform} options={specs.map((item) => ({ value: item.platform, label: PLATFORM_LABELS[item.platform] }))} onChange={(value) => { const next = specs.find((item) => item.platform === value)!; setDraft({ ...draft, platform: next.platform, mode: next.defaultMode, credentials: {} }); }} /></SRow>
        <SRow label="连接方式" desc={draft.mode === "webhook" ? "需要把本机回调地址发布到可信公网入口。" : "无需公网回调，Desktop 运行时保持连接。"}><BareSelect value={draft.mode} options={(spec?.modes ?? []).map((mode) => ({ value: mode, label: MODE_LABELS[mode] }))} onChange={(value) => setDraft({ ...draft, mode: value as ImMode, credentials: {} })} /></SRow>
        <SwitchRow label="启用渠道" desc="关闭后保留配置，但不连接平台。" value={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
      </SettingCard>

      <SettingCard title="机器人凭据">
        <div className="pw-im-credential-head"><div><strong>{PLATFORM_LABELS[draft.platform]} · {MODE_LABELS[draft.mode]}</strong><span>{existing?.hasCredentials ? "已有凭据已通过系统安全存储加密保存。只填写需要修改的字段。" : "按照平台后台显示的名称逐项复制，密钥不会暴露给页面。"}</span></div>{guide ? <button className="pw-btn-sm" onClick={() => openGuide(guide.url)}>{guide.text}</button> : null}</div>
        {draft.platform === "wechat" ? <div className="pw-im-wechat"><button className="pw-btn-sm" disabled={busy} onClick={() => void loginWechat()}>{busy ? "等待扫码确认…" : "微信扫码登录"}</button>{wechatQr ? <span>二维码已在浏览器打开</span> : null}</div> : fields.map((field) => {
          const meta = CREDENTIAL_META[field] ?? { label: field, desc: "平台提供的配置字段。" };
          const value = draft.credentials?.[field] ?? "";
          const update = (next: string) => setDraft({ ...draft, credentials: { ...draft.credentials, [field]: next } });
          return meta.secret ? <div className="pw-im-secret" key={field}><SecretField label={`${meta.label}${meta.optional ? "（可选）" : ""}`} value={value} placeholder={existing?.hasCredentials ? "已保存；留空不修改" : meta.placeholder} onChange={update} /><span>{meta.desc}</span></div> : <SRow key={field} label={`${meta.label}${meta.optional ? "（可选）" : ""}`} desc={meta.desc}><input className="pw-set-input" value={value} placeholder={existing?.hasCredentials ? "已保存；留空不修改" : meta.placeholder} onChange={(event) => update(event.target.value)} /></SRow>;
        })}
      </SettingCard>

      <SettingCard title="发送到哪个工作区">
        <SRow label="工作区类型"><BareSelect value={draft.target.kind} options={[{ value: "personal", label: "个人工作区" }, { value: "team", label: "团队工作区" }]} onChange={(value) => setDraft({ ...draft, target: { ...draft.target, kind: value as "personal" | "team" } })} /></SRow>
        {draft.target.kind === "team" ? <><SRow label="Workspace ID" desc="团队设置中的 Workspace UUID。"><input className="pw-set-input" value={draft.target.workspaceId ?? ""} onChange={(event) => setDraft({ ...draft, target: { ...draft.target, workspaceId: event.target.value } })} /></SRow><SRow label="Agent ID" desc="接收消息的团队分身 Runtime ID。"><input className="pw-set-input" value={draft.target.agentId ?? ""} onChange={(event) => setDraft({ ...draft, target: { ...draft.target, agentId: event.target.value } })} /></SRow></> : null}
      </SettingCard>

      {!canSave ? <div className="pw-im-validation">{draft.target.kind === "team" && (!draft.target.workspaceId?.trim() || !draft.target.agentId?.trim()) ? "请填写团队 Workspace ID 和 Agent ID。" : `还需填写：${missingFields.map((field) => CREDENTIAL_META[field]?.label ?? field).join("、")}`}</div> : null}
      <div className="pw-im-actions"><button className="pw-btn-sm" onClick={() => setDraft(null)}>取消</button><button className="pw-btn-sm is-primary" disabled={busy || !canSave} onClick={() => void save()}>{busy ? "正在保存…" : "保存并连接"}</button></div>
    </div> : null}
  </div>;
}
