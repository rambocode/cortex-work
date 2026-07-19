// 表格文件 ↔ Univer IWorkbookData 转换层（内置表格预览/编辑的 IO 核心）。
// - xlsx 走 exceljs（Univer 开源版的 xlsx 导入导出属 Pro/依赖 Univer Server,本地不可用,故自写）;
// - csv 自带极简解析器（引号/换行/BOM）,与 xlsx 汇入同一 IWorkbookData 形状。
// 保真边界（实用级）:值/公式/合并单元格/列宽行高/基础样式（字体/填充/对齐/边框/数字格式）保留;
// 图表/透视表/条件格式/数据验证/图片/宏 等高级特性不解析,写回即丢失——调用方保存前须提醒+备份。
// 注意:exceljs 仅在函数内动态 import（views 同时被 Next.js 打包,顶层引入会污染 web 产物,
// 范式对齐 MonacoViewer 的动态 import 约束）;本模块顶层只允许类型导入。

import type {
  IBorderData,
  IBorderStyleData,
  ICellData,
  IRange,
  IStyleData,
  IWorkbookData,
  IWorksheetData,
  Nullable,
} from "@univerjs/presets";
import type ExcelJS from "exceljs";

// ── A1 地址工具（useSheetSync 拼批注地址也复用）─────────────────────────────

// 0-based 列号 → 字母（0→A, 25→Z, 26→AA）。
export function colToLetter(col: number): string {
  let s = "";
  let n = col;
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

// 0-based 行列 → "B3";带结束行列时输出 "B3:D5"（单格区间退化为单格）。
export function rangeToA1(startRow: number, startCol: number, endRow?: number, endCol?: number): string {
  const head = `${colToLetter(startCol)}${startRow + 1}`;
  if (endRow === undefined || endCol === undefined || (endRow === startRow && endCol === startCol)) return head;
  return `${head}:${colToLetter(endCol)}${endRow + 1}`;
}

// "B3" → { row: 2, col: 1 }（0-based）;非法输入返回 null。
function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: parseInt(m[2]!, 10) - 1, col: col - 1 };
}

// "A1:B2"（或单格 "A1"）→ Univer IRange（0-based 闭区间）;非法返回 null。
export function a1ToRange(a1: string): IRange | null {
  const [s, e] = a1.split(":");
  const start = s ? parseCellRef(s) : null;
  if (!start) return null;
  const end = e ? parseCellRef(e) : start;
  if (!end) return null;
  return { startRow: start.row, startColumn: start.col, endRow: end.row, endColumn: end.col };
}

// ── base64 ↔ 字节（IPC 通道用 base64 传二进制;Node/浏览器双环境）────────────

