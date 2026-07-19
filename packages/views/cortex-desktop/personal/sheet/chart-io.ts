// xlsx 图表解析层:Univer 开源版不渲染图表,这里直接从 xlsx 包里解析 DrawingML 图表定义
// (xl/charts/chart*.xml),供 SheetChartsPanel 用 echarts 渲染。
// 取数两条路:图表 XML 自带 numCache/strCache 缓存(Excel 保存的文件)直接用;
// 无缓存(openpyxl 等脚本生成的文件只有区间引用 <f>)则按引用回已解析的 IWorkbookData 取值。
// XML 解析一律按 localName 匹配——同一份规范既有 <c:barChart> 前缀写法也有默认命名空间写法。
// 只在函数内动态 import jszip(views 被 Next.js 同时打包,顶层禁重依赖,范式同 workbook-io)。

import type { ICellData, IWorkbookData } from "@univerjs/presets";
import { a1ToRange } from "./workbook-io";

export type ChartKind = "bar" | "hbar" | "line" | "area" | "pie" | "doughnut" | "scatter";

export interface ChartSeriesSpec {
  name?: string; // 缓存里直接取到的系列名
  nameRef?: string; // 系列名的区间引用（如 '利润表'!$A$5）
  catCache?: (string | number)[];
  catRef?: string;
  valCache?: (number | null)[];
  valRef?: string;
  color?: string; // 源文件指定的系列色 "#RRGGBB"（作者意图优先于回退调色板）
}

// 图表在网格上的锚点(drawing XML 的 oneCellAnchor/twoCellAnchor from + ext):
// 0-based 起始行列 + 像素尺寸,用于把渲染出的图表图片按 Excel 原位插回表格。
export interface ChartAnchor {
  col: number;
  row: number;
  width?: number; // px(EMU/9525);无 ext 时缺省,由渲染方给默认尺寸
  height?: number;
}

export interface WorkbookChart {
  sheetName?: string; // 所属工作表（经 sheet→drawing→chart 的 rels 链反查）
  title?: string;
  kind: ChartKind;
  series: ChartSeriesSpec[];
  anchor?: ChartAnchor; // 缺省 = 该图在 drawing 锚点里没找到(只进侧栏,不上网格)
}

// ── localName 工具（前缀无关）────────────────────────────────────────────────

function allByLocal(root: Element | Document, name: string): Element[] {
  const out: Element[] = [];
  const list = (root instanceof Document ? root : root).getElementsByTagName("*");
  for (let i = 0; i < list.length; i++) {
    if (list[i]!.localName === name) out.push(list[i]!);
  }
  return out;
}

