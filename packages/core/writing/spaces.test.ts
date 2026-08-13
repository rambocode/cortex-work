// 写作空间 store 单测：添加/取消/移除/重复根拒绝/持久化 roundtrip/默认空间。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import { useWritingSpacesStore } from "./spaces";

// 每个用例前重置 store 到空态（模块级 singleton）。
beforeEach(() => {
  useWritingSpacesStore.setState({ spaces: [], activeSpaceId: null, retrievalEnabled: true });
});

// 构造最小 bridge stub：只桩接本单元用到的 pickDirectory / writingWorkspaceRoot。
function makeBridge(overrides: Partial<DesktopBridge>): DesktopBridge {
  return overrides as DesktopBridge;
}

describe("useWritingSpacesStore.addSpace", () => {
  it("pickDirectory 返回路径 → 追加空间并设为活跃", async () => {
    const bridge = makeBridge({ pickDirectory: vi.fn().mockResolvedValue("/tmp/writing/alpha") });
    const space = await useWritingSpacesStore.getState().addSpace(bridge);
    expect(space).not.toBeNull();
    expect(space?.root).toBe("/tmp/writing/alpha");
    expect(space?.name).toBe("alpha"); // basename 派生展示名
    expect(space?.isDefault).toBeFalsy(); // 用户手动添加的空间不是默认空间
    const s = useWritingSpacesStore.getState();
    expect(s.spaces).toHaveLength(1);
    expect(s.activeSpaceId).toBe(space?.id);
  });

  it("取消（pickDirectory 返回 null）→ 不添加、回 null", async () => {
    const bridge = makeBridge({ pickDirectory: vi.fn().mockResolvedValue(null) });
    const space = await useWritingSpacesStore.getState().addSpace(bridge);
    expect(space).toBeNull();
    expect(useWritingSpacesStore.getState().spaces).toHaveLength(0);
  });

  it("重复根目录（含尾斜杠差异）→ 拒绝、不加第二条", async () => {
    const bridge = makeBridge({
      pickDirectory: vi
        .fn()
        .mockResolvedValueOnce("/tmp/writing/alpha")
        .mockResolvedValueOnce("/tmp/writing/alpha/"),
    });
    await useWritingSpacesStore.getState().addSpace(bridge);
    const dup = await useWritingSpacesStore.getState().addSpace(bridge);
    expect(dup).toBeNull();
    expect(useWritingSpacesStore.getState().spaces).toHaveLength(1);
  });

  it("bridge 为 null（web/旧壳）→ 回 null 不抛", async () => {
    const space = await useWritingSpacesStore.getState().addSpace(null);
    expect(space).toBeNull();
  });
});

describe("useWritingSpacesStore.removeSpace / setActiveSpace", () => {
  it("移除活跃空间 → 回落到剩余首个", async () => {
    const bridge = makeBridge({
      pickDirectory: vi.fn().mockResolvedValueOnce("/tmp/a").mockResolvedValueOnce("/tmp/b"),
    });
    const a = await useWritingSpacesStore.getState().addSpace(bridge);
    const b = await useWritingSpacesStore.getState().addSpace(bridge);
    expect(useWritingSpacesStore.getState().activeSpaceId).toBe(b?.id);
    useWritingSpacesStore.getState().removeSpace(b!.id);
    const s = useWritingSpacesStore.getState();
    expect(s.spaces).toHaveLength(1);
    expect(s.activeSpaceId).toBe(a?.id); // 回落到剩余首个
  });

  it("移除最后一个空间 → activeSpaceId 归 null", async () => {
    const bridge = makeBridge({ pickDirectory: vi.fn().mockResolvedValue("/tmp/only") });
    const only = await useWritingSpacesStore.getState().addSpace(bridge);
    useWritingSpacesStore.getState().removeSpace(only!.id);
    expect(useWritingSpacesStore.getState().activeSpaceId).toBeNull();
  });

  it("setActiveSpace 对不存在的 id 无效（保持原活跃）", async () => {
    const bridge = makeBridge({ pickDirectory: vi.fn().mockResolvedValue("/tmp/a") });
    const a = await useWritingSpacesStore.getState().addSpace(bridge);
    useWritingSpacesStore.getState().setActiveSpace("nope");
    expect(useWritingSpacesStore.getState().activeSpaceId).toBe(a?.id);
  });
});