export function base64ToUint8(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  // 分块拼接避免 String.fromCharCode(...huge) 栈溢出。
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ── 单位换算 ────────────────────────────────────────────────────────────────
// Excel 列宽单位是「字符数」、行高是磅(pt);Univer 两者都是 px。
// 换算系数保持正反对称,确保 读入→写回 不漂移。
const COL_CHAR_TO_PX = 7.5;
const ROW_PT_TO_PX = 4 / 3;

// ── 样式映射（exceljs ↔ Univer IStyleData）──────────────────────────────────

// exceljs 边框样式名 ↔ Univer BorderStyleTypes 枚举值（写死数字,避免顶层引入 runtime 枚举）。
const BORDER_TO_UNIVER: Record<string, number> = {
  thin: 1, hair: 2, dotted: 3, dashed: 4, dashDot: 5, dashDotDot: 6,
  double: 7, medium: 8, mediumDashed: 9, mediumDashDot: 10, mediumDashDotDot: 11,
  slantDashDot: 12, thick: 13,
};
const BORDER_FROM_UNIVER: Record<number, ExcelJS.BorderStyle> = {
  1: "thin", 2: "hair", 3: "dotted", 4: "dashed", 5: "dashDot", 6: "dashDotDot",
  7: "double", 8: "medium", 9: "mediumDashed", 10: "mediumDashDot", 11: "mediumDashDotDot",
  12: "slantDashDot", 13: "thick",
};

// argb "FFRRGGBB" → "#RRGGBB";theme 色等无 argb 的返回 undefined（放弃,不猜色）。
function argbToRgb(color?: Partial<ExcelJS.Color>): string | undefined {
  const argb = color?.argb;
  if (!argb || argb.length < 6) return undefined;
  return "#" + argb.slice(-6).toUpperCase();
}

function rgbToArgb(rgb: string): string {
  return "FF" + rgb.replace(/^#/, "").toUpperCase();
}

// exceljs 单元格样式 → Univer 内联 IStyleData;无任何可映射样式时返回 undefined。
function cellStyleToUniver(cell: ExcelJS.Cell): IStyleData | undefined {
  const s: IStyleData = {};
  const font = cell.font;
  if (font) {
    if (font.name) s.ff = font.name;
    if (font.size) s.fs = font.size;
    if (font.bold) s.bl = 1;
    if (font.italic) s.it = 1;
    if (font.underline) s.ul = { s: 1 };
    if (font.strike) s.st = { s: 1 };
    const cl = argbToRgb(font.color);
    if (cl) s.cl = { rgb: cl };
  }
  const fill = cell.fill;
  if (fill && fill.type === "pattern" && fill.pattern === "solid") {
    const bg = argbToRgb(fill.fgColor);
    if (bg) s.bg = { rgb: bg };
  }
  const al = cell.alignment;
  if (al) {
    if (al.horizontal === "left") s.ht = 1;
    else if (al.horizontal === "center") s.ht = 2;
    else if (al.horizontal === "right") s.ht = 3;
    if (al.vertical === "top") s.vt = 1;
    else if (al.vertical === "middle") s.vt = 2;
    else if (al.vertical === "bottom") s.vt = 3;
    if (al.wrapText) s.tb = 3;
  }
  const bd = cell.border;
  if (bd) {
    const conv = (b?: Partial<ExcelJS.Border>) => {
      if (!b?.style) return undefined;
      const style = BORDER_TO_UNIVER[b.style];
      if (style === undefined) return undefined;
      return { s: style, cl: { rgb: argbToRgb(b.color) ?? "#000000" } };
    };
    const t = conv(bd.top), bo = conv(bd.bottom), l = conv(bd.left), r = conv(bd.right);
    if (t || bo || l || r) s.bd = { t, b: bo, l, r } as IBorderData;
  }
  if (cell.numFmt && typeof cell.numFmt === "string") s.n = { pattern: cell.numFmt };
  return Object.keys(s).length > 0 ? s : undefined;
}

// Univer IStyleData（内联或 styles 字典引用已解析后）→ exceljs 样式,直接落到 cell 上。
function applyUniverStyle(cell: ExcelJS.Cell, s: IStyleData): void {
  const font: Partial<ExcelJS.Font> = {};
  if (s.ff) font.name = s.ff;
  if (s.fs) font.size = s.fs;
  if (s.bl === 1) font.bold = true;
  if (s.it === 1) font.italic = true;
  if (s.ul?.s === 1) font.underline = true;
  if (s.st?.s === 1) font.strike = true;
  if (s.cl?.rgb) font.color = { argb: rgbToArgb(s.cl.rgb) };
  if (Object.keys(font).length > 0) cell.font = font;
  if (s.bg?.rgb) {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rgbToArgb(s.bg.rgb) } };
  }
  const al: Partial<ExcelJS.Alignment> = {};
  if (s.ht === 1) al.horizontal = "left";
  else if (s.ht === 2) al.horizontal = "center";
  else if (s.ht === 3) al.horizontal = "right";
  if (s.vt === 1) al.vertical = "top";
  else if (s.vt === 2) al.vertical = "middle";
  else if (s.vt === 3) al.vertical = "bottom";
  if (s.tb === 3) al.wrapText = true;
  if (Object.keys(al).length > 0) cell.alignment = al;
  if (s.bd) {
    const conv = (b?: Nullable<IBorderStyleData>): Partial<ExcelJS.Border> | undefined => {
      if (!b || b.s === undefined) return undefined;
      const style = BORDER_FROM_UNIVER[b.s];
      if (!style) return undefined;
      return { style, color: b.cl?.rgb ? { argb: rgbToArgb(b.cl.rgb) } : undefined };
    };
    const border: Partial<ExcelJS.Borders> = {};
    const t = conv(s.bd.t), b = conv(s.bd.b), l = conv(s.bd.l), r = conv(s.bd.r);
    if (t) border.top = t;
    if (b) border.bottom = b;
    if (l) border.left = l;
    if (r) border.right = r;
    if (Object.keys(border).length > 0) cell.border = border;
  }
  if (s.n?.pattern) cell.numFmt = s.n.pattern;
}

