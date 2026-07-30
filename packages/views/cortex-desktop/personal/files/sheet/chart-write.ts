// 用户新建图表 → 原生 OOXML 序列化(自研开源版 sheets-chart 的持久化半边):
// 把应用内插入的图表写成真正的 xlsx 图表部件(xl/charts/chartSpace XML + drawing 锚点
// + 两级 rels + [Content_Types] 条目),Excel/WPS 打开即原生图表,且随单元格数据重算。
// 结构对齐 openpyxl 的最小输出(用户真实文件已验证 Excel/WPS 接受),命名空间用规范前缀形。
// 与 workbook-io.graftChartParts 协同:先 graft 回植原文件图表,再由本模块追加新图表——
// 同一工作表已有 drawing 部件时把锚点并进去(OOXML 规定每张 worksheet 至多引用一个 drawing)。

import type { WorkbookChart } from "./chart-io";

const EMU_PER_PX = 9525;

const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const NS_REL_PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_CHART = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const REL_DRAWING = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const CT_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml";

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// ── chartSpace XML ──────────────────────────────────────────────────────────

// 单条系列:名称引用(strRef)/类目引用/值引用 + 可选纯色填充。idx/order 依序号。
function serXml(chart: WorkbookChart, i: number): string {
  const s = chart.series[i]!;
  const parts = [`<c:ser><c:idx val="${i}"/><c:order val="${i}"/>`];
  if (s.nameRef) parts.push(`<c:tx><c:strRef><c:f>${esc(s.nameRef)}</c:f></c:strRef></c:tx>`);
  else if (s.name) parts.push(`<c:tx><c:v>${esc(s.name)}</c:v></c:tx>`);
  if (s.color) {
    parts.push(`<c:spPr><a:solidFill><a:srgbClr val="${s.color.replace(/^#/, "")}"/></a:solidFill></c:spPr>`);
  }
  // 类目/值:文本类目用 strRef 也可,但数值年份等场景 numRef 兼容性最好——统一 numRef 之外,
  // 类目走 strRef 更稳(Excel 对两者都接受;openpyxl 输出 numRef/strRef 混用均可)。
  if (s.catRef) parts.push(`<c:cat><c:strRef><c:f>${esc(s.catRef)}</c:f></c:strRef></c:cat>`);
  if (s.valRef) parts.push(`<c:val><c:numRef><c:f>${esc(s.valRef)}</c:f></c:numRef></c:val>`);
  parts.push(`</c:ser>`);
  return parts.join("");
}

// 图表类型主体。bar/line/area 需要一对坐标轴引用;pie/doughnut 不要轴。
function plotXml(chart: WorkbookChart): string {
  const sers = chart.series.map((_, i) => serXml(chart, i)).join("");
  const axes = `<c:axId val="10"/><c:axId val="100"/>`;
  const axDefs =
    `<c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="100"/></c:catAx>` +
    `<c:valAx><c:axId val="100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="10"/></c:valAx>`;
  switch (chart.kind) {
    case "pie":
      return `<c:pieChart><c:varyColors val="1"/>${sers}</c:pieChart>`;
    case "doughnut":
      return `<c:doughnutChart><c:varyColors val="1"/>${sers}<c:holeSize val="50"/></c:doughnutChart>`;
    case "line":
    case "area": {
      const tag = chart.kind === "line" ? "lineChart" : "areaChart";
      return `<c:${tag}><c:grouping val="standard"/>${sers}<c:marker val="1"/>${axes}</c:${tag}>${axDefs}`;
    }
    case "scatter":
      return `<c:scatterChart><c:scatterStyle val="lineMarker"/>${sers}${axes}</c:scatterChart>${axDefs}`;
    case "hbar":
      return `<c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/>${sers}<c:gapWidth val="150"/>${axes}</c:barChart>${axDefs}`;
    default:
      return `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${sers}<c:gapWidth val="150"/>${axes}</c:barChart>${axDefs}`;
  }
}

export function buildChartSpaceXml(chart: WorkbookChart): string {
  const title = chart.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">` +
    `<c:chart>${title}<c:plotArea><c:layout/>${plotXml(chart)}</c:plotArea>` +
    `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`
  );
}

// ── drawing 锚点 XML ────────────────────────────────────────────────────────

