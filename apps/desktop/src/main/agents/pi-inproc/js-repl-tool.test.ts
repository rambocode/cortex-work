// javascript_repl 工具单测。锁三条:① 借道信封 = sentinel + JSON({title, code});
// ② undefined 应答（超时/abort/会话终止）→ throw 而非静默成功;③ ok:false 带错误输出 throw。

import { describe, expect, it } from "vitest";

import { createJsReplTool, JS_REPL_MAX_CODE_BYTES, JS_REPL_MAX_OUTPUT_CHARS } from "./js-repl-tool";

const SENTINEL = "@@CORTEX_JSREPL:test@@";

// 假 ctx.ui.input:记录收到的 title,按注入的应答结算。
function makeCtx(reply: string | undefined) {
  const calls: Array<{ title: string; opts?: { signal?: AbortSignal; timeout?: number } }> = [];
  const ctx = {
    ui: {
      input: async (title: string, _ph?: string, opts?: { signal?: AbortSignal; timeout?: number }) => {
        calls.push({ title, ...(opts ? { opts } : {}) });
        return reply;
      },
    },
  };
  return { ctx, calls };
}

async function run(reply: string | undefined, params: Record<string, unknown>) {
  const tool = createJsReplTool(SENTINEL);
  const { ctx, calls } = makeCtx(reply);
  const result = await tool.execute("tc-1", params as never, undefined as never, undefined as never, ctx as never);
  return { result: result as unknown as { content: [{ type: "text"; text: string }] }, calls };
}

describe("javascript_repl 工具", () => {
  it("经 sentinel 信封借道 ctx.ui.input,并带 worker 侧兜底超时", async () => {
    const { result, calls } = await run(JSON.stringify({ ok: true, output: "42" }), {
      title: "算数",
      code: "console.log(6*7)",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.title.startsWith(SENTINEL)).toBe(true);
    expect(JSON.parse(calls[0]!.title.slice(SENTINEL.length))).toEqual({ title: "算数", code: "console.log(6*7)" });
    expect(calls[0]!.opts?.timeout).toBe(120_000);
    expect(result.content[0].text).toBe("42");
  });

  it("undefined 应答（超时/abort/会话终止/取消）→ throw,绝不静默成功", async () => {
    await expect(run(undefined, { title: "t", code: "1" })).rejects.toThrow("执行未完成");
  });

  it("ok:false 把执行错误（含栈）作为可纠偏错误 throw 给模型", async () => {
    await expect(
      run(JSON.stringify({ ok: false, output: "ReferenceError: x is not defined\n  at <anonymous>" }), {
        title: "t",
        code: "x",
      }),
    ).rejects.toThrow("ReferenceError");
  });

  it("超长输出截断;空输出给占位文本", async () => {
    const big = "y".repeat(JS_REPL_MAX_OUTPUT_CHARS + 100);
    const { result } = await run(JSON.stringify({ ok: true, output: big }), { title: "t", code: "1" });
    expect(result.content[0].text.length).toBeLessThan(big.length);
    expect(result.content[0].text).toContain("输出已截断");
    const empty = await run(JSON.stringify({ ok: true, output: "" }), { title: "t", code: "1" });
    expect(empty.result.content[0].text).toBe("(无输出)");
  });

  it("入参闸门:空 code / 超大 code / 应答非 JSON 一律 throw", async () => {
    await expect(run("{}", { title: "t", code: "  " })).rejects.toThrow("code is required");
    await expect(
      run("{}", { title: "t", code: "x".repeat(JS_REPL_MAX_CODE_BYTES + 1) }),
    ).rejects.toThrow("KB limit");
    await expect(run("不是 JSON", { title: "t", code: "1" })).rejects.toThrow("无法解析执行结果");
  });
});
