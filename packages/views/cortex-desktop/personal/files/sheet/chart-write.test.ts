// chart-write / chart-insert 单测:锁住新建图表的 OOXML 序列化(部件/引用/rels/content-type)
// 与选区启发式;并保证注入产物能被自家解析链(parseXlsxCharts/xlsxBufferToWorkbookData)读回。
import { describe, expect, it } from "vitest";
import { buildChartSpaceXml, injectUserCharts } from "./chart-write";
import { chartFromSelection } from "./chart-insert";
import { parseXlsxCharts } from "./chart-io";
import { workbookDataToXlsxBuffer, xlsxBufferToWorkbookData } from "./workbook-io";

// 造一个含「数据表」的基础 xlsx(exceljs),供注入测试。
async function buildBaseXlsx(): Promise<Uint8Array> {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  const ws = wb.addWorksheet("数据表");
  ws.getCell("A1").value = "年份";
  ws.getCell("B1").value = "营收";
  ws.getCell("A2").value = 2023;
  ws.getCell("B2").value = 100;
  ws.getCell("A3").value = 2024;
  ws.getCell("B3").value = 200;
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

describe("chartFromSelection", () => {
  it("多行多列:首行系列名、首列类目、其余列各一系列,锚点在选区下方", () => {
    const chart = chartFromSelection("数据表", { row: 0, col: 0, width: 3, height: 4 }, "bar")!;
    expect(chart.series).toHaveLength(2);
    expect(chart.series[0]).toMatchObject({
      nameRef: "'数据表'!$B$1",
      catRef: "'数据表'!$A$2:$A$4",
      valRef: "'数据表'!$B$2:$B$4",
    });
    expect(chart.series[1]?.valRef).toBe("'数据表'!$C$2:$C$4");
    expect(chart.anchor).toMatchObject({ col: 0, row: 5 });
  });

  it("单列一条系列;单格返回 null;sheet 名单引号转义", () => {
    expect(chartFromSelection("数据表", { row: 2, col: 1, width: 1, height: 5 }, "line")?.series[0]?.valRef).toBe(
      "'数据表'!$B$3:$B$7",
    );
    expect(chartFromSelection("数据表", { row: 0, col: 0, width: 1, height: 1 }, "bar")).toBeNull();
    expect(chartFromSelection("a'b", { row: 0, col: 0, width: 2, height: 2 }, "bar")?.series[0]?.catRef).toContain("'a''b'!");
  });
});

describe("buildChartSpaceXml", () => {
  it("柱状图含 barDir/系列引用/坐标轴;饼图无轴", () => {
    const chart = chartFromSelection("数据表", { row: 0, col: 0, width: 2, height: 3 }, "bar")!;
    chart.title = "营收";
    const xml = buildChartSpaceXml(chart);
    expect(xml).toContain(`<c:barDir val="col"/>`);
    expect(xml).toContain(`<c:f>'数据表'!$B$2:$B$3</c:f>`);
    expect(xml).toContain("<c:catAx>");
    expect(xml).toContain("<a:t>营收</a:t>");
    const pie = buildChartSpaceXml({ ...chart, kind: "pie" });
    expect(pie).toContain("<c:pieChart>");
    expect(pie).not.toContain("<c:catAx>");
  });
});

describe("injectUserCharts", () => {
  it("注入后部件/rels/content-type 齐全,自家解析链能读回图表", async () => {
    const base = await buildBaseXlsx();
    const chart = chartFromSelection("数据表", { row: 0, col: 0, width: 2, height: 3 }, "bar")!;
    chart.title = "营收趋势";
    const out = await injectUserCharts(base, [chart]);

    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(out);
    expect(zip.file("xl/charts/chart1.xml")).not.toBeNull();
    expect(zip.file("xl/drawings/drawing1.xml")).not.toBeNull();
    expect(await zip.file("xl/worksheets/sheet1.xml")!.async("string")).toContain(`<drawing r:id="rIdUserDr1"/>`);
    expect(await zip.file("[Content_Types].xml")!.async("string")).toContain(`PartName="/xl/charts/chart1.xml"`);

    // 自家解析链读回:类型/标题/系列引用/锚点。
    const charts = await parseXlsxCharts(out);
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ kind: "bar", title: "营收趋势", sheetName: "数据表" });
    expect(charts[0]?.series[0]?.valRef).toBe("'数据表'!$B$2:$B$3");
    expect(charts[0]?.anchor).toMatchObject({ col: 0, row: 4, width: 480, height: 300 });
    // 值数据不受影响(strip 兜底消化 drawing)。
    const data = await xlsxBufferToWorkbookData(out, "t.xlsx");
    expect((data.sheets[data.sheetOrder[0]!]!.cellData as Record<number, Record<number, { v?: unknown }>>)[1]?.[1]?.v).toBe(100);
  });

  it("同表已有 drawing 时并入锚点而非新建部件(worksheet 只允许一个 drawing 引用)", async () => {
    const base = await buildBaseXlsx();
    const c1 = chartFromSelection("数据表", { row: 0, col: 0, width: 2, height: 3 }, "bar")!;
    const once = await injectUserCharts(base, [c1]);
    const c2 = chartFromSelection("数据表", { row: 0, col: 0, width: 2, height: 3 }, "line")!;
    const twice = await injectUserCharts(once, [c2]);

    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(twice);
    // 仍只有一个 drawing 部件,里面两个锚点;chart 部件顺延编号。
    const names: string[] = [];
    zip.forEach((p, f) => {
      if (!f.dir) names.push(p);
    });
    expect(names.filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))).toHaveLength(1);
    expect(zip.file("xl/charts/chart2.xml")).not.toBeNull();
    const drawing = await zip.file("xl/drawings/drawing1.xml")!.async("string");
    expect(drawing.match(/<xdr:oneCellAnchor/g)).toHaveLength(2);
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheetXml.match(/<drawing /g)).toHaveLength(1);
    expect((await parseXlsxCharts(twice)).map((c) => c.kind).sort()).toEqual(["bar", "line"]);
  });

  it("经 graft+inject 的完整保存管线可往返", async () => {
    const base = await buildBaseXlsx();
    const chart = chartFromSelection("数据表", { row: 0, col: 0, width: 2, height: 3 }, "bar")!;
    const withChart = await injectUserCharts(base, [chart]);
    // 模拟再次编辑保存:读入 → 重建 → (graft 由 workbook-io 测试覆盖)再注入新图。
    const data = await xlsxBufferToWorkbookData(withChart, "t.xlsx");
    const rebuilt = await workbookDataToXlsxBuffer(data);
    const again = await injectUserCharts(rebuilt, [{ ...chart, kind: "pie" }]);
    expect((await parseXlsxCharts(again)).map((c) => c.kind)).toEqual(["pie"]);
  });
});
