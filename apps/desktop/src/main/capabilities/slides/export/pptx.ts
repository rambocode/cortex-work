// Slides 场景 → PPTX 转换(纯 Node,无 Electron 依赖):把 dom-extractor 产出的
// SlideScene 按 z 升序重建为 PptxGenJS 原生对象。映射约定:
//   - 画布 1280×720 px ↔ 版面 13.333×7.5 in(即 96 px/inch 精确换算);
//   - 字号 px → pt 按 CSS 标准 1px = 0.75pt;
//   - text/image/table/shape 原生重建(可编辑);raster 节点本身不落对象,
//     由整页 base raster(隐藏原生节点后的截图)作为最底层图片承载。
//
// 打包核查:pptxgenjs 是 apps/desktop 声明依赖,走 externalizeDepsPlugin 从 asar
// node_modules 运行时解析(与 html-to-docx 同路径);electron-builder.yml 的 files
// 排除清单未含 pptxgenjs 及其传递依赖,打包后可正常 require。
import PptxGenJS from "pptxgenjs";
import type {
  SceneChartNode,
  SceneImageNode,
  SceneNode,
  SceneShapeNode,
  SceneTableNode,
  SceneTextNode,
  SlideScene,
} from "./types";
import { summarizeScene, type SceneExportReport } from "./types";

const SLIDE_W_IN = 13.333;
const SLIDE_H_IN = 7.5;
const PX_PER_INCH = 96;

/** px → inch(版面几何)。 */
export function pxToIn(px: number): number {
  return Math.round((px / PX_PER_INCH) * 1000) / 1000;
}

/** px → pt(字号/线宽)。 */
export function pxToPt(px: number): number {
  return Math.round(px * 0.75 * 100) / 100;
}

/** 单页转换输入:场景 + 可选 base raster(dataURI,hasComplexLayers 时作最底层)。 */
export interface SceneSlideInput {
  scene: SlideScene;
  baseRasterDataUri?: string;
  /** 演讲者备注(Markdown 原文);PptxGenJS 写进 PPT 的备注页。 */
  notes?: string;
}

function addTextNode(slide: PptxGenJS.Slide, node: SceneTextNode): void {
  const runs = node.runs.map((r) => ({
    text: r.text,
    options: {
      fontFace: r.fontFamily,
      fontSize: pxToPt(r.fontSizePx),
      color: r.color,
      bold: r.bold,
      italic: r.italic,
      underline: r.underline ? ({ style: "sng" } as const) : undefined,
      bullet: r.bullet,
      paraSpaceBefore: r.paraSpaceBeforePx ? pxToPt(r.paraSpaceBeforePx) : undefined,
      paraSpaceAfter: r.paraSpaceAfterPx ? pxToPt(r.paraSpaceAfterPx) : undefined,
      breakLine: r.breakAfter === true,
    },
  }));
  slide.addText(runs, {
    x: pxToIn(node.x),
    y: pxToIn(node.y),
    w: pxToIn(node.w),
    h: pxToIn(node.h),
    align: node.align === "justify" ? "left" : node.align,
    valign: node.valign ?? "top",
    margin: [
      pxToPt(node.paddingPx.top),
      pxToPt(node.paddingPx.right),
      pxToPt(node.paddingPx.bottom),
      pxToPt(node.paddingPx.left),
    ],
    lineSpacing: pxToPt(node.lineHeightPx),
    rotate: node.rotateDeg,
    transparency: node.opacity !== undefined ? 100 - Math.round(node.opacity * 100) : undefined,
  });
}

