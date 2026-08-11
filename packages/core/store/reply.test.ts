import { beforeEach, describe, expect, it } from "vitest";
import {
  useReplyStore,
  replyToPersisted,
  replySaveUrgency,
  type ReplyStore,
} from "./reply";
import { DEFAULT_REPLY_SETTINGS } from "../desktop/types";
import { emptyMemoryState, MEMORY_SCOPES } from "../reply/memory";

// 每个用例前复位到未 hydrate 的工厂初值，避免跨用例串态。
beforeEach(() => {
  useReplyStore.setState({
    hydrated: false,
    settings: DEFAULT_REPLY_SETTINGS,
    memory: emptyMemoryState(),
    channels: { connections: {}, credentials: {}, notes: {} },
  });
});

describe("useReplyStore hydrate", () => {
  it("空分片 hydrate 回落全默认，不抛", () => {
    useReplyStore.getState().hydrateReply({});
    const s = useReplyStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.settings).toEqual(DEFAULT_REPLY_SETTINGS);
    expect(s.memory).toEqual(emptyMemoryState());
    expect(s.channels).toEqual({ connections: {}, credentials: {}, notes: {} });
  });

  it("半缺记忆缓存 hydrateMemory 补齐缺失 scope（不抛）", () => {
    // 只给 profile，其余 4 分区缺失（模拟旧版 main 推来的半缺结构）。
    useReplyStore
      .getState()
      .hydrateMemory({ profile: { manual: "我是产品经理", auto: "" } } as never);
    const memory = useReplyStore.getState().memory;
    expect(memory.profile.manual).toBe("我是产品经理");
    // 缺失分区补空默认。
    for (const scope of MEMORY_SCOPES) {
      expect(memory[scope]).toBeDefined();
      expect(typeof memory[scope].manual).toBe("string");
      expect(typeof memory[scope].auto).toBe("string");
    }
  });

  it("字段级半缺 MemoryFile hydrateMemory 补齐 manual/auto 且 .trim() 安全", () => {
    // 分区存在但只有 manual（auto 缺失）/ 只有 auto（manual 缺失），模拟半缺字段。
    useReplyStore.getState().hydrateMemory({
      profile: { manual: "我是产品经理" },
      core: { auto: "- 简洁" },
    } as never);
    const memory = useReplyStore.getState().memory;
    // 缺失字段补空串，保证下游 composeUserProfile 的 .trim() 不抛 TypeError。
    expect(memory.profile).toEqual({ manual: "我是产品经理", auto: "" });
    expect(memory.core).toEqual({ manual: "", auto: "- 简洁" });
    // 每个分区两字段均为 string，可安全 .trim()。
    for (const scope of MEMORY_SCOPES) {
      expect(typeof memory[scope].manual).toBe("string");
      expect(typeof memory[scope].auto).toBe("string");
      expect(() => memory[scope].manual.trim() + memory[scope].auto.trim()).not.toThrow();
    }
  });

  it("半缺渠道分片 hydrate 补齐三个子表", () => {
    useReplyStore.getState().hydrateReply({
      replyChannels: { connections: { slack: { id: "slack", isConnected: true } } } as never,
    });
    const channels = useReplyStore.getState().channels;
    expect(channels.connections.slack?.isConnected).toBe(true);
    expect(channels.credentials).toEqual({});
    expect(channels.notes).toEqual({});
  });
});

describe("useReplyStore 设置更新", () => {
  it("setSettings 合并式更新，未传字段保持不变", () => {
    useReplyStore.getState().setSettings({ draftTrigger: "option", learningEnabled: false });
    const s = useReplyStore.getState().settings;
    expect(s.draftTrigger).toBe("option");
    expect(s.learningEnabled).toBe(false);
    // 未改字段保持默认。
    expect(s.voiceTrigger).toBe("fn");
    expect(s.userProfile).toBe("");
  });

  it("setSettings({providerId,model}) 局部更新不丢其它字段", () => {
    // 先写入非默认的触发键/档案，再单独更新 reply 专属 providerId/model。
    useReplyStore.getState().setSettings({ draftTrigger: "fn", userProfile: "PM" });
    useReplyStore.getState().setSettings({ providerId: "deepseek", model: "deepseek-chat" });
    const s = useReplyStore.getState().settings;
    expect(s.providerId).toBe("deepseek");
    expect(s.model).toBe("deepseek-chat");
    // 其它字段不受影响。
    expect(s.draftTrigger).toBe("fn");
    expect(s.userProfile).toBe("PM");
    expect(s.learningEnabled).toBe(true);
  });

  it("setSettings 清空 providerId/model 回落跟随默认（undefined）", () => {
    useReplyStore.getState().setSettings({ providerId: "deepseek", model: "deepseek-chat" });
    useReplyStore.getState().setSettings({ providerId: undefined, model: undefined });
    const s = useReplyStore.getState().settings;
    expect(s.providerId).toBeUndefined();
    expect(s.model).toBeUndefined();
  });
});

