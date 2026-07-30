// 选区 → 图表模型(自研 sheets-chart 的「插入图表」半边)。
// 启发式(对齐 Excel 推荐图表的常见约定):
// - 多行多列:首行 = 各系列名,首列 = 类目,其余列各成一条系列;
// - 单列多行:一条系列(无名),整列为值;单行多列:一条系列,整行为值。
// 产出的 WorkbookChart 只含区间引用(不含缓存)——渲染走 resolveChart 回工作簿取数,
// 保存走 chart-write 序列化为原生图表,Excel 打开后随数据重算。

import type { ChartKind, WorkbookChart } from "./chart-io";
import { colToLetter } from "./workbook-io";

export interface SelectionRect {
  row: number; // 0-based 起始行
  col: number;
  width: number; // 列数
  height: number; // 行数
}

// "'利润表'!$B$2:$B$9" 形式的绝对引用(sheet 名统一加引号,内部单引号翻倍转义)。
function refOf(sheetName: string, r1: number, c1: number, r2: number, c2: number): string {
  const quoted = `'${sheetName.replaceAll("'", "''")}'`;
  const head = `$${colToLetter(c1)}$${r1 + 1}`;
  if (r1 === r2 && c1 === c2) return `${quoted}!${head}`;
  return `${quoted}!${head}:$${colToLetter(c2)}$${r2 + 1}`;
}

// 新图表默认尺寸(px)与摆放:选区下方空一行、同列起。
const DEFAULT_W = 480;
const DEFAULT_H = 300;

export function chartFromSelection(sheetName: string, rect: SelectionRect, kind: ChartKind): WorkbookChart | null {
  const { row, col, width, height } = rect;
  if (width < 1 || height < 1 || (width === 1 && height === 1)) return null;

  const series: WorkbookChart["series"] = [];
  if (width >= 2 && height >= 2) {
    // 首行系列名、首列类目、其余各列一条系列。
    const catRef = refOf(sheetName, row + 1, col, row + height - 1, col);
    for (let c = col + 1; c < col + width; c++) {
      series.push({
        nameRef: refOf(sheetName, row, c, row, c),
        catRef,
        valRef: refOf(sheetName, row + 1, c, row + height - 1, c),
      });
    }
  } else if (width === 1) {
    series.push({ valRef: refOf(sheetName, row, col, row + height - 1, col) });
  } else {
    series.push({ valRef: refOf(sheetName, row, col, row, col + width - 1) });
  }

  return {
    sheetName,
    kind,
    series,
    anchor: { col, row: row + height + 1, width: DEFAULT_W, height: DEFAULT_H },
  };
}
