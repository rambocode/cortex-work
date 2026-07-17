import { beforeEach, describe, expect, it, vi } from "vitest";

const imageCalls: Array<Record<string, unknown>> = [];
const textCalls: Array<{ text: unknown; options: Record<string, unknown> }> = [];
const tableCalls: Array<{ rows: unknown; options: Record<string, unknown> }> = [];
const shapeCalls: Array<{ type: unknown; options: Record<string, unknown> }> = [];

vi.mock("pptxgenjs", () => {
  class MockSlide {
    addChart() {
      return this;
    }
    addImage(options?: Record<string, unknown>) {
      imageCalls.push(options ?? {});
      return this;
    }
    addText(text: unknown, options?: Record<string, unknown>) {
      textCalls.push({ text, options: options ?? {} });
      return this;
    }
    addTable(rows: unknown, options?: Record<string, unknown>) {
      tableCalls.push({ rows, options: options ?? {} });
      return this;
    }
    addShape(type: unknown, options?: Record<string, unknown>) {
      shapeCalls.push({ type, options: options ?? {} });
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
  imageCalls.length = 0;
  textCalls.length = 0;
  tableCalls.length = 0;
  shapeCalls.length = 0;
});

describe("scenesToPptxBuffer basic native mapping", () => {
  it("映射 svg/img sizing、bullet/number、valign/paragraph spacing、rotate/opacity 与 table merge", async () => {
    const { scenesToPptxBuffer } = await import("./pptx");

    await scenesToPptxBuffer([
      {
        scene: {
          width: 1280,
          height: 720,
          backgroundColor: "ffffff",
          hasComplexLayers: false,
          warnings: ["table-border-radius-approx:merge-table"],
          nodes: [
            {
              kind: "image",
              id: "svg-1",
              x: 60,
              y: 60,
              w: 140,
              h: 90,
              z: 0,
              src: "data:image/svg+xml;utf8,%3Csvg/%3E",
            },
            {
              kind: "image",
              id: "img-contain",
              x: 240,
              y: 50,
              w: 180,
              h: 120,
              z: 1,
              src: "data:image/svg+xml;utf8,%3Csvg/%3E",
              objectFit: "contain",
              objectPosition: { x: 0, y: 1 },
              intrinsicSize: { width: 400, height: 200 },
            },
            {
              kind: "image",
              id: "img-cover",
              x: 470,
              y: 50,
              w: 180,
              h: 120,
              z: 2,
              src: "data:image/svg+xml;utf8,%3Csvg/%3E",
              objectFit: "cover",
              objectPosition: { x: 0.75, y: 0.25 },
              intrinsicSize: { width: 400, height: 200 },
              rotateDeg: 12,
              opacity: 0.7,
            },
            {
              kind: "shape",
              id: "shape-1",
              x: 60,
              y: 220,
              w: 180,
              h: 90,
              z: 3,
              fill: "2563eb",
              borderRadiusPx: 16,
              rotateDeg: 15,
              opacity: 0.6,
            },
            {
              kind: "text",
              id: "text-1",
              x: 60,
              y: 340,
              w: 220,
              h: 90,
              z: 4,
              align: "center",
              valign: "middle",
              lineHeightPx: 24,
              paddingPx: { top: 8, right: 12, bottom: 16, left: 20 },
              rotateDeg: 5,
              opacity: 0.8,
              runs: [
                {
                  text: "第一条项目符号",
                  fontFamily: "Helvetica",
                  fontSizePx: 16,
                  color: "0f172a",
                  bold: false,
                  italic: false,
                  underline: false,
                  bullet: { type: "bullet" },
                  paraSpaceAfterPx: 12,
                  breakAfter: true,
                },
                {
                  text: "第三步",
                  fontFamily: "Helvetica",
                  fontSizePx: 16,
                  color: "0f172a",
                  bold: false,
                  italic: false,
                  underline: false,
                  bullet: { type: "number", numberStartAt: 3 },
                  paraSpaceAfterPx: 10,
                },
              ],
            },
            {
              kind: "table",
              id: "table-1",
              x: 860,
              y: 340,
              w: 320,
              h: 180,
              z: 5,
              fontFamily: "Helvetica",
              colWidthsPx: [106.67, 106.67, 106.67],
              rows: [
                [
                  { text: "汇总", bold: true, color: "0f172a", align: "left", fontSizePx: 15, colspan: 2 },
                  { text: "状态", bold: true, color: "0f172a", align: "left", fontSizePx: 15, rowspan: 2 },
                ],
                [
                  { text: "收入", bold: false, color: "0f172a", align: "left", fontSizePx: 15 },
                  { text: "¥120k", bold: false, color: "0f172a", align: "left", fontSizePx: 15 },
                ],
              ],
            },
          ],
        },
      },
    ]);

    expect(imageCalls[0]).toMatchObject({ data: "data:image/svg+xml;utf8,%3Csvg/%3E", x: 0.625, y: 0.625, w: 1.458, h: 0.938 });
    expect(imageCalls[1]).toMatchObject({
      data: "data:image/svg+xml;utf8,%3Csvg/%3E",
      sizing: { type: "contain", x: 2.5, y: 0.521, w: 1.875, h: 1.25 },
    });
    expect(imageCalls[2]).toMatchObject({
      data: "data:image/svg+xml;utf8,%3Csvg/%3E",
      rotate: 12,
      transparency: 30,
    });
    expect(imageCalls[2]?.sizing).toMatchObject({ type: "crop", x: 4.427, y: 0.521, w: 1.875, h: 1.25 });

    expect(shapeCalls[0]).toMatchObject({
      type: "roundRect",
      options: expect.objectContaining({
        rotate: 15,
        fill: expect.objectContaining({ transparency: 40 }),
      }),
    });

    expect(textCalls[0]?.options).toMatchObject({
      valign: "middle",
      rotate: 5,
      transparency: 20,
      lineSpacing: 18,
      margin: [6, 9, 12, 15],
    });
    expect(textCalls[0]?.text).toEqual([
      expect.objectContaining({
        options: expect.objectContaining({
          bullet: { type: "bullet" },
          paraSpaceAfter: 9,
          breakLine: true,
        }),
      }),
      expect.objectContaining({
        options: expect.objectContaining({
          bullet: { type: "number", numberStartAt: 3 },
          paraSpaceAfter: 7.5,
        }),
      }),
    ]);

    expect(tableCalls[0]?.rows).toEqual([
      [
        expect.objectContaining({ options: expect.objectContaining({ colspan: 2 }) }),
        expect.objectContaining({ text: "状态", options: expect.objectContaining({ rowspan: 2 }) }),
      ],
      [
        expect.objectContaining({ text: "收入" }),
        expect.objectContaining({ text: "¥120k" }),
        expect.objectContaining({ text: "" }),
      ],
    ]);
    expect(tableCalls[0]?.options.colW).toEqual([1.111, 1.111, 1.111]);
  });
});
