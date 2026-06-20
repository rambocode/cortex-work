// 全局推送渠道设置 → 已启用的「外部推送目标」列表(纯函数,React-free)。
// 刻意不依赖 react / store,主进程(自动化完成后推送)与渲染端(日报一键推送)共用同一份。
// 内部通知(Electron 原生系统通知)不是 webhook 目标,不在此列,由完成后推送逻辑单独处理。
import type { PushSettings, PushTarget } from "../desktop/types";

export function enabledPushTargets(push: PushSettings): { label: string; target: PushTarget }[] {
  const out: { label: string; target: PushTarget }[] = [];
  const { wecom, dingtalk, feishu, email } = push;
  if (wecom?.enabled && wecom.webhookUrl) {
    out.push({ label: "企业微信", target: { kind: "wecom", webhookUrl: wecom.webhookUrl } });
  }
  if (dingtalk?.enabled && dingtalk.webhookUrl) {
    out.push({
      label: "钉钉",
      target: { kind: "dingtalk", webhookUrl: dingtalk.webhookUrl, secret: dingtalk.secret || undefined },
    });
  }
  if (feishu?.enabled && feishu.webhookUrl) {
    out.push({
      label: "飞书",
      target: { kind: "feishu", webhookUrl: feishu.webhookUrl, secret: feishu.secret || undefined },
    });
  }
  if (email?.enabled && email.smtpHost && email.to) {
    const { enabled: _enabled, ...smtp } = email;
    out.push({ label: "邮件", target: { kind: "email", smtp } });
  }
  return out;
}