describe("useReplyStore 记忆分区写入", () => {
  it("setMemoryFile 只改目标分区，其余分区不受影响（修复源项目共用变量缺陷）", () => {
    useReplyStore.getState().setMemoryFile("im", { manual: "IM 简短" });
    useReplyStore.getState().setMemoryFile("email", { auto: "- 邮件要有署名" });
    const memory = useReplyStore.getState().memory;
    expect(memory.im.manual).toBe("IM 简短");
    expect(memory.im.auto).toBe(""); // 只改了 manual
    expect(memory.email.auto).toBe("- 邮件要有署名");
    expect(memory.email.manual).toBe("");
    // 其余分区仍空。
    expect(memory.core).toEqual({ manual: "", auto: "" });
  });

  it("clearAllMemory 清空手写与自动", () => {
    useReplyStore.getState().setMemoryFile("core", { manual: "m", auto: "a" });
    useReplyStore.getState().clearAllMemory();
    expect(useReplyStore.getState().memory).toEqual(emptyMemoryState());
  });

  it("clearAutoRules 只清自动区，保留手写区", () => {
    useReplyStore.getState().setMemoryFile("core", { manual: "手写保留", auto: "- 自动要点" });
    useReplyStore.getState().setMemoryFile("im", { manual: "", auto: "- IM 要点" });
    useReplyStore.getState().clearAutoRules();
    const memory = useReplyStore.getState().memory;
    expect(memory.core.manual).toBe("手写保留");
    expect(memory.core.auto).toBe("");
    expect(memory.im.auto).toBe("");
  });
});

describe("useReplyStore 渠道状态流转", () => {
  it("setChannelConnection + setChannelCredential 写入后 disconnect 同时清连接与凭据、留备注", () => {
    const store = useReplyStore.getState();
    store.setChannelConnection("slack", {
      id: "slack",
      isConnected: true,
      accountName: "alice",
      accountDetail: "acme",
      connectedAt: 123,
    });
    store.setChannelCredential("slack", { ciphertext: "enc==" });
    store.setChannelNote("slack", "工作号");

    let channels = useReplyStore.getState().channels;
    expect(channels.connections.slack?.accountName).toBe("alice");
    expect(channels.credentials.slack?.ciphertext).toBe("enc==");
    expect(channels.notes.slack).toBe("工作号");

    useReplyStore.getState().disconnectChannel("slack");
    channels = useReplyStore.getState().channels;
    expect(channels.connections.slack).toBeUndefined();
    expect(channels.credentials.slack).toBeUndefined();
    // 备注保留，便于重连沿用。
    expect(channels.notes.slack).toBe("工作号");
  });

  it("clearChannelNotes 清空全部备注", () => {
    useReplyStore.getState().setChannelNote("slack", "a");
    useReplyStore.getState().setChannelNote("gmail", "b");
    useReplyStore.getState().clearChannelNotes();
    expect(useReplyStore.getState().channels.notes).toEqual({});
  });
});

describe("replyToPersisted / replySaveUrgency", () => {
  it("replyToPersisted 序列化含持久化分片且字段完整往返（memory 不入投影，KTD6 修订）", () => {
    const store = useReplyStore.getState();
    store.hydrateReply({});
    store.setSettings({ draftTrigger: "none", voiceTrigger: "none", userProfile: "PM" });
    store.setMemoryFile("core", { auto: "- 简洁" });
    store.setChannelCredential("lark", { ciphertext: "x" });

    // reply 专属生成模型选择也应随设置往返保留。
    store.setSettings({ providerId: "deepseek", model: "deepseek-chat" });

    const persisted = replyToPersisted(useReplyStore.getState());
    // memory 是 main-owned 缓存，不进 PersistedState（personal-workspace.json 不再写 replyMemory）。
    expect(persisted).not.toHaveProperty("replyMemory");
    // 往返：把序列化结果重新 hydrate 到新状态应等价。
    useReplyStore.setState({
      hydrated: false,
      settings: DEFAULT_REPLY_SETTINGS,
      memory: emptyMemoryState(),
      channels: { connections: {}, credentials: {}, notes: {} },
    });
    useReplyStore.getState().hydrateReply(persisted);
    const roundTripped = useReplyStore.getState();
    expect(roundTripped.settings.draftTrigger).toBe("none");
    expect(roundTripped.settings.voiceTrigger).toBe("none");
    expect(roundTripped.settings.userProfile).toBe("PM");
    expect(roundTripped.settings.providerId).toBe("deepseek");
    expect(roundTripped.settings.model).toBe("deepseek-chat");
    expect(roundTripped.channels.credentials.lark?.ciphertext).toBe("x");
  });

  it("未 hydrate 时返回 none（避免空态覆盖磁盘）", () => {
    const prev = useReplyStore.getState();
    const next: ReplyStore = { ...prev, hydrated: false, settings: { ...prev.settings } };
    expect(replySaveUrgency(next, prev)).toBe("none");
  });

  it("hydrate 后持久化分片引用变化返回 throttled；memory 缓存变化不触发保存", () => {
    useReplyStore.getState().hydrateReply({});
    const prev = useReplyStore.getState();
    // 无变化。
    expect(replySaveUrgency({ ...prev }, prev)).toBe("none");
    // settings 引用变化。
    expect(replySaveUrgency({ ...prev, settings: { ...prev.settings } }, prev)).toBe("throttled");
    // memory 是 main-owned 只读缓存：引用变化不应触发保存（KTD6 修订）。
    expect(replySaveUrgency({ ...prev, memory: { ...prev.memory } }, prev)).toBe("none");
    // channels 引用变化。
    expect(replySaveUrgency({ ...prev, channels: { ...prev.channels } }, prev)).toBe("throttled");
  });
});
