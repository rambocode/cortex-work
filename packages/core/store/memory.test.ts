// useMemoryStore 缓存装填/清理测试（半缺结构兜底契约同 store/reply.test.ts 模式）。
import { beforeEach, describe, expect, it } from "vitest";
import { useMemoryStore } from "./memory";
import { emptyUserMemoryState, type UserMemoryState } from "../memory/memory";

beforeEach(() => {
  useMemoryStore.setState({ memory: emptyUserMemoryState(), dreamState: null });
});

describe("hydrateMemory 半缺兜底", () => {
  it("分区级/字段级半缺补空串，不抛错", () => {
    useMemoryStore.getState().hydrateMemory({
      profile: { manual: "只有手写" },
    } as unknown as UserMemoryState);
    const memory = useMemoryStore.getState().memory;
    expect(memory.profile).toEqual({ manual: "只有手写", auto: "" });
    expect(memory.preferences).toEqual({ manual: "", auto: "" });
    expect(memory.projects).toEqual({ manual: "", auto: "" });
  });
});

describe("本地缓存操作", () => {
  it("setMemoryFile 合并式更新单分区", () => {
    useMemoryStore.getState().setMemoryFile("profile", { manual: "手写" });
    useMemoryStore.getState().setMemoryFile("profile", { auto: "- 要点" });
    expect(useMemoryStore.getState().memory.profile).toEqual({ manual: "手写", auto: "- 要点" });
  });

  it("clearAutoMemory 保留手写、清空自动区", () => {
    useMemoryStore.getState().hydrateMemory({
      ...emptyUserMemoryState(),
      profile: { manual: "手写", auto: "- 自动" },
    });
    useMemoryStore.getState().clearAutoMemory();
    expect(useMemoryStore.getState().memory.profile).toEqual({ manual: "手写", auto: "" });
  });

  it("clearAllMemory 全部重置为空", () => {
    useMemoryStore.getState().hydrateMemory({
      ...emptyUserMemoryState(),
      projects: { manual: "x", auto: "y" },
    });
    useMemoryStore.getState().clearAllMemory();
    expect(useMemoryStore.getState().memory).toEqual(emptyUserMemoryState());
  });
});
