// workbook-io 转换层单测:xlsx round-trip（值/公式/合并/列宽行高/基础样式）与
// csv 解析/序列化（引号转义/BOM/数字化门槛）。锁住「实用级保真」边界不回归。
import { describe, expect, it } from "vitest";
import type { ICellData, IStyleData, IWorkbookData } from "@univerjs/presets";
import {
  a1ToRange,
  colToLetter,
  csvTextToWorkbookData,
  graftChartParts,
  parseCsv,
  rangeToA1,
  stripXlsxDrawingParts,
  workbookDataToCsvText,
  workbookDataToXlsxBuffer,
  xlsxBufferToWorkbookData,
} from "./workbook-io";

// 用 exceljs 现造一个含各类特征的 xlsx 字节串（测试内直接 import,无动态约束）。
async function buildFixtureXlsx(): Promise<Uint8Array> {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  const ws = wb.addWorksheet("数据表");
  ws.getCell("A1").value = "名称";
  ws.getCell("B1").value = 1200;
  ws.getCell("C1").value = { formula: "SUM(B1:B2)", result: 3200 };
  ws.getCell("B2").value = 2000;
  ws.getCell("A3").value = true;
  ws.getCell("A1").font = { bold: true, size: 14, color: { argb: "FFCC0000" } };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFEE00" } };
  ws.getCell("A1").alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  ws.getCell("B1").numFmt = "#,##0.00";
  ws.getColumn(1).width = 20;
  ws.getRow(1).height = 30;
  ws.mergeCells("A5:B6");
  wb.addWorksheet("第二表").getCell("A1").value = "second";
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

function firstSheet(data: IWorkbookData) {
  return data.sheets[data.sheetOrder[0]!]!;
}

function cellAt(data: IWorkbookData, row: number, col: number): ICellData | undefined {
  return (firstSheet(data).cellData as Record<number, Record<number, ICellData>>)[row]?.[col];
}

describe("A1 地址工具", () => {
  it("列号与字母互转", () => {
    expect(colToLetter(0)).toBe("A");
    expect(colToLetter(25)).toBe("Z");
    expect(colToLetter(26)).toBe("AA");
    expect(colToLetter(27)).toBe("AB");
  });
  it("rangeToA1 单格与区间", () => {
    expect(rangeToA1(2, 1)).toBe("B3");
    expect(rangeToA1(2, 1, 2, 1)).toBe("B3");
    expect(rangeToA1(0, 0, 4, 3)).toBe("A1:D5");
  });
  it("a1ToRange 解析与非法输入", () => {
    expect(a1ToRange("B3")).toEqual({ startRow: 2, startColumn: 1, endRow: 2, endColumn: 1 });
    expect(a1ToRange("A1:D5")).toEqual({ startRow: 0, startColumn: 0, endRow: 4, endColumn: 3 });
    expect(a1ToRange("!!bad")).toBeNull();
  });
});

describe("xlsx → IWorkbookData", () => {
  it("读出值/公式/布尔/多 sheet", async () => {
    const data = await xlsxBufferToWorkbookData(await buildFixtureXlsx(), "t.xlsx");
    expect(data.sheetOrder).toHaveLength(2);
    expect(firstSheet(data).name).toBe("数据表");
    expect(cellAt(data, 0, 0)?.v).toBe("名称");
    expect(cellAt(data, 0, 1)?.v).toBe(1200);
    expect(cellAt(data, 0, 2)?.f).toBe("=SUM(B1:B2)");
    expect(cellAt(data, 0, 2)?.v).toBe(3200);
    expect(cellAt(data, 2, 0)?.v).toBe(1); // 布尔 → 1 + t:3
    expect(cellAt(data, 2, 0)?.t).toBe(3);
  });

  it("读出基础样式/数字格式/合并/列宽行高", async () => {
    const data = await xlsxBufferToWorkbookData(await buildFixtureXlsx(), "t.xlsx");
    const sheet = firstSheet(data);
    const a1Style = cellAt(data, 0, 0)?.s as IStyleData;
    expect(a1Style.bl).toBe(1);
    expect(a1Style.fs).toBe(14);
    expect(a1Style.cl?.rgb).toBe("#CC0000");
    expect(a1Style.bg?.rgb).toBe("#FFEE00");
    expect(a1Style.ht).toBe(2);
    expect(a1Style.vt).toBe(2);
    expect(a1Style.tb).toBe(3);
    expect((cellAt(data, 0, 1)?.s as IStyleData).n?.pattern).toBe("#,##0.00");
    expect(sheet.mergeData).toContainEqual({ startRow: 4, startColumn: 0, endRow: 5, endColumn: 1 });
    expect((sheet.columnData as Record<number, { w?: number }>)[0]?.w).toBe(150); // 20 字符 × 7.5
    expect((sheet.rowData as Record<number, { h?: number }>)[0]?.h).toBe(40); // 30pt × 4/3
  });
});

describe("xlsx round-trip（读入 → 写出 → 再读入）", () => {
  it("值/公式/合并/列宽行高/样式在往返后保持", async () => {
    const once = await xlsxBufferToWorkbookData(await buildFixtureXlsx(), "t.xlsx");
    const bytes = await workbookDataToXlsxBuffer(once);
    const twice = await xlsxBufferToWorkbookData(bytes, "t.xlsx");

    expect(twice.sheetOrder).toHaveLength(2);
    expect(cellAt(twice, 0, 0)?.v).toBe("名称");
    expect(cellAt(twice, 0, 1)?.v).toBe(1200);
    expect(cellAt(twice, 0, 2)?.f).toBe("=SUM(B1:B2)");
    expect(cellAt(twice, 2, 0)?.v).toBe(1);
    const style = cellAt(twice, 0, 0)?.s as IStyleData;
    expect(style.bl).toBe(1);
    expect(style.bg?.rgb).toBe("#FFEE00");
    expect((cellAt(twice, 0, 1)?.s as IStyleData).n?.pattern).toBe("#,##0.00");
    expect(firstSheet(twice).mergeData).toContainEqual({ startRow: 4, startColumn: 0, endRow: 5, endColumn: 1 });
    // 换算系数正反对称:列宽/行高往返不漂移。
    expect((firstSheet(twice).columnData as Record<number, { w?: number }>)[0]?.w).toBe(150);
    expect((firstSheet(twice).rowData as Record<number, { h?: number }>)[0]?.h).toBe(40);
  });

  it("styles 字典引用形态的样式也能写出", async () => {
    const data = await xlsxBufferToWorkbookData(await buildFixtureXlsx(), "t.xlsx");
    // 手工把 A1 的内联样式挪进 styles 字典,模拟 Univer 快照的 id 引用形态。
    const sheet = firstSheet(data);
    const a1 = (sheet.cellData as Record<number, Record<number, ICellData>>)[0]![0]!;
    data.styles = { st1: a1.s as IStyleData };
    a1.s = "st1";
    const twice = await xlsxBufferToWorkbookData(await workbookDataToXlsxBuffer(data), "t.xlsx");
    expect((cellAt(twice, 0, 0)?.s as IStyleData).bl).toBe(1);
  });
});

describe("stripXlsxDrawingParts（含图表 xlsx 的 exceljs 解析兜底）", () => {
  // 给 fixture 注入 drawings/charts 部件与 sheet 里的 <drawing/> 引用,模拟带图表的工作簿结构。
  async function injectDrawing(bytes: Uint8Array): Promise<Uint8Array> {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(bytes);
    zip.file("xl/drawings/drawing1.xml", "<xdr:wsDr/>");
    zip.file("xl/charts/chart1.xml", "<c:chartSpace/>");
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    zip.file("xl/worksheets/sheet1.xml", sheetXml.replace("</worksheet>", '<drawing r:id="rDr1"/></worksheet>'));
    return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
  }

  it("剥掉 drawings/charts 部件与 <drawing/> 引用,数据仍完整可读", async () => {
    const injected = await injectDrawing(await buildFixtureXlsx());
    const stripped = await stripXlsxDrawingParts(injected);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(stripped);
    expect(zip.file("xl/drawings/drawing1.xml")).toBeNull();
    expect(zip.file("xl/charts/chart1.xml")).toBeNull();
    expect(await zip.file("xl/worksheets/sheet1.xml")!.async("string")).not.toContain("<drawing");
    // 剥离后数据无损:值/公式照常读出。
    const data = await xlsxBufferToWorkbookData(stripped, "t.xlsx");
    expect(cellAt(data, 0, 0)?.v).toBe("名称");
    expect(cellAt(data, 0, 2)?.f).toBe("=SUM(B1:B2)");
  });

  it("注入 drawing 引用的工作簿直接走 xlsxBufferToWorkbookData 也能读出(必要时自动重试)", async () => {
    const injected = await injectDrawing(await buildFixtureXlsx());
    const data = await xlsxBufferToWorkbookData(injected, "t.xlsx");
    expect(cellAt(data, 0, 1)?.v).toBe(1200);
  });
});

describe("graftChartParts（保存时回植原生图表）", () => {
  // 给 fixture 注入完整的图表部件链:drawing + chart + 两级 rels + sheet 引用 + content-type。
  async function buildOriginalWithChart(): Promise<Uint8Array> {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await buildFixtureXlsx());
    zip.file("xl/charts/chart1.xml", `<chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart"/>`);
    zip.file("xl/drawings/drawing1.xml", `<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>`);
    zip.file(
      "xl/drawings/_rels/drawing1.xml.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="/xl/charts/chart1.xml"/></Relationships>`,
    );
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    zip.file("xl/worksheets/sheet1.xml", sheetXml.replace("</worksheet>", `<drawing r:id="rDr1"/></worksheet>`));
    const relsPath = "xl/worksheets/_rels/sheet1.xml.rels";
    const rels =
      (await zip.file(relsPath)?.async("string")) ??
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    zip.file(
      relsPath,
      rels.replace(
        "</Relationships>",
        `<Relationship Id="rDr1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="/xl/drawings/drawing1.xml"/></Relationships>`,
      ),
    );
    const ct = await zip.file("[Content_Types].xml")!.async("string");
    zip.file(
      "[Content_Types].xml",
      ct.replace(
        "</Types>",
        `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`,
      ),
    );
    return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
  }

  it("重建包缺图表 → 回植后部件/引用/rels/content-type 齐全,且仍可读", async () => {
    const original = await buildOriginalWithChart();
    const data = await xlsxBufferToWorkbookData(original, "t.xlsx");
    const rebuilt = await workbookDataToXlsxBuffer(data);
    const grafted = await graftChartParts(original, rebuilt);

    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(grafted);
    expect(zip.file("xl/charts/chart1.xml")).not.toBeNull();
    expect(zip.file("xl/drawings/drawing1.xml")).not.toBeNull();
    expect(zip.file("xl/drawings/_rels/drawing1.xml.rels")).not.toBeNull();
    // 「数据表」是第一张表 → 新包的 sheet1.xml;回植进 <drawing/> 引用与对应 rels。
    expect(await zip.file("xl/worksheets/sheet1.xml")!.async("string")).toContain(`<drawing r:id="rIdGraftDr1"/>`);
    expect(await zip.file("xl/worksheets/_rels/sheet1.xml.rels")!.async("string")).toContain("/xl/drawings/drawing1.xml");
    const ct = await zip.file("[Content_Types].xml")!.async("string");
    expect(ct).toContain(`PartName="/xl/charts/chart1.xml"`);
    expect(ct).toContain(`PartName="/xl/drawings/drawing1.xml"`);
    // 回植后的包仍能进内置读取管线(strip 兜底消化 drawing),数据不受影响。
    const again = await xlsxBufferToWorkbookData(grafted, "t.xlsx");
    expect(cellAt(again, 0, 0)?.v).toBe("名称");
  });

  it("原文件无图表部件 → 原样返回重建包", async () => {
    const plain = await buildFixtureXlsx();
    const data = await xlsxBufferToWorkbookData(plain, "t.xlsx");
    const rebuilt = await workbookDataToXlsxBuffer(data);
    expect(await graftChartParts(plain, rebuilt)).toBe(rebuilt);
  });
});

