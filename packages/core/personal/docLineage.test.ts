import { describe, expect, it } from "vitest";
import type { ParsedDocMeta } from "./docMeta";
import { buildLineage, extractOriginBasenames } from "./docLineage";

function doc(over: Partial<ParsedDocMeta> & { name: string; kind: ParsedDocMeta["kind"] }): ParsedDocMeta {
  return { path: `docs/${over.name}`, title: over.name, origin: [], ...over };
}

describe("extractOriginBasenames", () => {
  it("从混写 origin 抽 basename，容 §章节/相对绝对", () => {
    expect(
      extractOriginBasenames(["docs/plans/2026-06-16-003-feat-pi-rpc-session-plan.md §6/§7"]),
    ).toEqual(["2026-06-16-003-feat-pi-rpc-session-plan.md"]);
    expect(extractOriginBasenames(["null"])).toEqual([]);
    expect(extractOriginBasenames(["无 brainstorm（solo 规划）"])).toEqual([]);
  });
});

describe("buildLineage", () => {
  it("单链：plan.origin 指向 brainstorm", () => {
    const bs = doc({ name: "shanji-notes-requirements.md", kind: "brainstorm", date: "2026-06-15" });
    const plan = doc({
      name: "flash-notes-plan.md",
      kind: "plan",
      date: "2026-06-15",
      origin: ["docs/brainstorms/shanji-notes-requirements.md"],
    });
    const { pipelines, orphans } = buildLineage([plan, bs]);
    expect(orphans).toHaveLength(0);
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]?.map((d) => d.kind)).toEqual(["brainstorm", "plan"]);
  });

  it("多子同父：三个 plan 的 origin 指向同一 session plan → 一棵树", () => {
    const root = doc({ name: "session-plan.md", kind: "plan", date: "2026-06-16" });
    const c1 = doc({ name: "renderer-plan.md", kind: "plan", date: "2026-06-17", origin: ["docs/plans/session-plan.md §3"] });
    const c2 = doc({ name: "extension-plan.md", kind: "plan", date: "2026-06-17", origin: ["docs/plans/session-plan.md §4"] });
    const c3 = doc({ name: "robustness-plan.md", kind: "plan", date: "2026-06-17", origin: ["docs/plans/session-plan.md §6"] });
    const { pipelines, orphans } = buildLineage([root, c1, c2, c3]);
    expect(orphans).toHaveLength(0);
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]).toHaveLength(4);
  });

  it("ideation→plan 跨类型成链", () => {
    const id = doc({ name: "sess-deepen.md", kind: "ideation", date: "2026-06-16" });
    const plan = doc({ name: "sess-plan.md", kind: "plan", date: "2026-06-16", origin: ["docs/ideation/sess-deepen.md"] });
    const { pipelines } = buildLineage([id, plan]);
    expect(pipelines[0]?.map((d) => d.kind)).toEqual(["ideation", "plan"]);
  });

  it("origin 抽不到文件路径 → 孤儿，不抛", () => {
    const a = doc({ name: "solo-plan.md", kind: "plan", origin: ["无 brainstorm（solo 规划）；understand 简报"] });
    const { pipelines, orphans } = buildLineage([a]);
    expect(pipelines).toHaveLength(0);
    expect(orphans).toHaveLength(1);
  });

  it("无任何 origin → 全部孤儿", () => {
    const a = doc({ name: "a.md", kind: "plan" });
    const b = doc({ name: "b.md", kind: "ideation" });
    const { pipelines, orphans } = buildLineage([a, b]);
    expect(pipelines).toHaveLength(0);
    expect(orphans).toHaveLength(2);
  });
});