// ── 单元格值映射 ────────────────────────────────────────────────────────────

// Excel 日期序列号纪元偏移:1970-01-01 距 1899-12-30 共 25569 天。
const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const MS_PER_DAY = 86400000;

// exceljs 单元格值 → Univer ICellData 的 v/f/t 部分（样式另走 cellStyleToUniver）。
// 富文本压平为纯文本、超链接取显示文本、错误值保留错误串;日期转 Excel 序列号
//（配合 numFmt 在 Univer 里仍显示为日期,写回也是 Excel 原生存法,往返一致）。
function cellValueToUniver(cell: ExcelJS.Cell): ICellData | null {
  const value = cell.value;
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return { v: value };
  if (typeof value === "boolean") return { v: value ? 1 : 0, t: 3 };
  if (value instanceof Date) {
    return { v: value.getTime() / MS_PER_DAY + EXCEL_EPOCH_OFFSET_DAYS };
  }
  if (typeof value === "object") {
    const obj = value as unknown as Record<string, unknown>;
    // 公式（含共享公式:exceljs 的 cell.formula 会给出主公式文本）。
    if ("formula" in obj || "sharedFormula" in obj) {
      const formula = (obj.formula as string | undefined) ?? cell.formula;
      const result = obj.result;
      const data: ICellData = {};
      if (formula) data.f = "=" + String(formula).replace(/^=/, "");
      if (typeof result === "number" || typeof result === "string") data.v = result;
      else if (result instanceof Date) data.v = result.getTime() / MS_PER_DAY + EXCEL_EPOCH_OFFSET_DAYS;
      return data.f || data.v !== undefined ? data : null;
    }
    if ("richText" in obj && Array.isArray(obj.richText)) {
      return { v: (obj.richText as { text?: string }[]).map((r) => r.text ?? "").join("") };
    }
    if ("text" in obj) {
      const text = obj.text;
      if (typeof text === "string") return { v: text };
      // hyperlink 的 text 也可能是富文本对象
      if (text && typeof text === "object" && "richText" in (text as object)) {
        return { v: ((text as { richText: { text?: string }[] }).richText ?? []).map((r) => r.text ?? "").join("") };
      }
    }
    if ("error" in obj) return { v: String(obj.error) };
  }
  return null;
}

// ── xlsx → IWorkbookData ────────────────────────────────────────────────────

// 视图留白:数据边界外再给出的空行/空列,让表格有可编辑的余量。
const MIN_ROWS = 200;
const MIN_COLS = 26;

// exceljs 已知缺陷:工作簿含图表时,drawings 部件解析会抛
// "Cannot read properties of undefined (reading 'anchors')"(chart 型 anchor 无对应 media)。
// 兜底:把 xl/drawings/**、xl/charts/** 部件与 sheet XML 里的 <drawing/> 引用整体剥掉后重试。
// 图表本就在「实用级保真」边界外(保存即丢,已有提醒),读取时剥离不额外损失任何会保留的数据。
export async function stripXlsxDrawingParts(bytes: Uint8Array): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const names: string[] = [];
  zip.forEach((path) => names.push(path));
  for (const name of names) {
    if (name.startsWith("xl/drawings/") || name.startsWith("xl/charts/")) zip.remove(name);
  }
  for (const name of names) {
    if (!/^xl\/worksheets\/sheet[^/]*\.xml$/.test(name)) continue;
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async("string");
    const out = xml.replace(/<drawing[^>]*\/>/g, "");
    if (out !== xml) zip.file(name, out);
  }
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

