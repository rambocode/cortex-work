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
      breakLine: r.breakAfter === true,
    },
  }));
  slide.addText(runs, {
    x: pxToIn(node.x),
    y: pxToIn(node.y),
    w: pxToIn(node.w),
    h: pxToIn(node.h),
    align: node.align === "justify" ? "left" : node.align,
    valign: "top",
    margin: 0,
    lineSpacing: pxToPt(node.lineHeightPx),
  });
}

function addImageNode(slide: PptxGenJS.Slide, node: SceneImageNode): void {
  const geom = { x: pxToIn(node.x), y: pxToIn(node.y), w: pxToIn(node.w), h: pxToIn(node.h) };
  if (node.src.startsWith("data:")) {
    slide.addImage({ data: node.src, ...geom });
  } else if (node.src.startsWith("file://")) {
    slide.addImage({ path: new URL(node.src).pathname, ...geom });
  }
}

function addTableNode(slide: PptxGenJS.Slide, node: SceneTableNode): void {
  const rows: PptxGenJS.TableRow[] = node.rows.map((row) =>
    row.map((cell) => ({
      text: cell.text,
      options: {
        bold: cell.bold,
        color: cell.color,
        fill: cell.fill ? { color: cell.fill } : undefined,
        align: cell.align,
        fontSize: pxToPt(cell.fontSizePx),
        fontFace: node.fontFamily,
        valign: "middle" as const,
      },
    })),
  );
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
      ? { color: node.fill, transparency: 100 - (node.fillOpacity ?? 100) }
      : { type: "none" },
    line: node.border
      ? { color: node.border.color, width: pxToPt(node.border.widthPx) }
      : { type: "none" },
  };
  if (rounded) {
    // rectRadius 单位是 inch;PPTX 圆角实际按短边比例呈现,与 CSS 不完全一致,POC 接受近似。
    options.rectRadius = pxToIn(node.borderRadiusPx ?? 0);
    slide.addShape(pptx.ShapeType.roundRect, options);
  } else {
    slide.addShape(pptx.ShapeType.rect, options);
  }
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
    case "raster":
      // 栅格节点由整页 base raster 统一承载,这里不再落单独对象。
      break;
  }
}
