// 图表运行时管理(自研开源版 sheets-chart 的核心 hook):
// - 网格浮动图片的插入/替换/删除(echarts PNG,按锚点上网格);
// - 数据变更防抖重绘——单元格编辑后图表跟着变(Pro 插件的核心体验);
// - 从选区插入新图表、删除/改类型(仅用户新建的);
// - 保存侧:用户新建图表经 chart-write 序列化为原生图表部件,保存成功后转为 file 来源
//   (其部件已进磁盘文件,后续保存由 graft 回植,避免重复注入)。
// 所有对 Univer drawing facade 的调用都做防御(preset 缺失/时序异常时静默降级)。

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { FUniver, IWorkbookData } from "@univerjs/presets";
import { resolveChart, type ChartKind, type WorkbookChart } from "./chart-io";
import { chartFromSelection } from "./chart-insert";
import { renderChartToDataUrl } from "./chart-render";

export interface RuntimeChart extends WorkbookChart {
  rid: string; // 运行时 id(会话内唯一)
  origin: "file" | "user"; // file=文件解析所得(保存走 graft);user=本次新建(保存走 injectUserCharts)
}

// drawing facade 的最小形状(声明合并不稳定,用结构化类型防御)。
interface DrawingSheet {
  newOverGridImage?: () => {
    setSource: (src: string, type: string) => {
      setColumn: (c: number) => {
        setRow: (r: number) => {
          setWidth: (w: number) => { setHeight: (h: number) => { buildAsync: () => Promise<unknown> } };
        };
      };
    };
  };
  insertImages?: (images: unknown[]) => unknown;
  getImageById?: (id: string) => unknown | null;
  deleteImages?: (images: unknown[]) => unknown;
}

const REFRESH_DEBOUNCE_MS = 600;

let ridSeq = 0;
const nextRid = () => `chart-${++ridSeq}`;