function addImageNode(slide: PptxGenJS.Slide, node: SceneImageNode): void {
  const geom = { x: pxToIn(node.x), y: pxToIn(node.y), w: pxToIn(node.w), h: pxToIn(node.h) };
  const options: Record<string, unknown> = {
    ...geom,
    rotate: node.rotateDeg,
    transparency: node.opacity !== undefined ? 100 - Math.round(node.opacity * 100) : undefined,
  };
  if (node.objectFit === "contain") {
    options.sizing = { type: "contain", ...geom };
  } else if (node.objectFit === "cover") {
    let cropX = geom.x;
    let cropY = geom.y;
    if (node.intrinsicSize?.width && node.intrinsicSize?.height && node.objectPosition) {
      const scale = Math.max(node.w / node.intrinsicSize.width, node.h / node.intrinsicSize.height);
      const scaledW = node.intrinsicSize.width * scale;
      const scaledH = node.intrinsicSize.height * scale;
      const overflowX = Math.max(0, scaledW - node.w);
      const overflowY = Math.max(0, scaledH - node.h);
      cropX = pxToIn(node.x - overflowX * node.objectPosition.x);
      cropY = pxToIn(node.y - overflowY * node.objectPosition.y);
    }
    options.sizing = { type: "crop", x: cropX, y: cropY, w: geom.w, h: geom.h };
  }
  if (node.src.startsWith("data:")) {
    slide.addImage({ data: node.src, ...options });
  } else if (node.src.startsWith("file://")) {
    slide.addImage({ path: new URL(node.src).pathname, ...options });
  }
}

function addTableNode(slide: PptxGenJS.Slide, node: SceneTableNode): void {
  const columnCount = node.colWidthsPx.length;
  const occupied = new Set<string>();
  const rows: PptxGenJS.TableRow[] = node.rows.map((row, rowIndex) => {
    const rendered: PptxGenJS.TableRow = [];
    let columnIndex = 0;
    const placeHolder = () => ({
      text: "",
      options: {
        border: { type: "none" as const },
        fill: { color: "FFFFFF", transparency: 100 },
      },
    });
    for (const cell of row) {
      while (occupied.has(`${rowIndex}:${columnIndex}`) && columnIndex < columnCount) {
        rendered.push(placeHolder());
        columnIndex += 1;
      }
      rendered.push({
        text: cell.text,
        options: {
          bold: cell.bold,
          color: cell.color,
          fill: cell.fill ? { color: cell.fill } : undefined,
          align: cell.align,
          fontSize: pxToPt(cell.fontSizePx),
          fontFace: node.fontFamily,
          valign: "middle" as const,
          colspan: cell.colspan,
          rowspan: cell.rowspan,
        },
      });
      const colSpan = cell.colspan ?? 1;
      const rowSpan = cell.rowspan ?? 1;
      for (let r = 0; r < rowSpan; r += 1) {
        for (let c = 0; c < colSpan; c += 1) {
          if (r === 0 && c === 0) continue;
          occupied.add(`${rowIndex + r}:${columnIndex + c}`);
        }
      }
      columnIndex += colSpan;
    }
    while (columnIndex < columnCount) {
      if (occupied.has(`${rowIndex}:${columnIndex}`)) {
        rendered.push(placeHolder());
      }
      columnIndex += 1;
    }
    return rendered;
  });
  slide.addTable(rows, {
    x: pxToIn(node.x),
    y: pxToIn(node.y),
    w: pxToIn(node.w),
    colW: node.colWidthsPx.map(pxToIn),
    rowH: node.rows.length > 0 ? pxToIn(node.h / node.rows.length) : undefined,
    border: node.border
      ? { type: "solid", color: node.border.color, pt: pxToPt(node.border.widthPx) }
      : { type: "none" },
    margin: 0.05,
  });
}

function addShapeNode(pptx: PptxGenJS, slide: PptxGenJS.Slide, node: SceneShapeNode): void {
  const rounded = (node.borderRadiusPx ?? 0) > 0;
  // fill/line 均显式给出:PptxGenJS 缺省会套主题填充,不符合「无背景就透明」的语义。
  const options: PptxGenJS.ShapeProps = {
    x: pxToIn(node.x),
    y: pxToIn(node.y),
    w: pxToIn(node.w),
    h: pxToIn(node.h),
    fill: node.fill
      ? {
          color: node.fill,
          transparency:
            100 -
            Math.round(((node.fillOpacity ?? 100) / 100) * (node.opacity ?? 1) * 100),
        }
      : { type: "none" },
    line: node.border
      ? { color: node.border.color, width: pxToPt(node.border.widthPx) }
      : { type: "none" },
    rotate: node.rotateDeg,
  };
  if (rounded) {
    // rectRadius 单位是 inch;PPTX 圆角实际按短边比例呈现,与 CSS 不完全一致,POC 接受近似。
    options.rectRadius = pxToIn(node.borderRadiusPx ?? 0);
    slide.addShape(pptx.ShapeType.roundRect, options);
  } else {
    slide.addShape(pptx.ShapeType.rect, options);
  }
}

