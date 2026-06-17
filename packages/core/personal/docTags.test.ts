import { describe, expect, it } from "vitest";
import type { ParsedDocMeta } from "./docMeta";
import { deriveTags, topicOf } from "./docTags";

function doc(over: Partial<ParsedDocMeta>): ParsedDocMeta {
  return { path: "p", name: "n.md", kind: "plan", title: "t", origin: [], ...over };
}

describe("deriveTags", () => {
  it("阶段标签由 kind 映射三类", () => {
    expect(deriveTags(doc({ kind: "ideation" }))[0]).toMatchObject({ dim: "stage", value: "ideation" });
    expect(deriveTags(doc({ kind: "brainstorm" }))[0]).toMatchObject({ dim: "stage", value: "brainstorm" });
    expect(deriveTags(doc({ kind: "plan" }))[0]).toMatchObject({ dim: "stage", value: "plan" });
  });

  it("类型标签从 type 派生；无 type 不产", () => {
    const withType = deriveTags(doc({ type: "feat" }));
    expect(withType.find((t) => t.dim === "type")).toMatchObject({ value: "feat", label: "feat" });
    expect(deriveTags(doc({})).find((t) => t.dim === "type")).toBeUndefined();
  });

  it("主题域：有 topic 用 topic；无 topic 时 slug 首 token 聚簇", () => {
    expect(topicOf(doc({ topic: "tasks-panel" }))).toBe("tasks-panel");
    expect(
      topicOf(doc({ name: "2026-06-17-002-feat-pi-rpc-robustness-plan.md", topic: undefined })),
    ).toBe("pi");
    expect(
      topicOf(doc({ name: "2026-06-17-001-feat-pi-extension-customization-plan.md", topic: undefined })),
    ).toBe("pi");
  });

  it("深度：plan 有 Deep 出标签（剥括号补注）；缺则不出", () => {
    const t = deriveTags(doc({ depth: "Deep（跨 4 层）" })).find((x) => x.dim === "depth");
    expect(t).toMatchObject({ value: "deep", label: "Deep" });
    expect(deriveTags(doc({})).find((x) => x.dim === "depth")).toBeUndefined();
  });

  it("全字段缺失的最小 DocMeta：仅出阶段标签", () => {
    const tags = deriveTags(doc({ name: "x.md", type: undefined, topic: undefined, depth: undefined }));
    expect(tags).toHaveLength(1);
    expect(tags[0]?.dim).toBe("stage");
  });
});
