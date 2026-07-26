// 已批准研究记忆的写入 / 撤销测试（U10 / KTD10）。
//
// 两条硬约束各有一例守着：
//   1. **未批准的候选绝不写入**——绕过它就等于让自动流程往用户长期记忆里塞东西；
//   2. **撤销按 candidateId 精确删除**（spec §14.2 原文要求「不按文本模糊匹配」）——
//      用户手改过一个字就删不掉、或者删错一条，都是不可接受的。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryCandidate } from "@cortex-work/core/research/knowledge";
import type { UserMemoryScope } from "@cortex-work/core/memory/memory";

let memoryRoot: string;

vi.mock("../paths", () => ({ userMemoryDir: () => memoryRoot }));
vi.mock("../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const {
  applyApprovedResearchMemory,
  clearResearchMemory,
  readResearchMemorySidecar,
  renderResearchSection,
  revokeResearchMemory,
} = await import("./research-memory");

/// 记录写入的 sink 替身：只关心「哪个分区被写成了什么」。
function makeSink() {
  const written = new Map<UserMemoryScope, string>();
  return {
    written,
    setFile: async (scope: UserMemoryScope, patch: { research: string }) => {
      written.set(scope, patch.research);
    },
  };
}

function candidate(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    candidateId: "cand-1",
    knowledgeId: "know-1",
    scope: "projects",
    text: "向量库 A 的召回率优于 B。",
    citationChunkIds: ["c1"],
    status: "approved",
    createdAt: "2026-07-26T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  memoryRoot = mkdtempSync(join(tmpdir(), "cortex-mem-"));
});
afterEach(() => rmSync(memoryRoot, { recursive: true, force: true }));

describe("KTD10：未批准的候选绝不写入", () => {
  it.each(["pending", "rejected", "revoked", "stale"] as const)(
    "status=%s 时抛错且不碰记忆文件",
    async (status) => {
      const sink = makeSink();
      await expect(
        applyApprovedResearchMemory(sink, candidate({ status }), ["c1"], "2026-07-26T12:00:00Z"),
      ).rejects.toThrow(/未批准/);
      expect(sink.written.size).toBe(0);
      expect((await readResearchMemorySidecar()).entries).toEqual([]);
    },
  );
});

describe("批准写入", () => {
  it("写进 sidecar 并投影到对应分区的 research 段", async () => {
    const sink = makeSink();
    await applyApprovedResearchMemory(sink, candidate(), ["c1", "c2"], "2026-07-26T12:00:00Z");

    const sidecar = await readResearchMemorySidecar();
    expect(sidecar.entries).toHaveLength(1);
    expect(sidecar.entries[0]).toMatchObject({
      candidateId: "cand-1",
      knowledgeId: "know-1",
      scope: "projects",
      chunkIds: ["c1", "c2"],
      approvedAt: "2026-07-26T12:00:00Z",
    });
    expect(sink.written.get("projects")).toContain("向量库 A 的召回率优于 B。");
    expect(sink.written.get("projects")).toContain("2 条证据支撑");
  });

  it("重复批准同一条不产生重复行（幂等）", async () => {
    const sink = makeSink();
    await applyApprovedResearchMemory(sink, candidate(), ["c1"], "2026-07-26T12:00:00Z");
    await applyApprovedResearchMemory(sink, candidate(), ["c1"], "2026-07-26T13:00:00Z");

    expect((await readResearchMemorySidecar()).entries).toHaveLength(1);
    expect(sink.written.get("projects")!.split("\n")).toHaveLength(1);
  });

  it("只投影同分区的条目（别的分区不受影响）", async () => {
    const sink = makeSink();
    await applyApprovedResearchMemory(sink, candidate(), ["c1"], "t1");
    await applyApprovedResearchMemory(
      sink,
      candidate({ candidateId: "cand-2", scope: "preferences", text: "用户偏好简洁回答。" }),
      ["c2"],
      "t2",
    );

    expect(sink.written.get("projects")).toContain("召回率");
    expect(sink.written.get("projects")).not.toContain("简洁回答");
    expect(sink.written.get("preferences")).toContain("简洁回答");
  });
});

