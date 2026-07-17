import { beforeEach, describe, expect, it, vi } from "vitest";

const chartCalls: Array<{ type: unknown; data: unknown; options: Record<string, unknown> }> = [];

vi.mock("pptxgenjs", () => {
  class MockSlide {
    addChart(type: unknown, data: unknown, options?: Record<string, unknown>) {
      chartCalls.push({ type, data, options: options ?? {} });
      return this;
    }
    addImage() {
      return this;
    }
    addText() {
      return this;
    }
    addTable() {
      return this;
    }
    addShape() {
      return this;
    }
    addNotes() {
      return this;
    }
    background?: { color: string };
  }

  class MockPptxGenJS {
    static ChartType = { bar: "bar", line: "line", pie: "pie" };
    static ShapeType = { rect: "rect", roundRect: "roundRect" };
    ChartType = MockPptxGenJS.ChartType;
    ShapeType = MockPptxGenJS.ShapeType;
    layout = "";
    defineLayout() {}
    addSlide() {
      return new MockSlide();
    }
    async write() {
      return Buffer.from("pptx");
    }
  }

  return { default: MockPptxGenJS };
});

beforeEach(() => {
  chartCalls.length = 0;
});

describe("scenesToPptxBuffer chart mapping", () => {
  it("将 bar/line/pie 场景节点映射到原生 addChart,并带上 legend/颜色/dataLabels/轴标题", async () => {
    const { scenesToPptxBuffer } = await import("./pptx");

    await scenesToPptxBuffer([
      {
        scene: {
          width: 1280,
          height: 720,
          backgroundColor: "ffffff",
          hasComplexLayers: false,
          warnings: ["chart-axis-title-ignored:chart-pie"],
          nodes: [
            {
              kind: "chart",
              id: "chart-bar",
              x: 60,
              y: 80,
              w: 260,
              h: 180,
              z: 0,
              ariaLabel: "季度收入柱状图",
              style: { fontFamily: "Helvetica", fontSizePx: 14, color: "1F2937" },
              spec: {
                version: 1,
                type: "bar",
                categories: ["Q1", "Q2", "Q3"],
                series: [
                  { name: "收入", values: [12, 18, 24], color: "3366FF" },
                  { name: "成本", values: [6, 9, 12], color: "FF8A00" },
                ],
                legend: true,
                dataLabels: true,
                xAxisTitle: "季度",
                yAxisTitle: "万元",
              },
            },
            {
              kind: "chart",
              id: "chart-line",
              x: 360,
              y: 80,
              w: 260,
              h: 180,
              z: 1,
              style: { fontFamily: "Helvetica", fontSizePx: 12, color: "0F172A" },
              spec: {
                version: 1,
                type: "line",
                categories: ["周一", "周二", "周三"],
                series: [{ name: "激活率", values: [42, 51, 63], color: "10B981" }],
                legend: false,
                dataLabels: false,
                xAxisTitle: "日期",
                yAxisTitle: "%",
              },
            },
            {
              kind: "chart",
              id: "chart-pie",
              x: 660,
              y: 80,
              w: 260,
              h: 180,
              z: 2,
              style: { fontFamily: "Helvetica", fontSizePx: 13, color: "334155" },
              spec: {
                version: 1,
                type: "pie",
                categories: ["自然流量", "投放", "转介绍"],
                series: [{ name: "占比", values: [56, 28, 16], color: "7C3AED" }],
                legend: true,
                dataLabels: true,
                xAxisTitle: "无效横轴",
                yAxisTitle: "无效纵轴",
              },
            },
          ],
        },
      },
    ]);

    expect(chartCalls).toHaveLength(3);
    expect(chartCalls[0]!.type).toBe("bar");
    expect(chartCalls[0]!.data).toEqual([
      { name: "收入", labels: ["Q1", "Q2", "Q3"], values: [12, 18, 24], color: "3366FF" },
      { name: "成本", labels: ["Q1", "Q2", "Q3"], values: [6, 9, 12], color: "FF8A00" },
    ]);
    expect(chartCalls[0]!.options).toMatchObject({
      showLegend: true,
      showValue: true,
      legendPos: "r",
      catAxisTitle: "季度",
      valAxisTitle: "万元",
      x: 0.625,
      y: 0.833,
      w: 2.708,
      h: 1.875,
      showTitle: false,
    });

    expect(chartCalls[1]!.type).toBe("line");
    expect(chartCalls[1]!.options).toMatchObject({
      showLegend: false,
      showValue: false,
      catAxisTitle: "日期",
      valAxisTitle: "%",
    });

    expect(chartCalls[2]!.type).toBe("pie");
    expect(chartCalls[2]!.options).toMatchObject({
      showLegend: true,
      showValue: true,
      showTitle: false,
    });
    expect(chartCalls[2]!.options.catAxisTitle).toBeUndefined();
    expect(chartCalls[2]!.options.valAxisTitle).toBeUndefined();
  });
});
