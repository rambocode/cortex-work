import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationMeta, AutomationRun } from "../ipc/types";

const h = vi.hoisted(() => ({
  getPersistedState: vi.fn(),
  sendPush: vi.fn(),
  notificationCtor: vi.fn(),
  notificationShow: vi.fn(),
  isSupported: vi.fn(() => true),
  getAllWindows: vi.fn(() => [] as unknown[]),
}));

vi.mock("electron", () => {
  class FakeNotification {
    constructor(opts: unknown) {
      h.notificationCtor(opts);
    }
    on() {
      return this;
    }
    show() {
      h.notificationShow();
    }
    static isSupported() {
      return h.isSupported();
    }
  }
  return { Notification: FakeNotification, BrowserWindow: { getAllWindows: h.getAllWindows } };
});
vi.mock("../ipc/store", () => ({ getPersistedState: h.getPersistedState }));
vi.mock("../ipc/push", () => ({ sendPush: h.sendPush }));

import {
  dispatchAutomationPush,
  formatAutomationPush,
  isTerminalPushStatus,
  resolveNotifyChannels,
} from "./push-on-complete";

const meta = (over?: Partial<AutomationMeta>): AutomationMeta => ({
  id: "a",
  name: "每周周报",
  enabled: true,
  agent: "claude",
  prompt: "p",
  schedule: { kind: "daily", hour: 9, minute: 0 },
  createdAt: 0,
  updatedAt: 0,
  notifyChannels: ["feishu", "internal"],
  ...over,
});

const run = (over?: Partial<AutomationRun>): AutomationRun => ({
  id: "r",
  automationId: "a",
  startedAt: 0,
  status: "ok",
  trigger: "schedule",
  agent: "claude",
  prompt: "p",
  output: "做完了",
  ...over,
});

beforeEach(() => {
  h.getPersistedState.mockReset().mockResolvedValue({ pushSettings: {} });
  h.sendPush.mockReset().mockResolvedValue({ ok: true });
  h.notificationCtor.mockReset();
  h.notificationShow.mockReset();
  h.isSupported.mockReturnValue(true);
});

afterEach(() => vi.restoreAllMocks());

describe("formatAutomationPush", () => {
  it("成功:标题含名称与成功标记,正文为输出", () => {
    expect(formatAutomationPush(meta(), run({ status: "ok", output: "做完了" }))).toEqual({
      subject: "✅ 每周周报",
      text: "做完了",
    });
  });

  it("失败:标题含失败标记,正文为错误信息(error/timeout/killed 同归失败)", () => {
    expect(formatAutomationPush(meta(), run({ status: "error", error: "boom", output: "" }))).toEqual({
      subject: "⚠️ 每周周报 执行失败",
      text: "boom",
    });
    expect(formatAutomationPush(meta(), run({ status: "timeout", error: "超时", output: "" })).subject).toBe(
      "⚠️ 每周周报 执行失败",
    );
    expect(formatAutomationPush(meta(), run({ status: "killed", error: "被终止", output: "" })).text).toBe("被终止");
  });

  it("超长输出被截断并以省略号结尾", () => {
    const long = "x".repeat(5000);
    const { text } = formatAutomationPush(meta(), run({ output: long }));
    expect(text.length).toBeLessThan(long.length);
    expect(text.endsWith("…")).toBe(true);
  });

  it("成功但无输出时回退用标题兜底,避免空正文", () => {
    expect(formatAutomationPush(meta(), run({ status: "ok", output: "" })).text).toBe("✅ 每周周报");
  });
});

