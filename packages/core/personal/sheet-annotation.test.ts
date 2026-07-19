// sheet-annotation prompt 合成单测:锁住 prompt 结构（文件路径/逐条批注/收尾指令）不回归。
import { describe, expect, it } from "vitest";
import { buildSheetAnnotationPrompt, sheetAnnotationDisplayText, type SheetAnnotation } from "./sheet-annotation";

const A1: SheetAnnotation = {
  id: "a1",
  sheetName: "Sheet1",
  rangeA1: "B3",
  valueSnapshot: "1200",
  formula: "=A3*12",
  note: "改成按季度汇总",
  createdAt: 1,
};

const A2: SheetAnnotation = {
  id: "a2",
  sheetName: "汇总",
  rangeA1: "D5:D10",
  valueSnapshot: "10, 20, 30…",
  note: " 这一列加 10% 税 ",
  createdAt: 2,
};

describe("buildSheetAnnotationPrompt", () => {
  it("含文件绝对路径、逐条批注（sheet/地址/值/公式）与收尾指令", () => {
    const prompt = buildSheetAnnotationPrompt("/data/报表/monthly.xlsx", [A1, A2]);
    expect(prompt).toContain("文件：/data/报表/monthly.xlsx");
    expect(prompt).toContain("1. [Sheet1 · B3] 当前值「1200」 （公式 =A3*12）——批注：改成按季度汇总");
    // 无公式的多格选区不输出公式段;批注文字去首尾空白。
    expect(prompt).toContain("2. [汇总 · D5:D10] 当前值「10, 20, 30…」——批注：这一列加 10% 税");
    expect(prompt).toContain("只修改批注指向的单元格/区域");
    expect(prompt).toContain("保存回原路径");
  });

  it("空值快照不输出「当前值」段", () => {
    const prompt = buildSheetAnnotationPrompt("/a.csv", [{ ...A1, valueSnapshot: "", formula: undefined }]);
    expect(prompt).toContain("1. [Sheet1 · B3]——批注：改成按季度汇总");
    expect(prompt).not.toContain("当前值");
  });
});

describe("sheetAnnotationDisplayText", () => {
  it("单条取地址+文字,多条带计数", () => {
    expect(sheetAnnotationDisplayText([A1])).toBe("按表格批注修改：[B3] 改成按季度汇总");
    expect(sheetAnnotationDisplayText([A1, A2])).toBe("按表格批注修改：[B3] 改成按季度汇总 等 2 条");
    expect(sheetAnnotationDisplayText([])).toBe("按表格批注修改");
  });
});
