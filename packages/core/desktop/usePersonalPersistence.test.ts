import { describe, expect, it } from "vitest";
import { usePersonalStore, type PersonalState } from "../store/personal";
import { saveUrgency } from "./usePersonalPersistence";

// 以真实 store 初始状态为基底构造 prev/next（引用相等性是判定依据）。
const base: PersonalState = { ...usePersonalStore.getState(), hydrated: true };

describe("saveUrgency", () => {
  it("未 hydrate 时不保存（避免空状态覆盖磁盘）", () => {
    expect(saveUrgency({ ...base, hydrated: false, projects: [] }, base)).toBe("none");
  });

  it("无持久化切片变更时不保存", () => {
    expect(saveUrgency({ ...base }, base)).toBe("none");
    // 非持久化切片（如 homeOpen）变更也不触发。
    expect(saveUrgency({ ...base, homeOpen: !base.homeOpen }, base)).toBe("none");
  });

  it("projects / promptRoot 变更立即保存（主进程 fs 白名单数据源）", () => {
    expect(saveUrgency({ ...base, projects: [...base.projects] }, base)).toBe("immediate");
    expect(saveUrgency({ ...base, promptRoot: "/new/root" }, base)).toBe("immediate");
  });

  it("lastActiveProjectId 变更立即保存（浮层经主进程 cached 读默认归属，绕 500ms 节流）", () => {
    expect(saveUrgency({ ...base, lastActiveProjectId: "p1" }, base)).toBe("immediate");
  });

  it("其余持久化切片变更走节流", () => {
    expect(saveUrgency({ ...base, sessions: [...base.sessions] }, base)).toBe("throttled");
    expect(saveUrgency({ ...base, ttsSettings: { ...base.ttsSettings } }, base)).toBe("throttled");
    expect(saveUrgency({ ...base, voiceSettings: { ...base.voiceSettings } }, base)).toBe("throttled");
    // profile（昵称/头像）属高频可节流切片。
    expect(saveUrgency({ ...base, profile: { ...base.profile, nickname: "阿伟" } }, base)).toBe("throttled");
  });

  it("projects 与 sessions 同时变更时立即保存优先", () => {
    expect(saveUrgency({ ...base, projects: [...base.projects], sessions: [...base.sessions] }, base)).toBe(
      "immediate",
    );
  });
});
