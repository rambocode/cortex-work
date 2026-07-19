// Univer 实例 ↔ React 的同步薄层:当前选区读取（批注面板用）与数据变更订阅（脏标记用）。
// 全部经 Univer Facade API（FUniver）,并对 facade 调用做防御(try/catch)——
// facade 在个别时序(工作簿销毁中)会抛,预览组件不应因此崩溃。

import { useEffect, useState } from "react";
import type { FUniver } from "@univerjs/presets";
import { rangeToA1 } from "./workbook-io";

// 值快照的截断上限:批注 prompt 里只需要定位语境,不需要整片数据。
const SNAPSHOT_MAX_CHARS = 200;

export interface SheetSelectionInfo {
  sheetName: string;
  rangeA1: string; // "B3" 或 "B3:D5"
  valueSnapshot: string;
  formula?: string; // 单格选区且有公式时给出（含 = 前缀）
}

// 读取当前活动选区（无选区/读取失败返回 null）。
export function readSelectionInfo(api: FUniver): SheetSelectionInfo | null {
  try {
    const workbook = api.getActiveWorkbook();
    if (!workbook) return null;
    const sheet = workbook.getActiveSheet();
    const range = sheet.getSelection()?.getActiveRange();
    if (!range) return null;
    // getA1Notation 带绝对引用参数时行为不同,这里始终用默认(相对)记法;
    // 兜底:老版本 facade 无此方法时用行列号自拼。
    const a1 =
      typeof range.getA1Notation === "function"
        ? range.getA1Notation()
        : rangeToA1(range.getRow(), range.getColumn(), range.getRow() + range.getHeight() - 1, range.getColumn() + range.getWidth() - 1);
    const displays = range.getDisplayValues?.() ?? [];
    const flat = displays.flat().map((v) => String(v ?? "").trim()).filter((v) => v !== "");
    let snapshot = flat.join(", ");
    if (snapshot.length > SNAPSHOT_MAX_CHARS) snapshot = snapshot.slice(0, SNAPSHOT_MAX_CHARS) + "…";
    const isSingleCell = range.getWidth() === 1 && range.getHeight() === 1;
    const formula = isSingleCell ? range.getFormula() : "";
    return {
      sheetName: sheet.getSheetName(),
      rangeA1: a1,
      valueSnapshot: snapshot,
      formula: formula ? formula : undefined,
    };
  } catch {
    return null;
  }
}

// 订阅「数据被改动」:sheet.mutation.* 前缀的命令即内容/样式变更(选区切换等是 operation 前缀,
// 不会误报)。返回退订函数。注意 createWorkbook 初始加载也会触发一批 mutation,
// 调用方需在加载完成后再订阅(SheetViewer 在 createWorkbook 之后才调用本函数,天然规避)。
export function subscribeSheetMutations(api: FUniver, onMutate: () => void): () => void {
  try {
    const disposer = api.onCommandExecuted((command) => {
      if (command.id?.startsWith("sheet.mutation.")) onMutate();
    });
    return () => disposer.dispose();
  } catch {
    return () => {};
  }
}

// 跟随选区变化的 hook:批注面板实时显示「当前选区 B3:D5」。
// ready 翻 true(Univer 挂载完成)后订阅选区 operation;每次选区命令后重读。
export function useSheetSelection(apiGetter: () => FUniver | null, ready: boolean): SheetSelectionInfo | null {
  const [selection, setSelection] = useState<SheetSelectionInfo | null>(null);
  useEffect(() => {
    if (!ready) return;
    const api = apiGetter();
    if (!api) return;
    setSelection(readSelectionInfo(api));
    let disposed = false;
    let disposer: { dispose(): void } | null = null;
    try {
      disposer = api.onCommandExecuted((command) => {
        if (disposed) return;
        // 选区移动/切换工作表都会派发 operation;据此刷新面板里的选区显示。
        if (command.id === "sheet.operation.set-selections" || command.id === "sheet.operation.set-worksheet-active") {
          setSelection(readSelectionInfo(api));
        }
      });
    } catch {
      /* facade 异常:面板退化为「添加时再读选区」*/
    }
    return () => {
      disposed = true;
      disposer?.dispose();
    };
    // apiGetter 是稳定 ref 读取器,不入 deps。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  return selection;
}
