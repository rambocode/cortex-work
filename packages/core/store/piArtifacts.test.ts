// piArtifacts store 单测。核心锁两条:① reducer 纯函数且幂等（重复 apply 内容终态不变——
// 会话恢复重放的前提）;② 会话间命名空间隔离。

import { describe, expect, it, beforeEach } from "vitest";

import {
  applyPiArtifactEvent,
  piArtifactKind,
  usePiArtifactsStore,
  type PiArtifactEvent,
  type PiArtifactSessionState,
} from "./piArtifacts";

const create = (filename: string, content: string): PiArtifactEvent => ({
  type: "artifact",
  action: "create",
  filename,
  content,
});
const update = (filename: string, content: string): PiArtifactEvent => ({
  type: "artifact",
  action: "update",
  filename,
  content,
});

describe("piArtifactKind", () => {
  it("按扩展名归类,未知扩展按 text 兜底", () => {
    expect(piArtifactKind("a.html")).toBe("html");
    expect(piArtifactKind("A.HTM")).toBe("html");
    expect(piArtifactKind("chart.svg")).toBe("svg");
    expect(piArtifactKind("notes.md")).toBe("markdown");
    expect(piArtifactKind("data.json")).toBe("text");
    expect(piArtifactKind("noext")).toBe("text");
  });
});

describe("applyPiArtifactEvent(纯 reducer)", () => {
  it("create → version 1;update 覆盖内容且 version 自增;order 保持创建顺序", () => {
    let s = applyPiArtifactEvent(undefined, create("a.md", "v1"), 100);
    s = applyPiArtifactEvent(s, create("b.html", "<p/>"), 200);
    s = applyPiArtifactEvent(s, update("a.md", "v2"), 300);
    expect(s.byName["a.md"]).toMatchObject({ content: "v2", version: 2, createdAt: 100, updatedAt: 300 });
    expect(s.order).toEqual(["a.md", "b.html"]);
  });

  it("幂等:同一事件序列 apply 两遍,内容终态一致（version 允许多走,不参与内容语义）", () => {
    const evs = [create("a.md", "v1"), update("a.md", "v2"), create("b.svg", "<svg/>")];
    let once: PiArtifactSessionState | undefined;
    let twice: PiArtifactSessionState | undefined;
    for (const e of evs) once = applyPiArtifactEvent(once, e, 1);
    for (const e of [...evs, ...evs]) twice = applyPiArtifactEvent(twice, e, 1);
    expect(twice!.byName["a.md"]!.content).toBe(once!.byName["a.md"]!.content);
    expect(twice!.byName["b.svg"]!.content).toBe(once!.byName["b.svg"]!.content);
    expect(twice!.order).toEqual(once!.order);
  });

  it("delete 移除产物并把激活项落到最后一个存活产物;缺 content 的 create/update 防御性忽略", () => {
    let s = applyPiArtifactEvent(undefined, create("a.md", "x"), 1);
    s = applyPiArtifactEvent(s, create("b.md", "y"), 2);
    s = { ...s, activeFilename: "b.md" };
    s = applyPiArtifactEvent(s, { type: "artifact", action: "delete", filename: "b.md" }, 3);
    expect(s.byName["b.md"]).toBeUndefined();
    expect(s.activeFilename).toBe("a.md");
    const before = s;
    s = applyPiArtifactEvent(s, { type: "artifact", action: "update", filename: "a.md" }, 4);
    expect(s).toBe(before); // 无 content → 原状态原样返回
  });
});

describe("usePiArtifactsStore", () => {
  beforeEach(() => {
    usePiArtifactsStore.setState({ sessions: {}, openReq: undefined });
  });

  it("applyEvent 按 uiSessionId 隔离命名空间", () => {
    const st = usePiArtifactsStore.getState();
    st.applyEvent("s1", create("a.md", "one"));
    st.applyEvent("s2", create("a.md", "two"));
    const { sessions } = usePiArtifactsStore.getState();
    expect(sessions.s1!.byName["a.md"]!.content).toBe("one");
    expect(sessions.s2!.byName["a.md"]!.content).toBe("two");
  });

  it("requestOpen 递增 nonce 并把目标产物置为激活;setActive 拒绝不存在的产物", () => {
    const st = usePiArtifactsStore.getState();
    st.applyEvent("s1", create("a.md", "x"));
    st.applyEvent("s1", create("b.md", "y"));
    st.requestOpen("s1", "b.md");
    let cur = usePiArtifactsStore.getState();
    expect(cur.openReq).toMatchObject({ sessionId: "s1", filename: "b.md", nonce: 1 });
    expect(cur.sessions.s1!.activeFilename).toBe("b.md");
    st.requestOpen("s1");
    expect(usePiArtifactsStore.getState().openReq!.nonce).toBe(2);
    st.setActive("s1", "不存在.md");
    cur = usePiArtifactsStore.getState();
    expect(cur.sessions.s1!.activeFilename).toBe("b.md");
  });

  it("clearSession 只清目标会话", () => {
    const st = usePiArtifactsStore.getState();
    st.applyEvent("s1", create("a.md", "x"));
    st.applyEvent("s2", create("a.md", "y"));
    st.clearSession("s1");
    const { sessions } = usePiArtifactsStore.getState();
    expect(sessions.s1).toBeUndefined();
    expect(sessions.s2).toBeDefined();
  });
});
