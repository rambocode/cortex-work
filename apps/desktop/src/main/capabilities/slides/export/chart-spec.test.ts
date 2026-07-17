import { describe, expect, it } from "vitest";

import { parseSlidesChartSpec } from "./chart-spec";

describe("parseSlidesChartSpec", () => {
  it.each(["bar", "line", "pie"] as const)("接受合法 %s 图表", (type) => {
    const result = parseSlidesChartSpec({
      version: 1,
      type,
      categories: ["Q1", "Q2"],
      series: [{ name: "收入", values: [12, 18], color: "#3366FF" }],
      legend: true,
      dataLabels: false,
      xAxisTitle: "季度",
      yAxisTitle: "万元",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.series[0]?.color).toBe("3366FF");
  });

  it("拒绝 series 数值数量与 categories 不一致", () => {
    const result = parseSlidesChartSpec({
      version: 1,
      type: "bar",
      categories: ["Q1", "Q2"],
      series: [{ name: "收入", values: [12] }],
    });
    expect(result).toMatchObject({ ok: false, code: "chart-spec-invalid" });
  });

  it("拒绝额外键、非有限值、超限条目和 pie 多系列", () => {
    const base = {
      version: 1,
      type: "bar",
      categories: ["Q1"],
      series: [{ name: "收入", values: [12] }],
    };
    expect(parseSlidesChartSpec({ ...base, arbitrary: true }).ok).toBe(false);
    expect(parseSlidesChartSpec({ ...base, series: [{ name: "x", values: [Number.POSITIVE_INFINITY] }] }).ok).toBe(false);
    expect(parseSlidesChartSpec({ ...base, categories: Array.from({ length: 51 }, (_, i) => String(i)) }).ok).toBe(false);
    expect(
      parseSlidesChartSpec({ ...base, type: "pie", series: [base.series[0], { name: "成本", values: [8] }] }).ok,
    ).toBe(false);
  });
});