function firstByLocal(root: Element | Document, name: string): Element | null {
  return allByLocal(root, name)[0] ?? null;
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

// zip 内相对路径解析:rels 的 Target 有 "/xl/..." 绝对形与 "../charts/x.xml" 相对形两种。
function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const out: string[] = [];
  for (const part of `${baseDir}/${target}`.split("/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

function relsPathOf(partPath: string): string {
  const i = partPath.lastIndexOf("/");
  return `${partPath.slice(0, i)}/_rels/${partPath.slice(i + 1)}.rels`;
}

// ── 图表 XML → WorkbookChart ────────────────────────────────────────────────

// pt 列表(numCache/strCache/numLit/strLit 内)按 idx 排序取值。
function cachePoints(cacheEl: Element, numeric: boolean): (string | number | null)[] {
  const pts = allByLocal(cacheEl, "pt")
    .map((pt) => ({
      idx: Number(pt.getAttribute("idx") ?? 0),
      v: firstByLocal(pt, "v")?.textContent ?? "",
    }))
    .sort((a, b) => a.idx - b.idx);
  return pts.map((p) => (numeric ? (p.v === "" ? null : Number(p.v)) : p.v));
}

// cat/val/tx 三种数据引用体:提取区间引用 f 与缓存值。
function parseDataRef(el: Element | null): { ref?: string; strCache?: (string | number)[]; numCache?: (number | null)[] } {
  if (!el) return {};
  const ref = firstByLocal(el, "f")?.textContent?.trim() || undefined;
  const numCacheEl = firstByLocal(el, "numCache") ?? firstByLocal(el, "numLit");
  if (numCacheEl) return { ref, numCache: cachePoints(numCacheEl, true) as (number | null)[] };
  const strCacheEl = firstByLocal(el, "strCache") ?? firstByLocal(el, "strLit");
  if (strCacheEl) return { ref, strCache: cachePoints(strCacheEl, false) as (string | number)[] };
  return { ref };
}

// plotArea 里的类型元素 → 图表种类。组合图取首个类型(实用级:整图按主类型渲染)。
const KIND_BY_TAG: Record<string, ChartKind> = {
  barChart: "bar",
  bar3DChart: "bar",
  lineChart: "line",
  line3DChart: "line",
  areaChart: "area",
  pieChart: "pie",
  pie3DChart: "pie",
  doughnutChart: "doughnut",
  scatterChart: "scatter",
};

function parseChartXml(xml: string): Omit<WorkbookChart, "sheetName"> | null {
  const doc = parseXml(xml);
  const plotArea = firstByLocal(doc, "plotArea");
  if (!plotArea) return null;

  let kind: ChartKind | null = null;
  let typedEl: Element | null = null;
  for (const child of Array.from(plotArea.children)) {
    const k = KIND_BY_TAG[child.localName];
    if (k) {
      kind = k;
      typedEl = child;
      break;
    }
  }
  if (!kind || !typedEl) return null;
  // 条形图方向:barDir val="bar" 为横向。
  if (kind === "bar" && firstByLocal(typedEl, "barDir")?.getAttribute("val") === "bar") kind = "hbar";

  const series: ChartSeriesSpec[] = [];
  for (const ser of allByLocal(typedEl, "ser")) {
    const spec: ChartSeriesSpec = {};
    // 系列名:tx 下缓存直取或留引用。
    const tx = firstByLocal(ser, "tx");
    if (tx) {
      const t = parseDataRef(tx);
      spec.nameRef = t.ref;
      const cached = t.strCache?.[0];
      if (cached !== undefined && cached !== "") spec.name = String(cached);
      // <tx><v>直接文本</v></tx> 形态
      if (!spec.name && !spec.nameRef) {
        const v = firstByLocal(tx, "v")?.textContent;
        if (v) spec.name = v;
      }
    }
    const cat = parseDataRef(firstByLocal(ser, "cat") ?? firstByLocal(ser, "xVal"));
    spec.catRef = cat.ref;
    spec.catCache = cat.strCache ?? (cat.numCache?.map((n) => n ?? "") as (string | number)[] | undefined);
    const val = parseDataRef(firstByLocal(ser, "val") ?? firstByLocal(ser, "yVal"));
    spec.valRef = val.ref;
    spec.valCache = val.numCache;
    // 源文件指定的系列填充色(首个 srgbClr;实用级,不细分 marker/line)。
    const rgb = firstByLocal(ser, "srgbClr")?.getAttribute("val");
    if (rgb && /^[0-9A-Fa-f]{6}$/.test(rgb)) spec.color = `#${rgb.toUpperCase()}`;
    series.push(spec);
  }
  if (series.length === 0) return null;

  // 标题:只认 <chart> 直下的 <title>(plotArea 里坐标轴也有 title 元素,不能误取);
  // 取到后拼接其中全部 a:t 文本。
  const titleEl = allByLocal(doc, "title").find((el) => el.parentElement?.localName === "chart") ?? null;
  const title = titleEl
    ? allByLocal(titleEl, "t").map((t) => t.textContent ?? "").join("").trim() || undefined
    : undefined;

  return { title, kind, series };
}

// ── xlsx 包 → 全部图表（含所属工作表反查）───────────────────────────────────

export async function parseXlsxCharts(bytes: Uint8Array): Promise<WorkbookChart[]> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const text = async (path: string): Promise<string | null> => {
    const f = zip.file(path);
    return f ? f.async("string") : null;
  };

  // workbook.xml:sheet 名 ↔ r:id;workbook rels:r:id → worksheet 部件路径。
  const workbookXml = await text("xl/workbook.xml");
  const workbookRels = await text("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !workbookRels) return [];
  const relTargets = new Map<string, string>();
  for (const rel of allByLocal(parseXml(workbookRels), "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) relTargets.set(id, resolveTarget("xl", target));
  }
  const sheets: { name: string; partPath: string }[] = [];
  for (const sheet of allByLocal(parseXml(workbookXml), "sheet")) {
    const name = sheet.getAttribute("name");
    // r:id 带命名空间前缀,getAttribute 按限定名匹配,两种写法都试。
    const rid = sheet.getAttribute("r:id") ?? sheet.getAttribute("id");
    const partPath = rid ? relTargets.get(rid) : undefined;
    if (name && partPath) sheets.push({ name, partPath });
  }

  // EMU(English Metric Unit)→ px:9525 EMU/px。
  const EMU_PER_PX = 9525;
  // 锚点元素直下子节点取值(不能用后代匹配:graphicFrame 里还有 a:ext,会撞 localName)。
  const directChild = (el: Element, name: string): Element | null =>
    Array.from(el.children).find((c) => c.localName === name) ?? null;
  const childNum = (el: Element | null, name: string): number => {
    const n = el ? directChild(el, name) : null;
    return n ? Number(n.textContent ?? 0) || 0 : 0;
  };

  const charts: WorkbookChart[] = [];
  for (const { name: sheetName, partPath } of sheets) {
    const sheetRels = await text(relsPathOf(partPath));
    if (!sheetRels) continue;
    const sheetDir = partPath.slice(0, partPath.lastIndexOf("/"));
    for (const rel of allByLocal(parseXml(sheetRels), "Relationship")) {
      if (!rel.getAttribute("Type")?.endsWith("/drawing")) continue;
      const drawingPath = resolveTarget(sheetDir, rel.getAttribute("Target") ?? "");
      const drawingRels = await text(relsPathOf(drawingPath));
      if (!drawingRels) continue;
      const drawingDir = drawingPath.slice(0, drawingPath.lastIndexOf("/"));
      // drawing rels:rId → 图表部件路径。
      const chartTargetById = new Map<string, string>();
      for (const dRel of allByLocal(parseXml(drawingRels), "Relationship")) {
        if (!dRel.getAttribute("Type")?.endsWith("/chart")) continue;
        const id = dRel.getAttribute("Id");
        if (id) chartTargetById.set(id, resolveTarget(drawingDir, dRel.getAttribute("Target") ?? ""));
      }
      if (chartTargetById.size === 0) continue;

      const pushChart = async (chartPath: string, anchor?: ChartAnchor) => {
        const chartXml = await text(chartPath);
        if (!chartXml) return;
        const parsed = parseChartXml(chartXml);
        if (parsed) charts.push({ ...parsed, sheetName, anchor });
      };

      // 优先走 drawing XML 锚点:拿到每张图的网格位置与尺寸(浮动图片按原位插回用)。
      const drawingXml = await text(drawingPath);
      const anchoredIds = new Set<string>();
      if (drawingXml) {
        const root = parseXml(drawingXml).documentElement;
        for (const anchorEl of Array.from(root?.children ?? [])) {
          if (!/Anchor$/.test(anchorEl.localName)) continue;
          // graphicFrame 里的图表引用:<c:chart r:id="rIdN"/>(属性限定名两种写法都试)。
          const chartRefEl = allByLocal(anchorEl, "chart").find(
            (el) => el.getAttribute("r:id") ?? Array.from(el.attributes).find((a) => a.localName === "id"),
          );
          const rid =
            chartRefEl?.getAttribute("r:id") ??
            (chartRefEl ? Array.from(chartRefEl.attributes).find((a) => a.localName === "id")?.value : undefined);
          const chartPath = rid ? chartTargetById.get(rid) : undefined;
          if (!rid || !chartPath) continue;
          anchoredIds.add(rid);
          const from = directChild(anchorEl, "from");
          const ext = directChild(anchorEl, "ext"); // absoluteAnchor 无 from → 锚到 A1
          const anchor: ChartAnchor = {
            col: childNum(from, "col"),
            row: childNum(from, "row"),
            width: ext ? Math.round(Number(ext.getAttribute("cx") ?? 0) / EMU_PER_PX) || undefined : undefined,
            height: ext ? Math.round(Number(ext.getAttribute("cy") ?? 0) / EMU_PER_PX) || undefined : undefined,
          };
          await pushChart(chartPath, anchor);
        }
      }
      // 容错:rels 里有但锚点里没找到的图表(异形文件)仍入列,只是没有网格位置。
      for (const [rid, chartPath] of chartTargetById) {
        if (!anchoredIds.has(rid)) await pushChart(chartPath);
      }
    }
  }
  return charts;
}

// ── 区间引用取数（无缓存文件的取数路径）─────────────────────────────────────

// 解析 "'利润表'!$B$4:$F$4" / "Sheet1!B4:F4" → { sheetName, range };非法返回 null。
function parseSheetRef(ref: string): { sheetName: string; a1: string } | null {
  const m = /^(?:'((?:[^']|'')*)'|([^'!]+))!(\$?[A-Za-z]+\$?\d+(?::\$?[A-Za-z]+\$?\d+)?)$/.exec(ref.trim());
  if (!m) return null;
  const sheetName = (m[1] !== undefined ? m[1].replaceAll("''", "'") : m[2]!).trim();
  return { sheetName, a1: m[3]!.replaceAll("$", "") };
}

