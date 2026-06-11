import { describe, expect, it } from "vitest";
import type { PersistedState, PushSettings } from "../desktop/types";
import { usePersonalStore, toPersistedState } from "./personal";

const base: PersistedState = { version: 1, projects: [], sessions: [] };

describe("hydrate 推送设置迁移", () => {
  it("旧数据（timelineSettings.push）迁移到全局 pushSettings", () => {
    const legacy = {
      ...base,
      timelineSettings: {
        summaryModel: { kind: "agent", agent: "claude", model: "haiku" },
        push: { wecom: { enabled: true, webhookUrl: "https://qyapi.weixin.qq.com/x" } },
      } as PersistedState["timelineSettings"] & { push: PushSettings },
    };
    usePersonalStore.getState().hydrate(legacy);
    expect(usePersonalStore.getState().pushSettings.wecom?.webhookUrl).toBe("https://qyapi.weixin.qq.com/x");
  });

  it("新数据 pushSettings 优先,持久化快照含两份设置", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      pushSettings: { dingtalk: { enabled: true, webhookUrl: "https://oapi.dingtalk.com/x" } },
    });
    const s = usePersonalStore.getState();
    expect(s.pushSettings.dingtalk?.enabled).toBe(true);
    const persisted = toPersistedState(s);
    expect(persisted.pushSettings).toBe(s.pushSettings);
    expect(persisted.timelineSettings).toBe(s.timelineSettings);
  });
});
