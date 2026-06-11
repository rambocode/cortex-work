// 日报推送：企业微信 / 钉钉机器人 webhook、SMTP 邮件。
// 在主进程发请求：webhook 不允许浏览器跨域,且 secret/SMTP 密码不出 main。

import { ipcMain } from "electron";
import nodemailer from "nodemailer";
import { dingtalkSignedUrl } from "./push-sign";

interface EmailSmtp {
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

type PushTarget =
  | { kind: "wecom"; webhookUrl: string }
  | { kind: "dingtalk"; webhookUrl: string; secret?: string }
  | { kind: "email"; smtp: EmailSmtp };

interface PushPayload {
  subject: string;
  text: string;
}

const FETCH_TIMEOUT_MS = 10_000;

function assertWebhookHost(url: string, allowed: string): void {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.hostname !== allowed) {
    throw new Error(`webhook 地址必须是 https://${allowed}/…`);
  }
}

// 机器人接口统一形如 {errcode|errcode:0} 表示成功。
async function postJson(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const data = (await res.json().catch(() => null)) as { errcode?: number; errmsg?: string } | null;
  if (data && typeof data.errcode === "number" && data.errcode !== 0) {
    return { ok: false, error: data.errmsg ?? `errcode ${data.errcode}` };
  }
  return { ok: true };
}

async function pushWecom(webhookUrl: string, payload: PushPayload): Promise<{ ok: boolean; error?: string }> {
  assertWebhookHost(webhookUrl, "qyapi.weixin.qq.com");
  // 企微 markdown 消息,标题加粗。
  return postJson(webhookUrl, {
    msgtype: "markdown",
    markdown: { content: `**${payload.subject}**\n${payload.text.replace(payload.subject, "").trim()}` },
  });
}

async function pushDingtalk(
  webhookUrl: string,
  secret: string | undefined,
  payload: PushPayload,
): Promise<{ ok: boolean; error?: string }> {
  assertWebhookHost(webhookUrl, "oapi.dingtalk.com");
  const url = secret ? dingtalkSignedUrl(webhookUrl, secret, Date.now()) : webhookUrl;
  // 钉钉 text 消息;机器人若设置了关键词,subject 在 content 内即可命中。
  return postJson(url, { msgtype: "text", text: { content: payload.text } });
}

async function pushEmail(smtp: EmailSmtp, payload: PushPayload): Promise<{ ok: boolean; error?: string }> {
  const transporter = nodemailer.createTransport({
    host: smtp.smtpHost,
    port: smtp.smtpPort,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: FETCH_TIMEOUT_MS,
  });
  try {
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to: smtp.to,
      subject: payload.subject,
      text: payload.text,
    });
    return { ok: true };
  } finally {
    transporter.close();
  }
}

export function registerPushHandlers(): void {
  ipcMain.handle("push:report", async (_e, target: PushTarget, payload: PushPayload) => {
    try {
      if (target.kind === "wecom") return await pushWecom(target.webhookUrl, payload);
      if (target.kind === "dingtalk") return await pushDingtalk(target.webhookUrl, target.secret, payload);
      return await pushEmail(target.smtp, payload);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