export function useSheetCharts(opts: {
  ready: boolean;
  apiRef: MutableRefObject<FUniver | null>;
  workbookDataRef: MutableRefObject<IWorkbookData | null>;
  suppressDirtyRef: MutableRefObject<boolean>;
  markDirty: () => void;
  seriesFallback: (i: number) => string;
}) {
  const { ready, apiRef, workbookDataRef, suppressDirtyRef, markDirty, seriesFallback } = opts;
  const [charts, setCharts] = useState<RuntimeChart[]>([]);
  const chartsRef = useRef(charts);
  chartsRef.current = charts;
  // rid → 网格浮动图片 drawingId(state 外存放,避免插图往返触发重渲染)。
  const imageIdsRef = useRef(new Map<string, string>());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placingRef = useRef(false);

  // 文件重载:文件解析出的图表整体替换,清空图片映射(Univer 实例已重建,旧 id 全失效)。
  const resetFromFile = useCallback((fileCharts: WorkbookChart[]) => {
    imageIdsRef.current.clear();
    setCharts(fileCharts.map((c) => ({ ...c, rid: nextRid(), origin: "file" as const })));
  }, []);

  // 把一张图渲染成 PNG 并插上网格,返回浮动图片 id。
  const placeOne = useCallback(
    async (fws: DrawingSheet, chart: RuntimeChart, data: IWorkbookData): Promise<string | undefined> => {
      if (!fws.newOverGridImage || !fws.insertImages || !chart.anchor) return undefined;
      const resolved = resolveChart(data, chart, seriesFallback);
      if (resolved.series.every((s) => s.values.length === 0)) return undefined;
      const width = chart.anchor.width ?? 480;
      const height = chart.anchor.height ?? 300;
      const url = await renderChartToDataUrl(resolved, width, height);
      if (!url) return undefined;
      const image = await fws
        .newOverGridImage()
        .setSource(url, "BASE64")
        .setColumn(chart.anchor.col)
        .setRow(chart.anchor.row)
        .setWidth(width)
        .setHeight(height)
        .buildAsync();
      fws.insertImages([image]);
      return (image as { drawingId?: string }).drawingId;
    },
    [seriesFallback],
  );

  // 同步网格图片。fullRefresh=true 时先删旧图再按最新数据重绘(数据变更路径);
  // false 时只补缺(初次挂载/新插入)。插入动作全程抑制脏标记。
  const syncImages = useCallback(
    async (fullRefresh: boolean) => {
      const api = apiRef.current;
      if (!api || placingRef.current) return;
      const workbook = api.getActiveWorkbook();
      if (!workbook) return;
      placingRef.current = true;
      suppressDirtyRef.current = true;
      try {
        // 数据变更路径:取最新快照,顺带刷新给批注/侧栏用的数据基线。
        if (fullRefresh) workbookDataRef.current = workbook.save();
        const data = workbookDataRef.current;
        if (!data) return;
        for (const chart of chartsRef.current) {
          if (!chart.anchor || !chart.sheetName) continue;
          const fws = (workbook as { getSheetByName(name: string): unknown }).getSheetByName(
            chart.sheetName,
          ) as DrawingSheet | null;
          if (!fws) continue;
          const existing = imageIdsRef.current.get(chart.rid);
          if (existing && !fullRefresh) continue;
          try {
            if (existing && fws.getImageById && fws.deleteImages) {
              const old = fws.getImageById(existing);
              if (old) fws.deleteImages([old]);
              imageIdsRef.current.delete(chart.rid);
            }
            const id = await placeOne(fws, chart, data);
            if (id) imageIdsRef.current.set(chart.rid, id);
          } catch {
            // 单张失败不拖垮其余
          }
        }
      } finally {
        // 插入命令的 mutation 可能异步到达,延迟一拍再恢复。
        setTimeout(() => {
          suppressDirtyRef.current = false;
        }, 300);
        placingRef.current = false;
      }
    },
    [apiRef, workbookDataRef, suppressDirtyRef, placeOne],
  );

  // 初次挂载 / 图表列表变化:补插缺失的网格图片。
  useEffect(() => {
    if (!ready || charts.length === 0) return;
    void syncImages(false);
  }, [ready, charts, syncImages]);

  // 数据变更 → 防抖全量重绘(SheetViewer 的 mutation 订阅调用)。
  const scheduleRefresh = useCallback(() => {
    if (chartsRef.current.length === 0) return;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void syncImages(true);
    }, REFRESH_DEBOUNCE_MS);
  }, [syncImages]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    },
    [],
  );

  // 从当前选区插入新图表。返回 false = 选区不可用(单格/无选区)。
  const insertFromSelection = useCallback(
    (kind: ChartKind): boolean => {
      const api = apiRef.current;
      const workbook = api?.getActiveWorkbook();
      if (!workbook) return false;
      try {
        const fws = workbook.getActiveSheet();
        const range = fws.getSelection()?.getActiveRange();
        if (!range) return false;
        const chart = chartFromSelection(
          fws.getSheetName(),
          { row: range.getRow(), col: range.getColumn(), width: range.getWidth(), height: range.getHeight() },
          kind,
        );
        if (!chart) return false;
        setCharts((prev) => [...prev, { ...chart, rid: nextRid(), origin: "user" }]);
        markDirty(); // 新图表要随保存写入文件,是实打实的内容变更
        return true;
      } catch {
        return false;
      }
    },
    [apiRef, markDirty],
  );

  // 删除图表(仅 user 来源;UI 层已按 origin 过滤)。
  const removeChart = useCallback(
    (rid: string) => {
      const api = apiRef.current;
      const workbook = api?.getActiveWorkbook();
      const chart = chartsRef.current.find((c) => c.rid === rid);
      const imageId = imageIdsRef.current.get(rid);
      if (workbook && chart?.sheetName && imageId) {
        try {
          const fws = (workbook as { getSheetByName(name: string): unknown }).getSheetByName(
            chart.sheetName,
          ) as DrawingSheet | null;
          const img = fws?.getImageById?.(imageId);
          if (img) fws?.deleteImages?.([img]);
        } catch {
          /* 图片删除失败不阻断状态移除 */
        }
      }
      imageIdsRef.current.delete(rid);
      setCharts((prev) => prev.filter((c) => c.rid !== rid));
      markDirty();
    },
    [apiRef, markDirty],
  );

  // 改类型(仅 user 来源):更新模型 + 触发重绘。
  const changeKind = useCallback(
    (rid: string, kind: ChartKind) => {
      setCharts((prev) => prev.map((c) => (c.rid === rid ? { ...c, kind } : c)));
      markDirty();
      // 图片按新类型重绘(延迟到状态提交后)。
      setTimeout(() => void syncImages(true), 0);
    },
    [markDirty, syncImages],
  );

  // 保存成功后调用:用户图表的部件已写进磁盘文件,来源转为 file(后续保存走 graft 回植,防重复注入)。
  const commitUserCharts = useCallback(() => {
    setCharts((prev) => (prev.some((c) => c.origin === "user") ? prev.map((c) => ({ ...c, origin: "file" as const })) : prev));
  }, []);

  return {
    charts,
    resetFromFile,
    scheduleRefresh,
    insertFromSelection,
    removeChart,
    changeKind,
    commitUserCharts,
    userCharts: () => chartsRef.current.filter((c) => c.origin === "user"),
  };
}
