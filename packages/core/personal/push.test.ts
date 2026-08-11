import { describe, expect, it } from "vitest";
import { enabledPushTargets } from "./push";
import type { PushSettings } from "../desktop/types";

describe("enabledPushTargets", () => {
  it("飞书启用且有 webhookUrl 时返回飞书目标,透传 secret", () => {
    const push: PushSettings = { feishu: { enabled: true, webhookUrl: "https://open.feishu.cn/x", secret: "k" } };
    expect(enabledPushTargets(push)).toEqual([
      { label: "飞书", target: { kind: "feishu", webhookUrl: "https://open.feishu.cn/x", secret: "k" } },
    ]);
  });

  it("飞书空 secret 归 undefined", () => {
    const push: PushSettings = { feishu: { enabled: true, webhookUrl: "https://open.feishu.cn/x", secret: "" } };
    expect(enabledPushTargets(push)[0]?.target).toEqual({ kind: "feishu", webhookUrl: "https://open.feishu.cn/x", secret: undefined });
  });

  it("飞书未启用或 webhookUrl 空时不返回飞书目标", () => {
    expect(enabledPushTargets({ feishu: { enabled: false, webhookUrl: "https://open.feishu.cn/x" } })).toEqual([]);
    expect(enabledPushTargets({ feishu: { enabled: true, webhookUrl: "" } })).toEqual([]);
  });

  it("既有渠道(企微/钉钉/邮件)行为不回归,且 internal 不进目标列表", () => {
    const push: PushSettings = {
      wecom: { enabled: true, webhookUrl: "https://qyapi.weixin.qq.com/x" },
      dingtalk: { enabled: true, webhookUrl: "https://oapi.dingtalk.com/x", secret: "s" },
      email: { enabled: true, smtpHost: "smtp.x.com", smtpPort: 465, secure: true, user: "u", pass: "p", from: "u", to: "t@x.com" },
      internal: { enabled: true },
    };
    const out = enabledPushTargets(push);
    expect(out.map((o) => o.target.kind)).toEqual(["wecom", "dingtalk", "email"]);
  });

});