// 读入 xlsx → exceljs Workbook:先直接解析,失败(典型:含图表)则剥离 drawings 重试;
// 重试仍失败时抛出「原始」错误(剥离引入的次生错误对排障没有价值)。
async function loadXlsxWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const { Workbook } = await import("exceljs");
  // exceljs.load 接受 ArrayBuffer;切出精确段避免共享底层 buffer 的偏移问题。
  const load = async (b: Uint8Array) => {
    const wb = new Workbook();
    await wb.xlsx.load(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    return wb;
  };
  try {
    return await load(bytes);
  } catch (err) {
    try {
      return await load(await stripXlsxDrawingParts(bytes));
    } catch {
      throw err;
    }
  }
}

export async function xlsxBufferToWorkbookData(bytes: Uint8Array, fileName: string): Promise<IWorkbookData> {
  const wb = await loadXlsxWorkbook(bytes);

  const sheets: Record<string, Partial<IWorksheetData>> = {};
  const sheetOrder: string[] = [];
  wb.eachSheet((ws, sheetIndex) => {
    const sheetId = `sheet-${sheetIndex}`;
    sheetOrder.push(sheetId);
    const cellData: Record<number, Record<number, ICellData>> = {};
    let maxRow = 0;
    let maxCol = 0;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        // 合并区域的从格(非左上角)在 exceljs 里是 Merge 类型引用主格,跳过(mergeData 已覆盖)。
        if (cell.type === 1 /* ValueType.Merge */) return;
        const data = cellValueToUniver(cell) ?? {};
        const style = cellStyleToUniver(cell);
        if (style) data.s = style;
        if (Object.keys(data).length === 0) return;
        (cellData[rowNumber - 1] ??= {})[colNumber - 1] = data;
        maxRow = Math.max(maxRow, rowNumber);
        maxCol = Math.max(maxCol, colNumber);
      });
    });

    // 合并单元格:exceljs 没有公开 API,惯用 ws.model.merges（"A1:B2" 串数组）。
    const merges = ((ws.model as unknown as { merges?: string[] }).merges ?? [])
      .map((m) => a1ToRange(m))
      .filter((r): r is IRange => r !== null);

    // 列宽/行高:仅记录显式设置过的（缺省交给 Univer 默认值）。
    const columnData: Record<number, { w?: number; hd?: 0 | 1 }> = {};
    ws.columns?.forEach((col, i) => {
      if (col && typeof col.width === "number") {
        columnData[i] = { w: Math.round(col.width * COL_CHAR_TO_PX) };
        maxCol = Math.max(maxCol, i + 1);
      }
    });
    const rowData: Record<number, { h?: number; ah?: number; hd?: 0 | 1 }> = {};
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (typeof row.height === "number") rowData[rowNumber - 1] = { h: Math.round(row.height * ROW_PT_TO_PX) };
    });

    sheets[sheetId] = {
      id: sheetId,
      name: ws.name,
      rowCount: Math.max(maxRow + 50, MIN_ROWS),
      columnCount: Math.max(maxCol + 5, MIN_COLS),
      cellData,
      mergeData: merges,
      columnData,
      rowData,
    };
  });

  // 空工作簿兜底（理论上 xlsx 至少一张表,防御空 sheets 让 Univer 崩溃）。
  if (sheetOrder.length === 0) {
    sheets["sheet-1"] = { id: "sheet-1", name: "Sheet1", rowCount: MIN_ROWS, columnCount: MIN_COLS, cellData: {} };
    sheetOrder.push("sheet-1");
  }

  return {
    id: `wb-${fileName}`,
    name: fileName,
    appVersion: "",
    locale: "zhCN" as IWorkbookData["locale"],
    styles: {},
    sheetOrder,
    sheets,
  };
}