describe("csv 解析", () => {
  it("引号/转义/换行/BOM", () => {
    expect(parseCsv('a,b\n"c,d","e""f"\n')).toEqual([
      ["a", "b"],
      ["c,d", 'e"f'],
    ]);
    expect(parseCsv("﻿x,y\r\n1,2")).toEqual([
      ["x", "y"],
      ["1", "2"],
    ]);
    expect(parseCsv('"多行\n字段",z\n')).toEqual([["多行\n字段", "z"]]);
  });

  it("数字化门槛:无损才转数字,前导零保持字符串", () => {
    const data = csvTextToWorkbookData("id,qty\n007,12\n", "t.csv");
    expect(cellAt(data, 1, 0)?.v).toBe("007");
    expect(cellAt(data, 1, 1)?.v).toBe(12);
  });
});

describe("csv round-trip", () => {
  it("解析 → 序列化保持内容与转义", () => {
    const src = 'name,note\n张三,"说了""你好"",走了"\n007,12\n';
    const text = workbookDataToCsvText(csvTextToWorkbookData(src, "t.csv"));
    expect(text).toBe(src);
  });

  it("空 workbook 序列化为空串", () => {
    const empty = csvTextToWorkbookData("", "t.csv");
    expect(workbookDataToCsvText(empty)).toBe("");
  });
});