describe("isTerminalPushStatus", () => {
  it("ok/error/timeout/killed 为终态;running/skipped 不推送", () => {
    expect(["ok", "error", "timeout", "killed"].map(isTerminalPushStatus as (s: string) => boolean)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(isTerminalPushStatus("running")).toBe(false);
    expect(isTerminalPushStatus("skipped")).toBe(false);
  });
});

describe("resolveNotifyChannels", () => {
  it("返回 notifyChannels;为空数组即不通知", () => {
    expect(resolveNotifyChannels(meta({ notifyChannels: ["dingtalk"] }))).toEqual(["dingtalk"]);
    expect(resolveNotifyChannels(meta({ notifyChannels: [] }))).toEqual([]);
  });

  it("legacy 布尔 notify===true 兼容为全部渠道", () => {
    const legacy = meta({ notifyChannels: undefined });
    (legacy as { notify?: boolean }).notify = true;
    expect(resolveNotifyChannels(legacy)).toEqual(["wecom", "dingtalk", "feishu", "email", "internal"]);
  });

  it("既无 notifyChannels 也无 legacy notify → 不通知", () => {
    expect(resolveNotifyChannels(meta({ notifyChannels: undefined }))).toEqual([]);
  });
});

describe("dispatchAutomationPush", () => {
  it("启用飞书 + 内部通知:sendPush 收到飞书目标,且弹一次原生通知", async () => {
    h.getPersistedState.mockResolvedValue({
      pushSettings: {
        feishu: { enabled: true, webhookUrl: "https://open.feishu.cn/x", secret: "k" },
        internal: { enabled: true },
      },
    });
    await dispatchAutomationPush(meta(), run());
    expect(h.sendPush).toHaveBeenCalledTimes(1);
    expect(h.sendPush.mock.calls[0][0]).toEqual({ kind: "feishu", webhookUrl: "https://open.feishu.cn/x", secret: "k" });
    expect(h.notificationCtor).toHaveBeenCalledTimes(1);
  });

  it("只推「选中」的渠道:配置了飞书+钉钉,仅选飞书时只推飞书", async () => {
    h.getPersistedState.mockResolvedValue({
      pushSettings: {
        feishu: { enabled: true, webhookUrl: "https://open.feishu.cn/x" },
        dingtalk: { enabled: true, webhookUrl: "https://oapi.dingtalk.com/x" },
      },
    });
    await dispatchAutomationPush(meta({ notifyChannels: ["feishu"] }), run());
    expect(h.sendPush).toHaveBeenCalledTimes(1);
    expect((h.sendPush.mock.calls[0][0] as { kind: string }).kind).toBe("feishu");
  });

  it("未选 internal 时即使全局启用也不弹原生通知", async () => {
    h.getPersistedState.mockResolvedValue({
      pushSettings: {
        feishu: { enabled: true, webhookUrl: "https://open.feishu.cn/x" },
        internal: { enabled: true },
      },
    });
    await dispatchAutomationPush(meta({ notifyChannels: ["feishu"] }), run());
    expect(h.notificationCtor).not.toHaveBeenCalled();
  });

  it("notifyChannels 为空:不读设置、不发送、不通知", async () => {
    await dispatchAutomationPush(meta({ notifyChannels: [] }), run());
    expect(h.getPersistedState).not.toHaveBeenCalled();
    expect(h.sendPush).not.toHaveBeenCalled();
    expect(h.notificationCtor).not.toHaveBeenCalled();
  });

  it("内部通知未启用时不弹原生通知", async () => {
    h.getPersistedState.mockResolvedValue({
      pushSettings: { feishu: { enabled: true, webhookUrl: "https://open.feishu.cn/x" } },
    });
    await dispatchAutomationPush(meta(), run());
    expect(h.notificationCtor).not.toHaveBeenCalled();
  });

  it("无任何渠道启用:不发送、不通知、不抛", async () => {
    h.getPersistedState.mockResolvedValue({ pushSettings: {} });
    await expect(dispatchAutomationPush(meta(), run())).resolves.toBeUndefined();
    expect(h.sendPush).not.toHaveBeenCalled();
    expect(h.notificationCtor).not.toHaveBeenCalled();
  });

  it("渠道失败仅记日志,不抛;日志不含 webhookUrl/密钥", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.getPersistedState.mockResolvedValue({
      pushSettings: { feishu: { enabled: true, webhookUrl: "https://open.feishu.cn/SECRET_TOKEN", secret: "SIGN_SECRET_VALUE" } },
    });
    h.sendPush.mockResolvedValue({ ok: false, error: "sign match fail" });
    await expect(dispatchAutomationPush(meta(), run())).resolves.toBeUndefined();
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("SECRET_TOKEN");
    expect(logged).not.toContain("SIGN_SECRET_VALUE");
  });

  it("读盘异常被吞,不冒泡", async () => {
    h.getPersistedState.mockRejectedValue(new Error("disk fail"));
    await expect(dispatchAutomationPush(meta(), run())).resolves.toBeUndefined();
  });
});