describe("useWritingSpacesStore 持久化 roundtrip", () => {
  it("serialize → hydrate 一致", async () => {
    const bridge = makeBridge({
      pickDirectory: vi.fn().mockResolvedValueOnce("/tmp/a").mockResolvedValueOnce("/tmp/b"),
    });
    await useWritingSpacesStore.getState().addSpace(bridge);
    const b = await useWritingSpacesStore.getState().addSpace(bridge);
    const snapshot = useWritingSpacesStore.getState().serialize();

    // 清空后从快照回灌，断言完全一致。
    useWritingSpacesStore.setState({ spaces: [], activeSpaceId: null });
    useWritingSpacesStore.getState().hydrate(snapshot);
    const s = useWritingSpacesStore.getState();
    expect(s.spaces).toEqual(snapshot.spaces);
    expect(s.activeSpaceId).toBe(b?.id);
  });

  it("hydrate(undefined) 回落空默认（兼容旧档）", () => {
    useWritingSpacesStore.getState().hydrate(undefined);
    const s = useWritingSpacesStore.getState();
    expect(s.spaces).toEqual([]);
    expect(s.activeSpaceId).toBeNull();
    // 编辑器视图偏好回落默认。
    expect(s.previewMode).toBe("rich");
    // 字号回落到当前默认值(13):旧档没有 fontSizeUserSet,一律按「没动过」处理。
    expect(s.fontSizePx).toBe(13);
  });

  it("previewMode / fontSizePx 进 serialize 分片并 roundtrip；字号越界夹取", () => {
    useWritingSpacesStore.getState().setPreviewMode("source");
    useWritingSpacesStore.getState().setFontSizePx(22);
    const snap = useWritingSpacesStore.getState().serialize();
    expect(snap.previewMode).toBe("source");
    expect(snap.fontSizePx).toBe(22);

    // setFontSizePx 越界即时夹取（>48 → 48，<10 → 10）。
    useWritingSpacesStore.getState().setFontSizePx(999);
    expect(useWritingSpacesStore.getState().fontSizePx).toBe(48);
    useWritingSpacesStore.getState().setFontSizePx(2);
    expect(useWritingSpacesStore.getState().fontSizePx).toBe(10);

    // hydrate 缺字段回默认 + 脏字号夹取(手动调过的档才回灌落盘值)。
    useWritingSpacesStore
      .getState()
      .hydrate({ spaces: [], activeSpaceId: null, fontSizePx: 9999, fontSizeUserSet: true });
    expect(useWritingSpacesStore.getState().previewMode).toBe("rich");
    expect(useWritingSpacesStore.getState().fontSizePx).toBe(48);

    // 旧档(无 fontSizeUserSet)躺着上一版的默认 16 → 回灌到当前默认 13,不被旧数字钉死。
    useWritingSpacesStore.getState().hydrate({ spaces: [], activeSpaceId: null, fontSizePx: 16 });
    expect(useWritingSpacesStore.getState().fontSizePx).toBe(13);
    expect(useWritingSpacesStore.getState().fontSizeUserSet).toBe(false);

    // 手动调过则永远尊重用户选择;resetTypography 把控制权交还默认值。
    useWritingSpacesStore.getState().setFontSizePx(16);
    expect(useWritingSpacesStore.getState().serialize().fontSizeUserSet).toBe(true);
    useWritingSpacesStore.getState().resetTypography();
    expect(useWritingSpacesStore.getState().fontSizePx).toBe(13);
    expect(useWritingSpacesStore.getState().fontSizeUserSet).toBe(false);
  });

  it("fontPreset 与字号同款 userSet 语义:旧档躺着旧默认 system → 回灌当前默认(思源宋体)", () => {
    // 旧档(无 fontPresetUserSet)存着上一版默认 "system" → 不被钉死,升级到当前默认。
    useWritingSpacesStore.getState().hydrate({ spaces: [], activeSpaceId: null, fontPreset: "system" });
    expect(useWritingSpacesStore.getState().fontPreset).toBe("sourceHanSerif");
    expect(useWritingSpacesStore.getState().fontPresetUserSet).toBe(false);

    // 手动选过(userSet)则永远尊重用户选择,包括显式选回 system。
    useWritingSpacesStore.getState().setFontPreset("system");
    const snap = useWritingSpacesStore.getState().serialize();
    expect(snap.fontPreset).toBe("system");
    expect(snap.fontPresetUserSet).toBe(true);
    useWritingSpacesStore.getState().hydrate(snap);
    expect(useWritingSpacesStore.getState().fontPreset).toBe("system");

    // resetTypography 交还默认值管理。
    useWritingSpacesStore.getState().resetTypography();
    expect(useWritingSpacesStore.getState().fontPreset).toBe("sourceHanSerif");
    expect(useWritingSpacesStore.getState().fontPresetUserSet).toBe(false);
  });

  it("助手 composer 选择记忆(agent/模型/思考/pi 供应商)进分片并 roundtrip;旧档缺字段回默认", () => {
    const st = useWritingSpacesStore.getState();
    st.setAssistantAgent("codex");
    st.setAssistantModel("codex", "gpt-5.4");
    st.setAssistantModel("pi", "deepseek-v4", "deepseek");
    st.setAssistantThinking("codex", "high");
    const snap = useWritingSpacesStore.getState().serialize();
    expect(snap.assistantAgent).toBe("codex");
    expect(snap.assistantModelByAgent).toEqual({ codex: "gpt-5.4", pi: "deepseek-v4" });
    expect(snap.assistantThinkingByAgent).toEqual({ codex: "high" });
    expect(snap.assistantPiProviderId).toBe("deepseek");

    // 回灌一致
    useWritingSpacesStore.getState().hydrate(snap);
    const s = useWritingSpacesStore.getState();
    expect(s.assistantAgent).toBe("codex");
    expect(s.assistantModelByAgent["pi"]).toBe("deepseek-v4");
    expect(s.assistantPiProviderId).toBe("deepseek");

    // 旧档缺字段 → 空默认
    useWritingSpacesStore.getState().hydrate({ spaces: [], activeSpaceId: null });
    const old = useWritingSpacesStore.getState();
    expect(old.assistantAgent).toBeNull();
    expect(old.assistantModelByAgent).toEqual({});
    expect(old.assistantThinkingByAgent).toEqual({});
    expect(old.assistantPiProviderId).toBeNull();
  });
});

