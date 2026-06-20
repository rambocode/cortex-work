// 推送渠道：企业微信 / 钉钉 / 飞书机器人 webhook、SMTP 邮件。
// 在主进程发请求：webhook 不允许浏览器跨域,且 secret/SMTP 密码不出 main。
// sendPush 同时被 push:report IPC(渲染端日报)与自动化 runner(完成后推送)复用。

import { ipcMain } from "electron";
import nodemailer from "nodemailer";
import { dingtalkSignedUrl, feishuSign } from "./push-sign";

interface EmailSmtp {
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

// 本类型与 core/desktop/types.ts 的 PushTarget 镜像,两侧须同步。
type PushTarget =
  | { kind: "wecom"; webhookUrl: string }
  | { kind: "dingtalk"; webhookUrl: string; secret?: string }
  | { kind: "feishu"; webhookUrl: string; secret?: string }
  | { kind: "email"; smtp: EmailSmtp };

interface PushPayload {
  subject: string;
  text: string;
}

const FETCH_TIMEOUT_MS = 10_000;

// allowed 可为单 host 或 host 集合(飞书有国内 open.feishu.cn / 国际 open.larksuite.com 两域)。
// 错误信息只含 host 白名单,绝不回显完整 URL(避免 webhook token 入日志)。
function assertWebhookHost(url: string, allowed: string | string[]): void {
  const u = new URL(url);
  const hosts = Array.isArray(allowed) ? allowed : [allowed];
  if (u.protocol !== "https:" || !hosts.includes(u.hostname)) {
    throw new Error(`webhook 地址必须是 https://${hosts.join(" 或 ")}/…`);
  }
}

// 机器人接口成功判定:企微/钉钉用 errcode、飞书用 code,均 0 为成功。
// 即便 HTTP 非 2xx 也先解析体,优先回显 errmsg/msg(如飞书 19022 IP 未白名单),
// 避免提前返回裸 HTTP 状态吞掉错误码;错误信息绝不拼接 url/body(防签名/密钥入日志)。
async function postJson(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => null)) as
    | { errcode?: number; errmsg?: string; code?: number; msg?: string }
    | null;
  const errcode = typeof data?.errcode === "number" ? data.errcode : undefined;
  const code = typeof data?.code === "number" ? data.code : undefined;
  if ((errcode != null && errcode !== 0) || (code != null && code !== 0)) {
    return { ok: false, error: data?.errmsg ?? data?.msg ?? `HTTP ${res.status}` };
  }
  // 没有明确成功/失败码时回退 HTTP 状态。
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
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

// 飞书文本消息体(纯函数,便于单测)。有 secret 时把 timestamp(秒)与 sign 放进
// body(飞书加签放体内,不进 URL,见 feishuSign)。正文带 subject 以命中「关键词」安全模式。
export function feishuBody(
  payload: PushPayload,
  secret: string | undefined,
  timestampSec: number,
): Record<string, unknown> {
  const text = payload.text.includes(payload.subject) ? payload.text : `${payload.subject}\n${payload.text}`;
  const base = { msg_type: "text", content: { text } };
  if (!secret) return base;
  return { timestamp: String(timestampSec), sign: feishuSign(secret, timestampSec), ...base };
}

async function pushFeishu(
  webhookUrl: string,
  secret: string | undefined,
  payload: PushPayload,
): Promise<{ ok: boolean; error?: string }> {
  assertWebhookHost(webhookUrl, ["open.feishu.cn", "open.larksuite.com"]);
  const timestampSec = Math.floor(Date.now() / 1000);
  return postJson(webhookUrl, feishuBody(payload, secret, timestampSec));
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

// 统一推送入口:渠道分发 + 兜底 try/catch(assertWebhookHost 等抛错转为结果对象,绝不抛出)。
// default 分支显式拒绝未知 kind,绝不 fall-through 到 email(pushEmail 接受 renderer 自填
// 任意 SMTP host,误路由会扩大 SSRF/凭据面)。错误信息已在各层去除 URL/密钥。
export async function sendPush(
  target: PushTarget,
  payload: PushPayload,
): Promise<{ ok: boolean; error?: string }> {
  try {
    switch (target.kind) {
      case "wecom":
        return await pushWecom(target.webhookUrl, payload);
      case "dingtalk":
        return await pushDingtalk(target.webhookUrl, target.secret, payload);
      case "feishu":
        return await pushFeishu(target.webhookUrl, target.secret, payload);
      case "email":
        return await pushEmail(target.smtp, payload);
      default: {
        const _exhaustive: never = target;
        void _exhaustive;
        return { ok: false, error: `未知推送渠道:${(target as { kind?: string }).kind ?? "?"}` };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerPushHandlers(): void {
  ipcMain.handle("push:report", (_e, target: PushTarget, payload: PushPayload) => sendPush(target, payload));
}
