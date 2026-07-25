// rerank 单测：纯词法打分，无网络无模型。
import { describe, expect, it } from "vitest";
import { parseWorkerResult } from "@cortex-work/core/research/protocol";
import { runRerank } from "./rerank";

const params = {
  operation_id: "op_08",
  query: "开源桌面 AI agent 许可证",
  subquestions: [{ id: "sq_2", text: "它们的许可证分别是什么 license" }],
  chunks: [
    { chunk_id: "ch_1", text: "This project is licensed under the Apache-2.0 license. 许可证宽松。" },
    { chunk_id: "ch_2", text: "Unrelated marketing copy about our beautiful landing page." },
    { chunk_id: "ch_3", text: "开源桌面 AI agent 的许可证通常是 MIT 或 Apache-2.0。" },
  ],
  top_k: 10,
};

describe("runRerank", () => {
  it("相关块排在无关块前面", () => {
    const result = runRerank(params);
    expect(parseWorkerResult("rerank", result)).toEqual(result);
    const order = result.ranked.map((item) => item.chunk_id);
    expect(order.indexOf("ch_3")).toBeLessThan(order.indexOf("ch_2"));
    expect(order.indexOf("ch_1")).toBeLessThan(order.indexOf("ch_2"));
  });

  it("按 top_k 截断", () => {
    expect(runRerank({ ...params, top_k: 2 }).ranked).toHaveLength(2);
  });

  it("回带 operation_id 并输出降序分数", () => {
    const result = runRerank(params);
    expect(result.operation_id).toBe("op_08");
    const scores = result.ranked.map((item) => item.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("完全无关的查询也能给出稳定顺序（分数并列时按 chunk_id 字典序）", () => {
    const result = runRerank({
      ...params,
      query: "zzzz 完全不相关的查询词",
      subquestions: [],
    });
    expect(result.ranked.map((r) => r.chunk_id)).toEqual(["ch_1", "ch_2", "ch_3"]);
  });

  it("子问题文本也参与打分（只命中子问题的块不会被埋没）", () => {
    const withSub = runRerank({
      operation_id: "op",
      query: "无关词",
      subquestions: [{ id: "s1", text: "Apache-2.0" }],
      chunks: [
        { chunk_id: "a", text: "This is licensed under the Apache-2.0 license." },
        { chunk_id: "b", text: "Nothing relevant here at all." },
      ],
      top_k: 2,
    });
    expect(withSub.ranked[0]?.chunk_id).toBe("a");
    expect(withSub.ranked[0]!.score).toBeGreaterThan(withSub.ranked[1]!.score);
  });
});
