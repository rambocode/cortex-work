// Slides 导出场景模型:把浏览器渲染后的 DOM 提炼为与 DOM 无关的「场景节点」列表,
// 供 HTML → PPTX 混合导出使用。分类目标:普通文本/图片/表格/简单形状重建为 PPTX 原生对象
// (保持可编辑),复杂视觉层(canvas、滤镜、复杂渐变等)降级为栅格图。
// 该模型是纯数据(JSON 可序列化),提取在隐藏 BrowserWindow 页内脚本完成(dom-extractor),
// 转换在 Node 侧完成(pptx.ts)。
import { buildSceneExportReport, type DeckExportReport as CoreDeckExportReport, type SceneExportQuality, type SceneExportReport as CoreSceneExportReport } from "@cortex-work/core/design/slides/slides-export-quality";
import type { SlidesChartSpec } from "./chart-spec";

/** 场景节点共有字段:画布内像素坐标(左上原点)与绘制次序 z(越大越靠上)。 */
export interface SceneNodeBase {
  id: string;
  /** 相对画布(1280×720)的像素边界。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 绘制次序:提取时按 DOM 顺序 + z-index 的简化 stacking 规则分配,转换时按 z 升序落 PPTX。 */
  z: number;
  /** 简单 rotate() 提取为角度;复杂 transform 继续走 raster。 */
  rotateDeg?: number;
  /** CSS opacity 0..1。 */
  opacity?: number;
}

/** 单段同样式文本(对应 PPTX text run)。 */
export interface SceneTextRun {
  text: string;
  /** 换行标记:该 run 结束后强制换行(<br> 或块内段落边界)。 */
  breakAfter?: boolean;
  fontFamily: string;
  /** px 字号(转换侧再换算为 pt)。 */
  fontSizePx: number;
  /** 六位十六进制,不含 #。 */
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  bullet?: { type: "bullet" } | { type: "number"; numberStartAt?: number };
  paraSpaceBeforePx?: number;
  paraSpaceAfterPx?: number;
}

/** 文本块:一个块级元素内的全部内联文本,重建为原生 PPTX 文本框。 */
export interface SceneTextNode extends SceneNodeBase {
  kind: "text";
  runs: SceneTextRun[];
  align: "left" | "center" | "right" | "justify";
  valign?: "top" | "middle" | "bottom";
  /** 行高(px),用于换算 PPTX lineSpacing。 */
  lineHeightPx: number;
  /** 垂直内边距等造成的首行偏移已折算进 y/h,这里保留原始 padding 供调试。 */
  paddingPx: { top: number; right: number; bottom: number; left: number };
}

/** 图片:<img>(data URI 或本地文件)与内联 <svg>(序列化为 svg data URI)。 */
export interface SceneImageNode extends SceneNodeBase {
  kind: "image";
  /** data URI 或 file:// URL;转换侧只支持 data URI 与 file://。 */
  src: string;
  objectFit?: "fill" | "contain" | "cover";
  objectPosition?: { x: number; y: number };
  intrinsicSize?: { width: number; height: number };
  /** 圆角半径 px(仅记录,POC 不重建圆角裁剪)。 */
  borderRadiusPx?: number;
}

/** 表格单元格(纯文本 + 基础样式)。 */
export interface SceneTableCell {
  text: string;
  bold: boolean;
  color: string;
  /** 背景色,六位 hex;透明为 undefined。 */
  fill?: string;
  align: "left" | "center" | "right";
  fontSizePx: number;
  colspan?: number;
  rowspan?: number;
}

/** 简单表格:重建为原生 PPTX table。 */
export interface SceneTableNode extends SceneNodeBase {
  kind: "table";
  rows: SceneTableCell[][];
  /** 每列宽度 px(按首行单元格实测)。 */
  colWidthsPx: number[];
  /** 边框颜色(hex)与宽度 px;无边框为 undefined。 */
  border?: { color: string; widthPx: number };
  fontFamily: string;
}

/** 简单形状:纯色背景块/边框矩形,重建为原生 PPTX shape。 */
export interface SceneShapeNode extends SceneNodeBase {
  kind: "shape";
  /** 填充色 hex;无填充为 undefined(纯边框矩形)。 */
  fill?: string;
  /** 填充不透明度 0-100。 */
  fillOpacity?: number;
  border?: { color: string; widthPx: number };
  borderRadiusPx?: number;
}

/** 原生图表:由 data-cortex-chart-spec 驱动,重建为 PPTX 原生 chart。 */
export interface SceneChartNode extends SceneNodeBase {
  kind: "chart";
  spec: SlidesChartSpec;
  ariaLabel?: string;
  style?: {
    fontFamily?: string;
    fontSizePx?: number;
    color?: string;
    backgroundColor?: string;
  };
}

/** 复杂层:无法安全重建为原生对象,由 base raster(隐藏原生节点后的整页截图)承载。 */
export interface SceneRasterNode extends SceneNodeBase {
  kind: "raster";
  /** 降级原因(canvas / css-filter / complex-gradient / transform / blend-mode / clip-path 等)。 */
  reason: string;
}

export type SceneNode = SceneTextNode | SceneImageNode | SceneTableNode | SceneShapeNode | SceneChartNode | SceneRasterNode;

/** 一页 slide 的完整提取结果。 */
export interface SlideScene {
  width: number;
  height: number;
  /** 页面背景色(hex);渐变等复杂背景时为 undefined 并由 base raster 承载。 */
  backgroundColor?: string;
  nodes: SceneNode[];
  /** 是否存在复杂层(转换侧据此决定是否叠加 base raster 底图)。 */
  hasComplexLayers: boolean;
  /** 提取阶段的告警(远程资源、未识别结构等),供导出报告与测试断言。 */
  warnings: string[];
}

/** 导出报告(POC):每页原生/栅格对象计数与降级原因,验证退出条件用。 */
export type SceneExportReport = CoreSceneExportReport;

export type DeckExportReport = CoreDeckExportReport;

export type { SceneExportQuality };

/** 统计场景的原生/栅格构成,供测试断言与导出日志。 */
export function summarizeScene(scene: SlideScene): SceneExportReport {
  return buildSceneExportReport(scene);
}