// ── IWorkbookData → xlsx ────────────────────────────────────────────────────

// 解析 ICellData.s:内联对象直接用;字符串 id 查 styles 字典（Univer 保存快照两种形态都有）。
function resolveStyle(s: ICellData["s"], styles: IWorkbookData["styles"]): IStyleData | undefined {
  if (!s) return undefined;
  if (typeof s === "string") return (styles?.[s] as IStyleData | undefined) ?? undefined;
  return s as IStyleData;
}

export async function workbookDataToXlsxBuffer(data: IWorkbookData): Promise<Uint8Array> {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  for (const sheetId of data.sheetOrder) {
    const sheet = data.sheets[sheetId];
    if (!sheet) continue;
    const ws = wb.addWorksheet(sheet.name || sheetId);

    const columnData = (sheet.columnData ?? {}) as Record<number, { w?: number }>;
    for (const [idxStr, col] of Object.entries(columnData)) {
      if (col && typeof col.w === "number") ws.getColumn(Number(idxStr) + 1).width = col.w / COL_CHAR_TO_PX;
    }
    const rowData = (sheet.rowData ?? {}) as Record<number, { h?: number; ah?: number }>;
    for (const [idxStr, row] of Object.entries(rowData)) {
      // h = 显式行高;ah = 自动行高(内容撑开)——写回只认显式值,自动行高交 Excel 自算。
      if (row && typeof row.h === "number") ws.getRow(Number(idxStr) + 1).height = row.h / ROW_PT_TO_PX;
    }

    const cellData = (sheet.cellData ?? {}) as Record<number, Record<number, ICellData>>;
    for (const [rowStr, cols] of Object.entries(cellData)) {
      for (const [colStr, cell] of Object.entries(cols ?? {})) {
        if (!cell) continue;
        const target = ws.getCell(Number(rowStr) + 1, Number(colStr) + 1);
        // 公式优先:只写公式字符串 + 缓存值,不让 Univer 公式引擎的重算结果覆盖语义
        //（Univer 与 Excel 公式引擎不完全等价,Excel 打开时会按公式自行重算）。
        if (cell.f) {
          const result = typeof cell.v === "number" || typeof cell.v === "string" ? cell.v : undefined;
          target.value = { formula: String(cell.f).replace(/^=/, ""), result } as ExcelJS.CellValue;
        } else if (cell.v !== undefined && cell.v !== null) {
          if (cell.t === 3 /* BOOLEAN */) target.value = cell.v === 1 || cell.v === true;
          else target.value = cell.v as ExcelJS.CellValue;
        }
        const style = resolveStyle(cell.s, data.styles);
        if (style) applyUniverStyle(target, style);
      }
    }

    for (const merge of (sheet.mergeData ?? []) as IRange[]) {
      try {
        ws.mergeCells(merge.startRow + 1, merge.startColumn + 1, merge.endRow + 1, merge.endColumn + 1);
      } catch {
        // 重叠/越界的合并区间直接跳过,不让单个坏区间毁掉整次导出。
      }
    }
  }
  const out = await wb.xlsx.writeBuffer();
  return new Uint8Array(out as ArrayBuffer);
}

// ── 原生图表回植（保存不丢图表）─────────────────────────────────────────────
// exceljs 重建 xlsx 时会丢掉它不认识的部件(图表/绘图)。保存时把原文件的
// xl/charts/**、xl/drawings/**、xl/media/** 原样嫁接进重建包:按「工作表名」对齐
// 新旧包的 sheet 部件,补回 <drawing/> 引用、rels 与 [Content_Types] 条目。
// 图表引用的是单元格区间,Excel 打开时按新数据重画——改数据后图表跟着更新。

