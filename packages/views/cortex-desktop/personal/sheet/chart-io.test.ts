// chart-io 单测:覆盖两种真实世界的图表 XML 形态——
// 1) openpyxl 等脚本生成:默认命名空间(无 c: 前缀)、无缓存、只有区间引用 → 回工作簿取数;
// 2) Excel 保存:c: 前缀 + numCache/strCache 缓存 → 直接用缓存。
// 同时锁住 sheet→drawing→chart 的 rels 反查链与引用取数。
import { describe, expect, it } from "vitest";
import type { IWorkbookData } from "@univerjs/presets";
import { parseXlsxCharts, resolveChart, resolveRefValues, type WorkbookChart } from "./chart-io";

// 手工构造最小 xlsx 包(仅 chart 解析涉及的部件;worksheet 内容本身不参与解析)。
async function buildChartXlsx(): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="利润表" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  zip.file("xl/worksheets/sheet1.xml", `<worksheet/>`);
  zip.file(
    "xl/worksheets/_rels/sheet1.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="/xl/drawings/drawing1.xml"/></Relationships>`,
  );
  // drawing:chart1 有 oneCellAnchor 锚点(B35 起,6480000×4320000 EMU);chart2 只在 rels 里(走无锚点容错)。
  zip.file(
    "xl/drawings/drawing1.xml",
    `<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><oneCellAnchor><from><col>1</col><colOff>0</colOff><row>34</row><rowOff>0</rowOff></from><ext cx="6480000" cy="4320000"/><graphicFrame><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><c:chart r:id="rId1"/></a:graphicData></a:graphic></graphicFrame></oneCellAnchor></wsDr>`,
  );
  zip.file(
    "xl/drawings/_rels/drawing1.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="/xl/charts/chart1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/></Relationships>`,
  );
  // chart1:默认命名空间、无缓存(仿 openpyxl/用户真实文件)。
  zip.file(
    "xl/charts/chart1.xml",
    `<chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart"><chart><title><tx><rich><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>营收趋势</a:t></a:r></a:p></rich></tx></title><plotArea><barChart><barDir val="col"/><ser><idx val="0"/><spPr><a:solidFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:srgbClr val="1F4E79"/></a:solidFill></spPr><tx><strRef><f>'利润表'!$A$5</f></strRef></tx><cat><numRef><f>'利润表'!$B$4:$D$4</f></numRef></cat><val><numRef><f>'利润表'!$B$5:$D$5</f></numRef></val></ser></barChart></plotArea></chart></chartSpace>`,
  );
  // chart2:c: 前缀 + 缓存(仿 Excel 保存的文件),折线图。
  zip.file(
    "xl/charts/chart2.xml",
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:lineChart><c:ser><c:tx><c:strRef><c:f>S!$A$1</c:f><c:strCache><c:pt idx="0"><c:v>毛利率</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>S!$B$1:$C$1</c:f><c:strCache><c:pt idx="0"><c:v>2023</c:v></c:pt><c:pt idx="1"><c:v>2024</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>S!$B$2:$C$2</c:f><c:numCache><c:pt idx="0"><c:v>0.21</c:v></c:pt><c:pt idx="1"><c:v>0.24</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:lineChart></c:plotArea></c:chart></c:chartSpace>`,
  );
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

// 取数用的最小工作簿数据:利润表 B4:D4 年份、B5:D5 营收、A5 系列名。
const DATA: IWorkbookData = {
  id: "wb",
  name: "t.xlsx",
  appVersion: "",
  locale: "zhCN" as IWorkbookData["locale"],
  styles: {},
  sheetOrder: ["s1"],
  sheets: {
    s1: {
      id: "s1",
      name: "利润表",
      cellData: {
        3: { 1: { v: 2022 }, 2: { v: 2023 }, 3: { v: 2024 } },
        4: { 0: { v: "营业收入" }, 1: { v: 100 }, 2: { v: 200 }, 3: { v: 300 } },
      },
    },
  },
} as IWorkbookData;

describe("parseXlsxCharts", () => {
  it("经 rels 链解析出图表:类型/标题/系列引用/源色/所属工作表(两种命名空间写法)", async () => {
    const charts = await parseXlsxCharts(await buildChartXlsx());
    expect(charts).toHaveLength(2);
    const [bar, line] = charts as [WorkbookChart, WorkbookChart];
    expect(bar.kind).toBe("bar");
    expect(bar.title).toBe("营收趋势");
    expect(bar.sheetName).toBe("利润表");
    expect(bar.series[0]?.valRef).toBe("'利润表'!$B$5:$D$5");
    expect(bar.series[0]?.catRef).toBe("'利润表'!$B$4:$D$4");
    expect(bar.series[0]?.color).toBe("#1F4E79");
    expect(line.kind).toBe("line");
    expect(line.series[0]?.name).toBe("毛利率");
    expect(line.series[0]?.valCache).toEqual([0.21, 0.24]);
    expect(line.series[0]?.catCache).toEqual(["2023", "2024"]);
  });

  it("锚点:有 oneCellAnchor 的图带网格位置与像素尺寸,仅在 rels 的图无锚点仍入列", async () => {
    const charts = await parseXlsxCharts(await buildChartXlsx());
    const [bar, line] = charts as [WorkbookChart, WorkbookChart];
    // EMU→px:6480000/9525≈680,4320000/9525≈454。
    expect(bar.anchor).toEqual({ col: 1, row: 34, width: 680, height: 454 });
    expect(line.anchor).toBeUndefined();
  });
});

describe("resolveRefValues", () => {
  it("带引号 sheet 名 + 绝对引用取数(行优先展平)", () => {
    expect(resolveRefValues(DATA, "'利润表'!$B$5:$D$5")).toEqual([100, 200, 300]);
    expect(resolveRefValues(DATA, "利润表!B4:D4")).toEqual([2022, 2023, 2024]);
    expect(resolveRefValues(DATA, "不存在!A1:B1")).toEqual([]);
    expect(resolveRefValues(DATA, "garbage")).toEqual([]);
  });
});

describe("resolveChart", () => {
  it("无缓存图表按引用回工作簿取数,系列名经 nameRef 解析", async () => {
    const charts = await parseXlsxCharts(await buildChartXlsx());
    const resolved = resolveChart(DATA, charts[0]!, (i) => `系列 ${i + 1}`);
    expect(resolved.series[0]?.name).toBe("营业收入");
    expect(resolved.series[0]?.values).toEqual([100, 200, 300]);
    expect(resolved.series[0]?.color).toBe("#1F4E79");
    expect(resolved.categories).toEqual([2022, 2023, 2024]);
  });

  it("有缓存图表直接用缓存,不依赖工作簿数据", async () => {
    const charts = await parseXlsxCharts(await buildChartXlsx());
    const resolved = resolveChart(DATA, charts[1]!, (i) => `系列 ${i + 1}`);
    expect(resolved.series[0]?.name).toBe("毛利率");
    expect(resolved.series[0]?.values).toEqual([0.21, 0.24]);
    expect(resolved.categories).toEqual(["2023", "2024"]);
  });
});