// oneCellAnchor:from 单元格 + EMU 尺寸 + graphicFrame 引用图表 rId。
// 命名空间声明内联在锚点元素上——并入原文件默认命名空间的 drawing 根时前缀依然有效。
export function buildAnchorXml(chart: WorkbookChart, rid: string, frameId: number): string {
  const a = chart.anchor ?? { col: 0, row: 0 };
  const cx = (a.width ?? 480) * EMU_PER_PX;
  const cy = (a.height ?? 300) * EMU_PER_PX;
  return (
    `<xdr:oneCellAnchor xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:c="${NS_C}">` +
    `<xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${cx}" cy="${cy}"/>` +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${frameId}" name="Chart ${frameId}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></xdr:xfrm>` +
    `<a:graphic><a:graphicData uri="${NS_C}"><c:chart r:id="${rid}"/></a:graphicData></a:graphic>` +
    `</xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`
  );
}

// ── 注入 zip ────────────────────────────────────────────────────────────────

// 与 workbook-io.sheetPartsByName 同构(此处独立实现避免循环依赖;正则口径一致)。
async function sheetPartsByName(read: (p: string) => Promise<string | null>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wbXml = await read("xl/workbook.xml");
  const wbRels = await read("xl/_rels/workbook.xml.rels");
  if (!wbXml || !wbRels) return out;
  const targets = new Map<string, string>();
  for (const m of wbRels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (!id || !target || !/relationships\/worksheet"/.test(m[0])) continue;
    targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = /\bname="([^"]+)"/.exec(m[0])?.[1];
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    const part = rid ? targets.get(rid) : undefined;
    if (name && part) out.set(name.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&apos;", "'"), part);
  }
  return out;
}

// 找 zip 内某目录下现有部件的最大编号(chart3.xml → 3),新部件从 max+1 起,避免与回植部件撞名。
function maxPartIndex(names: string[], prefix: string, base: string): number {
  let max = 0;
  const re = new RegExp(`^${prefix}${base}(\\d+)\\.xml$`);
  for (const n of names) {
    const m = re.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

// 把用户新建图表写进(已 graft 的)包。charts 需带 sheetName + series 引用 + anchor。
export async function injectUserCharts(bytes: Uint8Array, charts: WorkbookChart[]): Promise<Uint8Array> {
  const usable = charts.filter((c) => c.sheetName && c.series.length > 0);
  if (usable.length === 0) return bytes;
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const names: string[] = [];
  zip.forEach((p, f) => {
    if (!f.dir) names.push(p);
  });
  const read = async (p: string) => {
    const f = zip.file(p);
    return f ? f.async("string") : null;
  };
  const sheets = await sheetPartsByName(read);
  let chartIdx = maxPartIndex(names, "xl/charts/", "chart");
  let drawingIdx = maxPartIndex(names, "xl/drawings/", "drawing");
  let ct = (await read("[Content_Types].xml")) ?? "";
  let injected = false;

  // 按工作表分组:一表一 drawing。
  const bySheet = new Map<string, WorkbookChart[]>();
  for (const c of usable) {
    const arr = bySheet.get(c.sheetName!) ?? [];
    arr.push(c);
    bySheet.set(c.sheetName!, arr);
  }

  for (const [sheetName, sheetCharts] of bySheet) {
    const sheetPart = sheets.get(sheetName);
    if (!sheetPart) continue;
    let sheetXml = await read(sheetPart);
    if (!sheetXml) continue;
    const sheetRelsPath = `${sheetPart.slice(0, sheetPart.lastIndexOf("/"))}/_rels/${sheetPart.split("/").pop()}.rels`;
    let sheetRels =
      (await read(sheetRelsPath)) ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL_PKG}"></Relationships>`;

    // 已有 drawing(原文件回植的)→ 并入;否则新建 drawing 部件。
    const existingDrawingRel = [...sheetRels.matchAll(/<Relationship\b[^>]*\/?>/g)].find((m) =>
      new RegExp(`Type="${REL_DRAWING}"`).test(m[0]),
    );
    let drawingPath: string;
    let drawingXml: string;
    let drawingRels: string;
    if (existingDrawingRel) {
      const target = /\bTarget="([^"]+)"/.exec(existingDrawingRel[0])?.[1] ?? "";
      drawingPath = target.startsWith("/")
        ? target.slice(1)
        : `xl/${target.replace(/^(\.\.\/)+/, "")}`; // "../drawings/x.xml" → xl/drawings/x.xml
      drawingXml = (await read(drawingPath)) ?? `<xdr:wsDr xmlns:xdr="${NS_XDR}"></xdr:wsDr>`;
      drawingRels =
        (await read(`${drawingPath.slice(0, drawingPath.lastIndexOf("/"))}/_rels/${drawingPath.split("/").pop()}.rels`)) ??
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL_PKG}"></Relationships>`;
    } else {
      drawingIdx += 1;
      drawingPath = `xl/drawings/drawing${drawingIdx}.xml`;
      drawingXml = `<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}"></xdr:wsDr>`;
      drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL_PKG}"></Relationships>`;
      // sheet 引用新 drawing。
      const sheetRid = "rIdUserDr1";
      sheetRels = sheetRels.replace(
        "</Relationships>",
        `<Relationship Id="${sheetRid}" Type="${REL_DRAWING}" Target="/${drawingPath}"/></Relationships>`,
      );
      sheetXml = sheetXml.replace("</worksheet>", `<drawing r:id="${sheetRid}"/></worksheet>`);
      if (!ct.includes(`PartName="/${drawingPath}"`)) {
        ct = ct.replace("</Types>", `<Override PartName="/${drawingPath}" ContentType="${CT_DRAWING}"/></Types>`);
      }
    }

    // 逐图:建 chart 部件 + drawing rels + 锚点。
    sheetCharts.forEach((chart, i) => {
      chartIdx += 1;
      const chartPath = `xl/charts/chart${chartIdx}.xml`;
      zip.file(chartPath, buildChartSpaceXml(chart));
      const rid = `rIdUserCh${chartIdx}`;
      drawingRels = drawingRels.replace(
        "</Relationships>",
        `<Relationship Id="${rid}" Type="${REL_CHART}" Target="/${chartPath}"/></Relationships>`,
      );
      // 锚点插到 wsDr 根闭合前(根可能是 <xdr:wsDr> 或默认命名空间 <wsDr>,前缀正则两者都吃)。
      drawingXml = drawingXml.replace(/<\/(\w+:)?wsDr>/, `${buildAnchorXml(chart, rid, 1000 + chartIdx + i)}</$1wsDr>`);
      if (!ct.includes(`PartName="/${chartPath}"`)) {
        ct = ct.replace("</Types>", `<Override PartName="/${chartPath}" ContentType="${CT_CHART}"/></Types>`);
      }
    });

    zip.file(drawingPath, drawingXml);
    zip.file(`${drawingPath.slice(0, drawingPath.lastIndexOf("/"))}/_rels/${drawingPath.split("/").pop()}.rels`, drawingRels);
    zip.file(sheetRelsPath, sheetRels);
    zip.file(sheetPart, sheetXml);
    injected = true;
  }

  if (!injected) return bytes;
  zip.file("[Content_Types].xml", ct);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}