function addChartNode(pptx: PptxGenJS, slide: PptxGenJS.Slide, node: SceneChartNode): void {
  const chartData = node.spec.series.map((series) => ({
    name: series.name,
    labels: node.spec.categories,
    values: series.values,
    color: series.color,
  }));
  const chartColors = node.spec.series.map((series) => series.color).filter((value): value is string => Boolean(value));
  const options: Record<string, unknown> = {
    x: pxToIn(node.x),
    y: pxToIn(node.y),
    w: pxToIn(node.w),
    h: pxToIn(node.h),
    showTitle: false,
    showLegend: node.spec.legend === true,
    legendPos: "r",
    showValue: node.spec.dataLabels === true,
    dataLabelPosition: node.spec.type === "pie" ? "bestFit" : "outEnd",
  };
  if (chartColors.length > 0) options.chartColors = chartColors;
  if (node.style?.fontFamily) {
    options.legendFontFace = node.style.fontFamily;
    options.dataLabelFontFace = node.style.fontFamily;
    options.catAxisTitleFontFace = node.style.fontFamily;
    options.valAxisTitleFontFace = node.style.fontFamily;
  }
  if (node.style?.fontSizePx) {
    const fontSize = pxToPt(node.style.fontSizePx);
    options.legendFontSize = fontSize;
    options.dataLabelFontSize = fontSize;
    options.catAxisTitleFontSize = fontSize;
    options.valAxisTitleFontSize = fontSize;
  }
  if (node.style?.color) {
    options.legendColor = node.style.color;
    options.dataLabelColor = node.style.color;
    options.catAxisLabelColor = node.style.color;
    options.valAxisLabelColor = node.style.color;
    options.catAxisTitleColor = node.style.color;
    options.valAxisTitleColor = node.style.color;
  }
  if (node.spec.type !== "pie") {
    if (node.spec.xAxisTitle) options.catAxisTitle = node.spec.xAxisTitle;
    if (node.spec.yAxisTitle) options.valAxisTitle = node.spec.yAxisTitle;
  }
  slide.addChart(pptx.ChartType[node.spec.type], chartData, options);
}

/** 场景列表 → PPTX Buffer;同时返回每页原生/栅格构成报告(导出日志与测试断言用)。 */
export async function scenesToPptxBuffer(
  slides: SceneSlideInput[],
): Promise<{ buffer: Buffer; reports: SceneExportReport[] }> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "CORTEX_16x9", width: SLIDE_W_IN, height: SLIDE_H_IN });
  pptx.layout = "CORTEX_16x9";

  const reports: SceneExportReport[] = [];
  for (const { scene, baseRasterDataUri, notes } of slides) {
    const slide = pptx.addSlide();
    // 备注写进 PPT 原生备注页(PowerPoint/Keynote 的演讲者视图可见)。
    if (notes && notes.trim()) slide.addNotes(notes);
    if (scene.backgroundColor) {
      slide.background = { color: scene.backgroundColor };
    }
    // 复杂层承载:base raster 已把原生节点隐藏后截图,叠加不会产生重复内容。
    if (scene.hasComplexLayers && baseRasterDataUri) {
      slide.addImage({ data: baseRasterDataUri, x: 0, y: 0, w: SLIDE_W_IN, h: SLIDE_H_IN });
    }
    const ordered = [...scene.nodes].sort((a, b) => a.z - b.z);
    for (const node of ordered) {
      addNode(pptx, slide, node);
    }
    reports.push(summarizeScene(scene));
  }

  const buffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return { buffer, reports };
}

function addNode(pptx: PptxGenJS, slide: PptxGenJS.Slide, node: SceneNode): void {
  switch (node.kind) {
    case "text":
      addTextNode(slide, node);
      break;
    case "image":
      addImageNode(slide, node);
      break;
    case "table":
      addTableNode(slide, node);
      break;
    case "shape":
      addShapeNode(pptx, slide, node);
      break;
    case "chart":
      addChartNode(pptx, slide, node);
      break;
    case "raster":
      // 栅格节点由整页 base raster 统一承载,这里不再落单独对象。
      break;
  }
}
