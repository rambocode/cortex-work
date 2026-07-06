// 写作空间 store 单测：添加/取消/移除/重复根拒绝/持久化 roundtrip/默认空间。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import { useWritingSpacesStore } from "./spaces";

// 每个用例前重置 store 到空态（模块级 singleton）。
beforeEach(() => {
  useWritingSpacesStore.setState({ spaces: [], activeSpaceId: null });
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
    expect(s.fontSizePx).toBe(16);
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

    // hydrate 缺字段回默认 + 脏字号夹取。
    useWritingSpacesStore.getState().hydrate({ spaces: [], activeSpaceId: null, fontSizePx: 9999 });
    expect(useWritingSpacesStore.getState().previewMode).toBe("rich");
    expect(useWritingSpacesStore.getState().fontSizePx).toBe(48);
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
