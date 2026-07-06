// 写作会话索引 store 单测(U8):新建/切换/标题派生/续接 id/移除空间会话;持久化 roundtrip 与
// hydrate 回灌 run-manager。
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetWritingThreadsForTest,
  deriveThreadTitle,
  useWritingThreadsStore,
} from "./threads";
import {
  __resetWritingRunManagerForTest,
  getResumeSessionId,
} from "./run/writing-run-manager";

const S = useWritingThreadsStore.getState;

afterEach(() => {
  __resetWritingThreadsForTest();
  __resetWritingRunManagerForTest();
});

describe("deriveThreadTitle", () => {
  it("取首行并截断,空则默认名", () => {
    expect(deriveThreadTitle("帮我改改\n第二行")).toBe("帮我改改");
    expect(deriveThreadTitle("   ")).toBe("新会话");
    expect(deriveThreadTitle("这是一段非常非常非常非常非常非常长的输入内容需要被截断处理掉尾巴")).toContain("…");
  });
});

describe("useWritingThreadsStore", () => {
  it("新建会话产生新 threadUuid 并置为该空间活跃会话", () => {
    const a = S().createThread("space-1");
    expect(a.id).toMatch(/^wt-/);
    expect(a.spaceId).toBe("space-1");
    expect(S().activeThreadId("space-1")).toBe(a.id);
    const b = S().createThread("space-1");
    expect(b.id).not.toBe(a.id);
    expect(S().activeThreadId("space-1")).toBe(b.id); // 新建即切为活跃
  });

  it("ensureActiveThread:无会话建默认,已有则复用活跃", () => {
    const t = S().ensureActiveThread("space-x");
    expect(S().threadsForSpace("space-x")).toHaveLength(1);
    // 再次 ensure 复用同一会话,不重复建
    const again = S().ensureActiveThread("space-x");
    expect(again.id).toBe(t.id);
    expect(S().threadsForSpace("space-x")).toHaveLength(1);
  });

  it("setActiveThread 只接受属于该空间的会话 id", () => {
    const a = S().createThread("space-1");
    S().createThread("space-2");
    // 把 space-1 切成 space-2 的会话:被拒
    S().setActiveThread("space-1", "wt-nonexistent");
    expect(S().activeThreadId("space-1")).toBe(a.id);
  });

  it("setThreadTitle / setThreadResume 更新对应会话", () => {
    const a = S().createThread("space-1");
    S().setThreadTitle(a.id, "新标题");
    S().setThreadResume(a.id, "sess-abc");
    const updated = S().threads.find((t) => t.id === a.id)!;
    expect(updated.title).toBe("新标题");
    expect(updated.resumeSessionId).toBe("sess-abc");
  });

  it("removeThreadsForSpace 清该空间会话与活跃指针,不动其它空间", () => {
    S().createThread("space-1");
    const other = S().createThread("space-2");
    S().removeThreadsForSpace("space-1");
    expect(S().threadsForSpace("space-1")).toHaveLength(0);
    expect(S().activeThreadId("space-1")).toBeNull();
    expect(S().activeThreadId("space-2")).toBe(other.id);
  });

  it("持久化 roundtrip:serialize→hydrate 一致,并把 resumeSessionId 回灌 run-manager", () => {
    const a = S().createThread("space-1", "会话甲");
    S().setThreadResume(a.id, "sess-xyz");
    const snapshot = S().serialize();

    // 清空后回灌
    __resetWritingThreadsForTest();
    __resetWritingRunManagerForTest();
    expect(getResumeSessionId(a.id)).toBeUndefined();

    S().hydrate(snapshot);
    const restored = S().threads.find((t) => t.id === a.id)!;
    expect(restored.title).toBe("会话甲");
    expect(restored.resumeSessionId).toBe("sess-xyz");
    expect(S().activeThreadId("space-1")).toBe(a.id);
    // hydrate 把持久化 resume 回灌 run-manager,重启后首轮仍能续接
    expect(getResumeSessionId(a.id)).toBe("sess-xyz");
  });
});
