// applyPushSettingsSnapshot 单测:pushSettings 镜像写入的两条关键性质——
// 1) 内容变化时只替换 pushSettings 单切片;2) 内容相等时跳过写入(引用不变,防
// 主窗口「save→广播回声→再 save」回环,见 usePushSettingsSync 头注)。

import { describe, it, expect, beforeEach } from "vitest";
import { applyPushSettingsSnapshot } from "./usePushSettingsSync";
import { usePersonalStore } from "../store/personal";
import { DEFAULT_PUSH_SETTINGS } from "./types";

beforeEach(() => {
  usePersonalStore.setState({ pushSettings: DEFAULT_PUSH_SETTINGS });
});

describe("applyPushSettingsSnapshot", () => {
  it("内容变化:写入新快照(未 hydrate 窗口从默认空对象更新为权威值)", () => {
    applyPushSettingsSnapshot({ internal: { enabled: true } });
    expect(usePersonalStore.getState().pushSettings.internal?.enabled).toBe(true);
  });

  it("内容相等:跳过写入,引用不变(防广播回声触发持久化订阅回环)", () => {
    applyPushSettingsSnapshot({ internal: { enabled: true } });
    const ref = usePersonalStore.getState().pushSettings;
    // 同内容、不同对象的回声快照 → 不应产生新引用。
    applyPushSettingsSnapshot({ internal: { enabled: true } });
    expect(usePersonalStore.getState().pushSettings).toBe(ref);
  });
});
