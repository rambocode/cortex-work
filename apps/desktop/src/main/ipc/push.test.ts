import { afterEach, describe, expect, it, vi } from "vitest";

// push.ts 顶部 import electron 的 ipcMain;单测只用 sendPush/feishuBody,故打桩 electron。
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { feishuBody, sendPush } from "./push";

const payload = { subject: "✅ 每周周报", text: "本周完成了 X、Y、Z。" };

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("feishuBody", () => {
  it("无 secret 时不含 timestamp/sign", () => {
    const b = feishuBody(payload, undefined, 1700000000);
    expect(b).not.toHaveProperty("sign");
    expect(b).not.toHaveProperty("timestamp");
    expect(b.msg_type).toBe("text");
  });

  it("有 secret 时含 timestamp(字符串秒)与 sign", () => {
    const b = feishuBody(payload, "s", 1700000000) as { timestamp: string; sign: string };
    expect(b.timestamp).toBe("1700000000");
    expect(typeof b.sign).toBe("string");
    expect(b.sign.length).toBeGreaterThan(0);
  });

  it("正文带 subject 以命中关键词模式,但 text 已含 subject 时不重复", () => {
    const withSubj = feishuBody({ subject: "标题", text: "正文" }, undefined, 1) as { content: { text: string } };
    expect(withSubj.content.text).toBe("标题\n正文");
    const already = feishuBody({ subject: "标题", text: "标题\n正文" }, undefined, 1) as { content: { text: string } };
    expect(already.content.text).toBe("标题\n正文");
  });
});

describe("sendPush 成功/失败判定(飞书 code)", () => {
  it("飞书 code:0 判成功", async () => {
    mockFetch(200, { code: 0, msg: "success" });
    expect(await sendPush({ kind: "feishu", webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/x" }, payload)).toEqual({ ok: true });
  });

  it("飞书 code 非 0 判失败并带 msg", async () => {
    mockFetch(200, { code: 19021, msg: "sign match fail" });
    expect(await sendPush({ kind: "feishu", webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/x" }, payload)).toEqual({ ok: false, error: "sign match fail" });
  });

  it("非 2xx 仍解析体,回显 msg 而非裸 HTTP 状态", async () => {
    mockFetch(400, { code: 19022, msg: "Ip Not Allowed" });
    expect(await sendPush({ kind: "feishu", webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/x" }, payload)).toEqual({ ok: false, error: "Ip Not Allowed" });
  });

  it("国际版 open.larksuite.com 也放行", async () => {
    mockFetch(200, { code: 0 });
    expect(await sendPush({ kind: "feishu", webhookUrl: "https://open.larksuite.com/open-apis/bot/v2/hook/x" }, payload)).toEqual({ ok: true });
  });
});

describe("sendPush 既有渠道非回归", () => {
  it("企微 errcode:0 仍判成功(无 code 字段不影响)", async () => {
    mockFetch(200, { errcode: 0 });
    expect(await sendPush({ kind: "wecom", webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x" }, payload)).toEqual({ ok: true });
  });

  it("钉钉 errcode 非 0 判失败带 errmsg", async () => {
    mockFetch(200, { errcode: 310000, errmsg: "keywords not in content" });
    expect(await sendPush({ kind: "dingtalk", webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=x" }, payload)).toEqual({ ok: false, error: "keywords not in content" });
  });
});

describe("sendPush 安全边界", () => {
  it("飞书非白名单 host 失败,且错误不含完整 URL(无 token 泄漏)", async () => {
    mockFetch(200, { code: 0 });
    const res = await sendPush({ kind: "feishu", webhookUrl: "https://evil.example.com/hook/SECRET_TOKEN" }, payload);
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain("SECRET_TOKEN");
  });

  it("非 https 飞书 webhook 失败", async () => {
    mockFetch(200, { code: 0 });
    expect((await sendPush({ kind: "feishu", webhookUrl: "http://open.feishu.cn/hook/x" }, payload)).ok).toBe(false);
  });

  it("未知 kind 命中 default 拒绝,不误路由到 email", async () => {
    const res = await sendPush({ kind: "telegram", webhookUrl: "x" } as unknown as Parameters<typeof sendPush>[0], payload);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("未知推送渠道");
  });
});