// 按引用从已解析的工作簿数据取一串值(行优先展平;取加载时快照,不跟随未保存编辑)。
export function resolveRefValues(data: IWorkbookData, ref: string): (string | number | null)[] {
  const parsed = parseSheetRef(ref);
  if (!parsed) return [];
  const range = a1ToRange(parsed.a1);
  if (!range) return [];
  const sheet = Object.values(data.sheets).find((s) => s?.name === parsed.sheetName);
  if (!sheet) return [];
  const cellData = (sheet.cellData ?? {}) as Record<number, Record<number, ICellData>>;
  const out: (string | number | null)[] = [];
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startColumn; c <= range.endColumn; c++) {
      const v = cellData[r]?.[c]?.v;
      out.push(v === undefined || v === null ? null : (v as string | number));
    }
  }
  return out;
}

// ── 渲染前的最终解析（缓存优先,无缓存回工作簿取数）──────────────────────────

export interface ResolvedChartSeries {
  name: string;
  values: (number | null)[];
  color?: string;
}

export interface ResolvedChart {
  sheetName?: string;
  title?: string;
  kind: ChartKind;
  categories: (string | number)[];
  series: ResolvedChartSeries[];
}

export function resolveChart(data: IWorkbookData, chart: WorkbookChart, fallbackSeriesName: (i: number) => string): ResolvedChart {
  const toNum = (v: string | number | null): number | null => {
    if (v === null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const series: ResolvedChartSeries[] = chart.series.map((s, i) => {
    const values = (s.valCache ?? (s.valRef ? resolveRefValues(data, s.valRef).map(toNum) : [])) as (number | null)[];
    let name = s.name;
    if (!name && s.nameRef) {
      const v = resolveRefValues(data, s.nameRef)[0];
      if (v !== null && v !== undefined && v !== "") name = String(v);
    }
    return { name: name || fallbackSeriesName(i), values, color: s.color };
  });
  // 类目取第一个有类目定义的系列(各系列共用类目是绝对主流)。
  let categories: (string | number)[] = [];
  for (const s of chart.series) {
    if (s.catCache && s.catCache.length > 0) {
      categories = s.catCache;
      break;
    }
    if (s.catRef) {
      const vals = resolveRefValues(data, s.catRef).map((v) => (v === null ? "" : v));
      if (vals.length > 0) {
        categories = vals;
        break;
      }
    }
  }
  if (categories.length === 0) {
    const longest = Math.max(0, ...series.map((s) => s.values.length));
    categories = Array.from({ length: longest }, (_, i) => i + 1);
  }
  return { sheetName: chart.sheetName, title: chart.title, kind: chart.kind, categories, series };
}
