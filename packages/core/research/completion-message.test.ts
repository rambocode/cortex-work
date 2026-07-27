import { describe, expect, it } from "vitest";

import { buildResearchCompletionMessage } from "./completion-message";

describe("buildResearchCompletionMessage", () => {
  it("完成态：标题 + 目标 + 统计 + 报告路径", () => {
    const text = buildResearchCompletionMessage({
      objective: "调研国内生成式 AI 备案要求",
      status: "completed",
      archivedPath: "/Users/me/proj/research/调研国内生成式 AI 备案要求.md",
      roundCount: 2,
      documentCount: 14,
      citationCount: 23,
    });
    expect(text).toContain("深度研究已完成");
    expect(text).toContain("调研国内生成式 AI 备案要求");
    expect(text).toContain("2 轮检索 · 14 篇来源 · 23 条引用");
    // 路径必须包在行内代码里：文件名含空格,不包会被 Markdown 吃掉字符。
    expect(text).toContain("`/Users/me/proj/research/调研国内生成式 AI 备案要求.md`");
  });

  it("完成但未归档时告知去右栏看，而不是静默略过（否则像报告没生成）", () => {
    const text = buildResearchCompletionMessage({
      objective: "目标",
      status: "completed",
      roundCount: 1,
    });
    expect(text).not.toContain("报告已保存到");
    expect(text).toContain("右侧");
  });

  it("失败态：标题如实说失败，并带上原因", () => {
    const text = buildResearchCompletionMessage({
      objective: "目标",
      status: "failed",
      errorMessage: "Search Server 503",
    });
    expect(text).toContain("深度研究失败");
    expect(text).toContain("Search Server 503");
    // 失败不该出现「可在右侧查看报告」的误导文案。
    expect(text).not.toContain("右侧");
  });

  it("取消态如实说取消，不冒充完成", () => {
    const text = buildResearchCompletionMessage({ objective: "目标", status: "cancelled" });
    expect(text).toContain("深度研究已取消");
    expect(text).not.toContain("已完成");
  });

  it("统计三项全为 0 或缺省时整行省略（不显示 0 轮 · 0 篇）", () => {
    const text = buildResearchCompletionMessage({
      objective: "目标",
      status: "completed",
      roundCount: 0,
      documentCount: 0,
      citationCount: 0,
    });
    expect(text).not.toContain("轮检索");
    expect(text).not.toContain("篇来源");
  });

  it("统计部分缺省时只拼有值的项", () => {
    const text = buildResearchCompletionMessage({
      objective: "目标",
      status: "completed",
      documentCount: 5,
    });
    expect(text).toContain("5 篇来源");
    expect(text).not.toContain("轮检索");
    expect(text).not.toContain("条引用");
  });
});
