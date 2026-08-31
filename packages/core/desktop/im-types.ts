export const IM_PLATFORMS = ["wecom", "feishu", "lark", "slack", "telegram", "dingtalk", "mattermost", "wechat", "qqbot", "yunzhijia"] as const;
export type ImPlatform = (typeof IM_PLATFORMS)[number];
export type ImMode = "webhook" | "websocket" | "longpoll";
export type ImOutputMode = "stream" | "full";
export interface ImWorkspaceTarget { kind: "personal" | "team"; workspaceId?: string; agentId?: string; projectId?: string }
export interface ImExecutionConfig { agent?: "claude" | "codex" | "pi"; providerId?: string; model?: string; cwd?: string }
export interface ImChannel {
  id: string; name: string; platform: ImPlatform; mode: ImMode; outputMode: ImOutputMode;
  sessionMode: "user" | "thread"; enabled: boolean; target: ImWorkspaceTarget; execution?: ImExecutionConfig; hasCredentials: boolean;
}
export interface ImChannelInput extends Omit<ImChannel, "hasCredentials"> { credentials?: Record<string, string> }
export interface ImChannelStatus { id: string; state: "disabled" | "ready" | "running" | "error"; message?: string; updatedAt: string }
export interface ImPlatformSpec { platform: ImPlatform; modes: ImMode[]; defaultMode: ImMode; credentialFields: string[] }
export interface ImWechatQrCode { qrcode: string; qrcodeUrl: string }
export interface ImWechatLogin { status: "wait"|"scaned"|"confirmed"|"expired"; botToken?: string; ilinkBotId?: string }