describe("useWritingSpacesStore.ensureDefaultSpace", () => {
  it("空列表 → 以 writingWorkspaceRoot 建默认空间并设活跃", async () => {
    const bridge = makeBridge({
      writingWorkspaceRoot: vi.fn().mockResolvedValue("/home/me/Documents/cortex/writing"),
    });
    const space = await useWritingSpacesStore.getState().ensureDefaultSpace(bridge);
    expect(space).not.toBeNull();
    expect(space?.root).toBe("/home/me/Documents/cortex/writing");
    expect(space?.name).toBe("writing");
    expect(space?.isDefault).toBe(true); // 默认空间标记，UI 据此渲染副标
    const s = useWritingSpacesStore.getState();
    expect(s.spaces).toHaveLength(1);
    expect(s.activeSpaceId).toBe(space?.id);
  });

  it("已有空间 → 不重复建默认、回 null", async () => {
    const bridge = makeBridge({
      pickDirectory: vi.fn().mockResolvedValue("/tmp/existing"),
      writingWorkspaceRoot: vi.fn().mockResolvedValue("/home/me/Documents/cortex/writing"),
    });
    await useWritingSpacesStore.getState().addSpace(bridge);
    const created = await useWritingSpacesStore.getState().ensureDefaultSpace(bridge);
    expect(created).toBeNull();
    expect(useWritingSpacesStore.getState().spaces).toHaveLength(1);
    expect(bridge.writingWorkspaceRoot).not.toHaveBeenCalled();
  });

  it("bridge 无 writingWorkspaceRoot（web/旧壳）→ 回 null", async () => {
    const space = await useWritingSpacesStore.getState().ensureDefaultSpace(makeBridge({}));
    expect(space).toBeNull();
  });
});

describe("retrievalEnabled 检索开关（U4）", () => {
  it("默认开启（true）", () => {
    expect(useWritingSpacesStore.getState().retrievalEnabled).toBe(true);
  });

  it("setRetrievalEnabled 切换并进 serialize()", () => {
    useWritingSpacesStore.getState().setRetrievalEnabled(false);
    expect(useWritingSpacesStore.getState().retrievalEnabled).toBe(false);
    expect(useWritingSpacesStore.getState().serialize().retrievalEnabled).toBe(false);
  });

  it("hydrate 回灌:显式 false 生效,旧档缺字段回落 true", () => {
    useWritingSpacesStore.getState().hydrate({ spaces: [], activeSpaceId: null, retrievalEnabled: false });
    expect(useWritingSpacesStore.getState().retrievalEnabled).toBe(false);
    // 旧档没有该字段 → 缺省回落 true(检索默认启用)。
    useWritingSpacesStore.getState().hydrate({ spaces: [], activeSpaceId: null });
    expect(useWritingSpacesStore.getState().retrievalEnabled).toBe(true);
  });
});
