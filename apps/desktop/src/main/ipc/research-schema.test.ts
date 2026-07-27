// research:create 入参 schema 的真实 zod 校验。
//
// 用真 schema 而不是复述规则：这道校验是「renderer 的一切输入都不可信」的唯一执行点，
// 一旦某个字段忘了加进 .strict() 的形状里，表现是「功能静默失效」（请求被整条拒绝），
// 而不是类型报错——只有跑一遍真 parse 才能发现。
import { describe, expect, it, vi } from "vitest";

// research.ts 会 import electron 与 runtime（后者拉起 SQLite / Worker）；
// 本测试只碰模块级的 schema 常量，把副作用依赖整体桩掉即可。
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock("../research/runtime", () => ({
  getQuickRetrieval: vi.fn(),
  getResearchService: vi.fn(),
  setDirectSearchCredential: vi.fn(),
  setSearchServerCredential: vi.fn(),
  testDirectSearch: vi.fn(),
  testSearchServer: vi.fn(),
}));

import { researchRequestSchema } from "./research";

const BASE = {
  consumer: "deep_research",
  objective: "调研 node:sqlite 是否可用于生产",
  mode: "quick",
  sourceScopes: [{ kind: "public_web" }],
  output: { format: "report", requireCitations: true },
};

describe("researchRequestSchema 的 projectId", () => {
  it("不带 projectId 仍然通过（不使用项目是默认形态）", () => {
    expect(researchRequestSchema.parse(BASE)).not.toHaveProperty("projectId");
  });

  it("带合法 projectId 时原样通过", () => {
    expect(researchRequestSchema.parse({ ...BASE, projectId: "proj-1" }).projectId).toBe("proj-1");
  });

  it("空串与超长 id 被拒", () => {
    expect(() => researchRequestSchema.parse({ ...BASE, projectId: "" })).toThrow();
    expect(() => researchRequestSchema.parse({ ...BASE, projectId: "x".repeat(129) })).toThrow();
  });

  // 红线：renderer 只能传 id，不能传路径。多出来的字段必须整条拒绝而不是静默剥离——
  // 否则「渲染端开始塞落盘路径」这类越权尝试会看起来像是能用的。
  it("传路径之类的未知字段整条拒绝（.strict）", () => {
    expect(() =>
      researchRequestSchema.parse({ ...BASE, projectPath: "/Users/someone/Documents" }),
    ).toThrow();
    expect(() => researchRequestSchema.parse({ ...BASE, archiveDir: "/etc" })).toThrow();
  });
});
