// doctor 单测：自检项与 issues 汇总。所有探测都是注入函数，无需真环境。
import { describe, expect, it } from "vitest";
import { parseWorkerResult } from "@cortex-work/core/research/protocol";
import { runDoctor } from "./doctor";

const healthy = {
  nodeVersion: "v22.22.1",
  probePdf: async () => true,
  canExecute: () => true,
};

describe("runDoctor", () => {
  it("全部可用时 ok:true 且 issues 为空", async () => {
    const result = await runDoctor({ agent_browser_binary: "/bin/agent-browser" }, healthy);
    expect(parseWorkerResult("doctor", result)).toEqual(result);
    expect(result).toMatchObject({
      ok: true,
      node_version: "v22.22.1",
      browser_available: true,
      pdf_available: true,
      issues: [],
    });
  });

  it("Node 版本过低时给出 issue 且 ok:false", async () => {
    const result = await runDoctor({}, { ...healthy, nodeVersion: "v18.19.0" });
    expect(result.ok).toBe(false);
    expect(result.issues.join()).toContain("Node");
  });

  it("pdfjs 不可用时 pdf_available:false 且计入 issues", async () => {
    const result = await runDoctor({}, { ...healthy, probePdf: async () => false });
    expect(result.pdf_available).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.issues.join()).toContain("PDF");
  });

  it("pdfjs 探测抛错等价于不可用（不让自检本身崩掉）", async () => {
    const result = await runDoctor(
      {},
      {
        ...healthy,
        probePdf: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(result.pdf_available).toBe(false);
  });

  it("给了 agent-browser 路径但不可执行 → browser_available:false + issue", async () => {
    const result = await runDoctor(
      { agent_browser_binary: "/nope/agent-browser" },
      { ...healthy, canExecute: () => false },
    );
    expect(result.browser_available).toBe(false);
    expect(result.issues.join()).toContain("agent-browser");
    expect(result.ok).toBe(false);
  });

  it("main 未下发 agent-browser 路径时不算问题（Browser 降级本就可选）", async () => {
    const result = await runDoctor({}, healthy);
    expect(result.browser_available).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