// 解析 workbook.xml + rels → sheet 名 → 部件路径(如 xl/worksheets/sheet1.xml)。
async function sheetPartsByName(read: (p: string) => Promise<string | null>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wbXml = await read("xl/workbook.xml");
  const wbRels = await read("xl/_rels/workbook.xml.rels");
  if (!wbXml || !wbRels) return out;
  const targets = new Map<string, string>();
  for (const m of wbRels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (!id || !target || !/worksheet/.test(m[0])) continue;
    targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = /\bname="([^"]+)"/.exec(m[0])?.[1];
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    const part = rid ? targets.get(rid) : undefined;
    // XML 实体还原:sheet 名里的 &amp; 等(只处理常见五种,够用)。
    if (name && part) out.set(decodeXmlEntities(name), part);
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export async function graftChartParts(originalBytes: Uint8Array, rebuiltBytes: Uint8Array): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const orig = await JSZip.loadAsync(originalBytes);
  const origNames: string[] = [];
  // forEach 会带出目录条目(dir=true),zip.file(目录) 为 null,只收文件。
  orig.forEach((p, f) => {
    if (!f.dir) origNames.push(p);
  });
  // 待回植部件:绘图/图表/媒体(含各自 _rels)。原文件没有则原样返回。
  const graftParts = origNames.filter(
    (n) => n.startsWith("xl/drawings/") || n.startsWith("xl/charts/") || n.startsWith("xl/media/"),
  );
  if (graftParts.length === 0) return rebuiltBytes;

  const next = await JSZip.loadAsync(rebuiltBytes);
  const readOrig = async (p: string) => {
    const f = orig.file(p);
    return f ? f.async("string") : null;
  };
  const readNext = async (p: string) => {
    const f = next.file(p);
    return f ? f.async("string") : null;
  };

  // 1) 按工作表名建立 旧部件 → 新部件 的映射,收集每张旧表挂的 drawing 目标。
  const origSheets = await sheetPartsByName(readOrig);
  const nextSheets = await sheetPartsByName(readNext);
  let grafted = false;
  for (const [sheetName, origPart] of origSheets) {
    const nextPart = nextSheets.get(sheetName);
    if (!nextPart) continue; // 该表在编辑中被删/改名:其图表随之丢弃(与 Excel 行为一致)
    const origRels = await readOrig(`${origPart.slice(0, origPart.lastIndexOf("/"))}/_rels/${origPart.split("/").pop()}.rels`);
    if (!origRels) continue;
    const drawingTargets: string[] = [];
    for (const m of origRels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
      if (!/officeDocument\/2006\/relationships\/drawing"/.test(m[0])) continue;
      const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
      if (target) drawingTargets.push(target);
    }
    if (drawingTargets.length === 0) continue;

    // 2) 新 sheet 部件:补 rels(无则新建)+ 在 </worksheet> 前插 <drawing/> 引用。
    const nextRelsPath = `${nextPart.slice(0, nextPart.lastIndexOf("/"))}/_rels/${nextPart.split("/").pop()}.rels`;
    let relsXml =
      (await readNext(nextRelsPath)) ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    let sheetXml = await readNext(nextPart);
    if (!sheetXml) continue;
    drawingTargets.forEach((target, i) => {
      // rId 只需在该 rels 内唯一,用带前缀的自定义 id 避免与 exceljs 生成的 rId 撞号。
      const rid = `rIdGraftDr${i + 1}`;
      relsXml = relsXml.replace(
        "</Relationships>",
        `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="${target}"/></Relationships>`,
      );
      sheetXml = sheetXml!.replace("</worksheet>", `<drawing r:id="${rid}"/></worksheet>`);
    });
    next.file(nextRelsPath, relsXml);
    next.file(nextPart, sheetXml);
    grafted = true;
  }
  if (!grafted) return rebuiltBytes;

  // 3) 拷贝部件本体(二进制原样)。
  for (const p of graftParts) {
    const data = await orig.file(p)!.async("uint8array");
    next.file(p, data);
  }

  // 4) [Content_Types].xml:把原包中涉及回植部件的 Override/Default 条目补进新包。
  const origCt = await readOrig("[Content_Types].xml");
  let nextCt = await readNext("[Content_Types].xml");
  if (origCt && nextCt) {
    for (const m of origCt.matchAll(/<Override\b[^>]*\/>/g)) {
      const part = /\bPartName="([^"]+)"/.exec(m[0])?.[1];
      if (!part) continue;
      const inner = part.startsWith("/") ? part.slice(1) : part;
      if (!graftParts.includes(inner)) continue;
      if (!nextCt.includes(`PartName="${part}"`)) nextCt = nextCt.replace("</Types>", `${m[0]}</Types>`);
    }
    for (const m of origCt.matchAll(/<Default\b[^>]*\/>/g)) {
      const ext = /\bExtension="([^"]+)"/.exec(m[0])?.[1];
      if (!ext) continue;
      // 媒体文件扩展名(png/jpeg 等)的 Default 声明缺失会让包非法。
      if (graftParts.some((p) => p.endsWith(`.${ext}`)) && !nextCt.includes(`Extension="${ext}"`)) {
        nextCt = nextCt.replace("</Types>", `${m[0]}</Types>`);
      }
    }
    next.file("[Content_Types].xml", nextCt);
  }

  return new Uint8Array(await next.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

// ── csv ↔ IWorkbookData ────────────────────────────────────────────────────

// RFC4180 风格解析:双引号字段、字段内 "" 转义、\r\n 与 \n 混用、开头 BOM。
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  // 末行无换行结尾时补收;纯空尾行丢弃。
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// 数字化门槛:仅当数字化后能无损还原原字符串才转数字（"007"、"1e3"、超长数字串都保持字符串,
// 避免 csv 往返丢前导零/变科学计数法）。
function csvCellValue(raw: string): string | number {
  if (raw === "" || !/^-?\d+(\.\d+)?$/.test(raw)) return raw;
  const n = Number(raw);
  return String(n) === raw ? n : raw;
}

export function csvTextToWorkbookData(text: string, fileName: string): IWorkbookData {
  const rows = parseCsv(text);
  const cellData: Record<number, Record<number, ICellData>> = {};
  let maxCol = 0;
  rows.forEach((cols, r) => {
    cols.forEach((raw, c) => {
      if (raw === "") return;
      (cellData[r] ??= {})[c] = { v: csvCellValue(raw) };
      maxCol = Math.max(maxCol, c + 1);
    });
  });
  const sheetId = "sheet-1";
  return {
    id: `wb-${fileName}`,
    name: fileName,
    appVersion: "",
    locale: "zhCN" as IWorkbookData["locale"],
    styles: {},
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: "Sheet1",
        rowCount: Math.max(rows.length + 50, MIN_ROWS),
        columnCount: Math.max(maxCol + 5, MIN_COLS),
        cellData,
      },
    },
  };
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
}

// 只导出首个 sheet(csv 无多表概念);公式格写缓存值,无值才落公式文本。
export function workbookDataToCsvText(data: IWorkbookData): string {
  const sheet = data.sheets[data.sheetOrder[0] ?? ""] ?? Object.values(data.sheets)[0];
  const cellData = ((sheet?.cellData ?? {}) as Record<number, Record<number, ICellData>>);
  let maxRow = -1;
  let maxCol = -1;
  for (const [rowStr, cols] of Object.entries(cellData)) {
    for (const [colStr, cell] of Object.entries(cols ?? {})) {
      if (!cell || (cell.v === undefined && !cell.f)) continue;
      maxRow = Math.max(maxRow, Number(rowStr));
      maxCol = Math.max(maxCol, Number(colStr));
    }
  }
  const lines: string[] = [];
  for (let r = 0; r <= maxRow; r++) {
    const fields: string[] = [];
    for (let c = 0; c <= maxCol; c++) {
      const cell = cellData[r]?.[c];
      const v = cell?.v ?? (cell?.f ? String(cell.f) : "");
      fields.push(csvEscape(v === null || v === undefined ? "" : String(v)));
    }
    lines.push(fields.join(","));
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}