describe("撤销", () => {
  /// spec §14.2：撤销只删除由对应 candidate 写入的条目，不按文本模糊匹配。
  it("按 candidateId 精确删除，文本相同的另一条不受影响", async () => {
    const sink = makeSink();
    const sameText = "两条内容完全一样的研究结论。";
    await applyApprovedResearchMemory(sink, candidate({ text: sameText }), ["c1"], "t1");
    await applyApprovedResearchMemory(
      sink,
      candidate({ candidateId: "cand-2", text: sameText }),
      ["c2"],
      "t2",
    );

    expect(await revokeResearchMemory(sink, "cand-1")).toBe(true);
    const remaining = (await readResearchMemorySidecar()).entries;
    expect(remaining.map((e) => e.candidateId)).toEqual(["cand-2"]);
    // 文本一样的另一条仍在记忆里——模糊匹配会把它一起删掉。
    expect(sink.written.get("projects")).toContain(sameText);
  });

  it("撤销不存在的条目回 false 且不改动任何东西", async () => {
    const sink = makeSink();
    await applyApprovedResearchMemory(sink, candidate(), ["c1"], "t1");
    expect(await revokeResearchMemory(sink, "不存在")).toBe(false);
    expect((await readResearchMemorySidecar()).entries).toHaveLength(1);
  });

  it("撤销最后一条后该分区 research 段为空", async () => {
    const sink = makeSink();
    await applyApprovedResearchMemory(sink, candidate(), ["c1"], "t1");
    await revokeResearchMemory(sink, "cand-1");
    expect(sink.written.get("projects")).toBe("");
  });
});

describe("清空", () => {
  it("清掉全部条目并把涉及到的分区都投影为空", async () => {
    const sink = makeSink();
    await applyApprovedResearchMemory(sink, candidate(), ["c1"], "t1");
    await applyApprovedResearchMemory(
      sink,
      candidate({ candidateId: "cand-2", scope: "profile", text: "另一条研究结论。" }),
      ["c2"],
      "t2",
    );

    await clearResearchMemory(sink);
    expect((await readResearchMemorySidecar()).entries).toEqual([]);
    expect(sink.written.get("projects")).toBe("");
    expect(sink.written.get("profile")).toBe("");
  });
});

describe("readResearchMemorySidecar 容错", () => {
  it("文件不存在时回空（可再生的派生数据，不该让记忆模块打不开）", async () => {
    expect((await readResearchMemorySidecar()).entries).toEqual([]);
  });

  /// 回归：空 sidecar 曾可能被写成模块级常量 + 浅拷贝，entries 数组被所有调用方共享。
  it("两次独立读取的 entries 不是同一个数组", async () => {
    const a = await readResearchMemorySidecar();
    a.entries.push({
      candidateId: "x",
      knowledgeId: "k",
      scope: "projects",
      text: "t",
      chunkIds: [],
      approvedAt: "t",
    });
    expect((await readResearchMemorySidecar()).entries).toEqual([]);
  });
});

describe("renderResearchSection", () => {
  it("空列表回空串（整段不写）", () => {
    expect(renderResearchSection([])).toBe("");
  });

  it("每条一行且标注证据条数（模型据此判断可信度）", () => {
    const rendered = renderResearchSection([
      { candidateId: "a", knowledgeId: "k", scope: "projects", text: "结论一。", chunkIds: ["c1", "c2"], approvedAt: "t" },
      { candidateId: "b", knowledgeId: "k", scope: "projects", text: "结论二。", chunkIds: [], approvedAt: "t" },
    ]);
    expect(rendered.split("\n")).toHaveLength(2);
    expect(rendered).toContain("2 条证据支撑");
    expect(rendered).toContain("（研究结论）");
  });
});
