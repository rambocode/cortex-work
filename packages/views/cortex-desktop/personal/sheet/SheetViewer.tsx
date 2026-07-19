// 内置表格预览/编辑容器(xlsx/csv):动态加载 Univer 挂载电子表格,直接可编辑;
// 手动保存(按钮/⌘S,xlsx 首次保存前提醒高级特性丢失 + 主进程自动备份);
// 批注面板(UI 层临时批注 → 合成 prompt 注入会话 composer);
// 外部变更联动(agent 改文件后:无未保存编辑静默重载,有则弹条二选一)。
// Univer/exceljs 全部在 useEffect 内动态 import——views 同时被 Next.js 打包,
// 顶层引入会把巨型依赖卷进 web 产物(范式对齐 MonacoViewer)。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import type { DesktopBridge } from "@cortex-work/core";
import type { FUniver, IWorkbookData, Univer } from "@univerjs/presets";
import {
  buildSheetAnnotationPrompt,
  type SheetAnnotation,
} from "@cortex-work/core/personal/sheet-annotation";
import {
  base64ToUint8,
  csvTextToWorkbookData,
  graftChartParts,
  uint8ToBase64,
  workbookDataToCsvText,
  workbookDataToXlsxBuffer,
  xlsxBufferToWorkbookData,
} from "./workbook-io";
import { readSelectionInfo, subscribeSheetMutations, useSheetSelection } from "./useSheetSync";
import { SheetAnnotationPanel } from "./SheetAnnotationPanel";
import { parseXlsxCharts, resolveChart, type ChartKind } from "./chart-io";
import { injectUserCharts } from "./chart-write";
import { useSheetCharts } from "./useSheetCharts";
import { SheetChartsPanel } from "./SheetChartsPanel";

// 「插入图表」类型菜单顺序(与 i18n key sheet.kind.* 对应)。
const INSERT_KINDS: ChartKind[] = ["bar", "line", "area", "pie"];

type LoadStatus = "loading" | "ready" | "oversize" | "error";

const isCsvName = (name: string) => /\.csv$/i.test(name);

export function SheetViewer({
  filePath,
  fileName,
  bridge,
  onToast,
  onDirtyChange,
  onOpenAsText,
  dirChangeTick,
}: {
  filePath: string;
  fileName: string;
  bridge: DesktopBridge;
  onToast: (text: string) => void;
  // 脏状态上抛:FilesView 头部的未保存 ● 标记复用。
  onDirtyChange?: (dirty: boolean) => void;
  // csv 专用「以文本打开」:切回 Monaco 文本预览(xlsx 无此入口)。
  onOpenAsText?: () => void;
  // 目录 watch 信号计数:变化时比对文件 mtime,判定外部修改(agent 改完文件的闭环入口)。
  dirChangeTick?: number;
}) {
  const { t } = useTranslation("files");
  const isCsv = isCsvName(fileName);
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<FUniver | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadError, setLoadError] = useState("");
  const [dirty, setDirtyState] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [annotations, setAnnotations] = useState<SheetAnnotation[]>([]);
  // 图表面板 / 插入图表类型菜单开关。
  const [chartsOpen, setChartsOpen] = useState(false);
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  // 外部变更静默重载的触发器:自增即重跑加载 effect。
  const [reloadTick, setReloadTick] = useState(0);

  // 供异步回调读取的镜像 ref(避免闭包捕获过期 state)。
  const dirtyRef = useRef(false);
  // 加载时的工作簿数据快照:图表取数用(无 numCache 的文件按区间引用回这里取值)。
  const workbookDataRef = useRef<IWorkbookData | null>(null);
  // 原始 xlsx 字节:保存时把原生图表部件回植进重建包(graftChartParts)用;csv 恒为 null。
  const originalBytesRef = useRef<Uint8Array | null>(null);
  // 程序化插入图表图片期间抑制脏标记(插入是我们自己的动作,不是用户编辑)。
  const suppressDirtyRef = useRef(false);
  const savingRef = useRef(false);
  const openedMtimeRef = useRef(0);
  // xlsx 首次保存的丢特性提醒:每次挂载(每个文件)只问一次。
  const warnedRef = useRef(false);

  const setDirty = useCallback(
    (v: boolean) => {
      dirtyRef.current = v;
      setDirtyState(v);
      onDirtyChange?.(v);
    },
    [onDirtyChange],
  );

  // ── 图表运行时(自研 sheets-chart):网格图片同步/数据变更重绘/插入/删除/改类型 ──
  const seriesFallback = useCallback((i: number) => t("sheet.chartSeriesFallback", { index: i + 1 }), [t]);
  const {
    charts,
    resetFromFile: resetCharts,
    scheduleRefresh,
    insertFromSelection,
    removeChart,
    changeKind,
    commitUserCharts,
    userCharts,
  } = useSheetCharts({
    ready: status === "ready",
    apiRef,
    workbookDataRef,
    suppressDirtyRef,
    markDirty: () => setDirty(true),
    seriesFallback,
  });

  // ── 加载 + 挂载 Univer(换文件由外层 key 重挂载;外部变更重载走 reloadTick)──
  useEffect(() => {
    let disposed = false;
    let univer: Univer | null = null;
    let offMutations = () => {};
    setStatus("loading");
    setDirty(false);
    setConflict(false);

    void (async () => {
      try {
        if (!bridge.readFileBinary) throw new Error("no readFileBinary bridge");
        const res = await bridge.readFileBinary(filePath);
        if (disposed) return;
        if (res.truncated || !res.data) {
          setStatus("oversize");
          return;
        }
        openedMtimeRef.current = res.mtimeMs;
        const bytes = base64ToUint8(res.data);
        const workbookData = isCsv
          ? csvTextToWorkbookData(new TextDecoder().decode(bytes), fileName)
          : await xlsxBufferToWorkbookData(bytes, fileName);
        workbookDataRef.current = workbookData;
        originalBytesRef.current = isCsv ? null : bytes;
        // 图表解析独立于 Univer 挂载,失败静默(图表按钮不出现,表格本体不受影响)。
        resetCharts([]);
        if (!isCsv) {
          void parseXlsxCharts(bytes)
            .then((cs) => {
              if (!disposed) resetCharts(cs);
            })
            .catch(() => {});
        }

        const presets = await import("@univerjs/presets");
        const { UniverSheetsCorePreset } = await import("@univerjs/presets/preset-sheets-core");
        const zhCN = (await import("@univerjs/presets/preset-sheets-core/locales/zh-CN")).default;
        // drawing preset(开源):浮动图片能力——图表按原锚点以图片插回网格靠它。
        const { UniverSheetsDrawingPreset } = await import("@univerjs/presets/preset-sheets-drawing");
        const drawingZhCN = (await import("@univerjs/presets/preset-sheets-drawing/locales/zh-CN")).default;
        // Univer 样式只在真正打开表格时懒加载(不进首屏/不进 web 主包)。
        await import("@univerjs/presets/lib/styles/preset-sheets-core.css");
        await import("@univerjs/presets/lib/styles/preset-sheets-drawing.css");
        if (disposed || !hostRef.current) return;

        const { createUniver, LocaleType, mergeLocales } = presets;
        const inst = createUniver({
          locale: LocaleType.ZH_CN,
          locales: { [LocaleType.ZH_CN]: mergeLocales(zhCN, drawingZhCN) },
          presets: [UniverSheetsCorePreset({ container: hostRef.current }), UniverSheetsDrawingPreset()],
        });
        univer = inst.univer;
        apiRef.current = inst.univerAPI;
        inst.univerAPI.createWorkbook(workbookData);
        setStatus("ready");
        // 初始渲染会异步派发一批 mutation(行高自适应等),延迟订阅避免误标脏;
        // 自动行高 mutation 始终忽略(滚动浏览也会触发,不代表内容变更)。
        setTimeout(() => {
          if (disposed || !apiRef.current) return;
          offMutations = subscribeSheetMutations(apiRef.current, () => {
            // 图表图片程序化插入触发的 mutation:既不算用户编辑,也不再触发重绘(防自激环)。
            if (suppressDirtyRef.current) return;
            if (!dirtyRef.current) setDirty(true);
            // 数据变了 → 网格上的图表按新数据防抖重绘(自研 sheets-chart 的「活图表」)。
            scheduleRefresh();
          });
        }, 300);
      } catch (err) {
        if (!disposed) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
      }
    })();

    return () => {
      disposed = true;
      offMutations();
      apiRef.current = null;
      try {
        univer?.dispose();
      } catch {
        /* Univer 销毁在部分时序会抛,吞掉避免卸载报错 */
      }
    };
    // setDirty 稳定(useCallback);fileName/isCsv 随 filePath 一起变,由外层 key 重挂载兜底。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, reloadTick]);

  // ── 保存(⌘S/按钮):快照 → 序列化 → 二进制写回(首次备份 + 原子替换)────────
  const save = useCallback(async () => {
    const api = apiRef.current;
    if (!api || savingRef.current || !dirtyRef.current || !bridge.writeFileBinary) return;
    const workbook = api.getActiveWorkbook();
    if (!workbook) return;
    // xlsx 保存必丢图表/透视表等高级特性(转换层不解析),首次保存前明示;csv 无此问题。
    if (!isCsv && !warnedRef.current) {
      if (!window.confirm(t("sheet.saveWarnXlsx"))) return;
      warnedRef.current = true;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const snapshot = workbook.save();
      let outBytes: Uint8Array;
      if (isCsv) {
        outBytes = new TextEncoder().encode(workbookDataToCsvText(snapshot));
      } else {
        outBytes = await workbookDataToXlsxBuffer(snapshot);
        // 原生图表回植:把原文件的 charts/drawings 部件嫁接回重建包,保存不丢图表。
        // 回植失败退回无图表版本(首次备份已留底,不阻断保存)。
        if (originalBytesRef.current) {
          try {
            outBytes = await graftChartParts(originalBytesRef.current, outBytes);
          } catch {
            /* 见上:静默退回 */
          }
        }
        // 应用内新建的图表:序列化为原生图表部件写入(Excel 打开即真图表,随数据重算)。
        try {
          outBytes = await injectUserCharts(outBytes, userCharts());
        } catch {
          /* 注入失败不阻断保存,新图表仅留在本次会话 */
        }
        originalBytesRef.current = outBytes;
      }
      const res = await bridge.writeFileBinary(filePath, uint8ToBase64(outBytes), { backup: true });
      openedMtimeRef.current = res.mtimeMs;
      // 新建图表已随保存落盘,来源转 file(下次保存由 graft 回植,避免重复注入)。
      commitUserCharts();
      setDirty(false);
      onToast(res.backupPath ? t("sheet.savedWithBackup") : t("saved"));
    } catch (err) {
      onToast(t("saveFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [bridge, filePath, isCsv, onToast, setDirty, t, userCharts, commitUserCharts]);

  // ⌘S 快捷保存:Univer 自身不拦截系统保存快捷键,window 级监听即可覆盖表格聚焦态。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // ── 外部变更检测:watch 信号 → 比对 mtime → 干净静默重载 / 脏则弹条 ────────
  useEffect(() => {
    if (!dirChangeTick || !bridge.statFile || status !== "ready") return;
    let cancelled = false;
    void bridge
      .statFile(filePath)
      .then((st) => {
        if (cancelled) return;
        // +1ms 容差:写回后我们自己会更新 openedMtime,避免自写触发假外部变更。
        if (st.mtimeMs > openedMtimeRef.current + 1) {
          if (dirtyRef.current) setConflict(true);
          else setReloadTick((v) => v + 1);
        }
      })
      .catch(() => {
        /* 文件可能被删除:保持现状,保存时自会报错 */
      });
    return () => {
      cancelled = true;
    };
    // status 仅作门控,不触发比对;仅在 watch 信号变化时检查。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirChangeTick, bridge, filePath]);

  const reloadFromDisk = () => {
    setDirty(false);
    setConflict(false);
    setAnnotations([]);
    setReloadTick((v) => v + 1);
  };

  const keepMyEdits = () => {
    setConflict(false);
    // 把基线推进到磁盘当前 mtime:同一次外部修改不再重复弹条;保存时用户版本覆盖(备份已兜底)。
    void bridge.statFile?.(filePath).then((st) => {
      openedMtimeRef.current = st.mtimeMs;
    }).catch(() => {});
  };

  // ── 图表面板数据(打开时按当前数据基线解析;网格图片由 useSheetCharts 维护)────
  const panelCharts = useMemo(() => {
    const data = workbookDataRef.current;
    if (!chartsOpen || !data) return [];
    return charts.map((c) => ({
      rid: c.rid,
      origin: c.origin,
      kind: c.kind,
      resolved: resolveChart(data, c, seriesFallback),
    }));
    // workbookDataRef 由加载与防抖重绘维护,charts 变化时基线已就绪。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charts, chartsOpen, seriesFallback]);

  // 从选区插入图表(类型菜单点选后)。
  const insertChart = (kind: ChartKind) => {
    setInsertMenuOpen(false);
    if (insertFromSelection(kind)) onToast(t("sheet.chartInserted"));
    else onToast(t("sheet.chartInsertNeedRange"));
  };

  // ── 批注 ──────────────────────────────────────────────────────────────────
  const selection = useSheetSelection(() => apiRef.current, status === "ready");

  const addAnnotation = (note: string) => {
    // 添加时再实读一次选区(面板显示的 selection 可能落后于极快的选区切换)。
    const info = apiRef.current ? (readSelectionInfo(apiRef.current) ?? selection) : selection;
    if (!info) return;
    setAnnotations((prev) => [
      ...prev,
      {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sheetName: info.sheetName,
        rangeA1: info.rangeA1,
        valueSnapshot: info.valueSnapshot,
        formula: info.formula,
        note,
        createdAt: Date.now(),
      },
    ]);
  };

  const sendAnnotations = () => {
    if (annotations.length === 0) return;
    // 注入 composer(不直接发送):用户可补充一句总体要求后再发,复用 FilesView 选中片段同款通道。
    usePersonalStore.getState().insertToComposer(buildSheetAnnotationPrompt(filePath, annotations));
    setAnnotations([]);
    setPanelOpen(false);
    onToast(t("sheet.annotationsSent"));
  };

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  if (status === "oversize" || status === "error") {
    return (
      <div className="pw-sheet-wrap">
        <div className="pw-panel-empty">
          <div>{status === "oversize" ? t("sheet.tooLarge") : t("sheet.loadFailed", { error: loadError })}</div>
          {bridge.openPath ? (
            <button
              className="pw-ftb-btn"
              onClick={() => void bridge.openPath!(filePath).catch(() => onToast(t("openFailed", { error: fileName })))}
            >
              {t("toolbar.openTitle")}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="pw-sheet-wrap">
      <div className="pw-sheet-toolbar">
        <button
          className="pw-ftb-btn is-primary"
          title={t("toolbar.saveTitle")}
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          <Icon.Check size={12} />
          {saving ? t("sheet.saving") : t("toolbar.save")}
        </button>
        <button
          className={`pw-ftb-btn${panelOpen ? " is-active" : ""}`}
          title={t("sheet.annotateTitle")}
          onClick={() => {
            // 批注/图表两个侧栏互斥,避免把表格挤没。
            setChartsOpen(false);
            setPanelOpen((v) => !v);
          }}
        >
          <Icon.Edit size={12} />
          {annotations.length > 0 ? t("sheet.annotateWithCount", { count: annotations.length }) : t("sheet.annotate")}
        </button>
        {charts.length > 0 ? (
          <button
            className={`pw-ftb-btn${chartsOpen ? " is-active" : ""}`}
            title={t("sheet.chartsTitle")}
            onClick={() => {
              setPanelOpen(false);
              setChartsOpen((v) => !v);
            }}
          >
            <Icon.Chart size={12} />
            {t("sheet.charts", { count: charts.length })}
          </button>
        ) : null}
        {!isCsv && status === "ready" ? (
          // 插入图表:选中数据区域后点选类型,插入网格 + 保存写成原生图表(csv 无 xlsx 容器,不提供)。
          <span className="pw-sheet-insert-wrap">
            <button
              className={`pw-ftb-btn${insertMenuOpen ? " is-active" : ""}`}
              title={t("sheet.insertChartTitle")}
              onClick={() => setInsertMenuOpen((v) => !v)}
            >
              <Icon.Plus size={12} />
              {t("sheet.insertChart")}
            </button>
            {insertMenuOpen ? (
              <span className="pw-sheet-insert-menu" onMouseDown={(e) => e.preventDefault()}>
                {INSERT_KINDS.map((kind) => (
                  <button key={kind} className="pw-ftb-btn" onClick={() => insertChart(kind)}>
                    {t(`sheet.kind.${kind}`)}
                  </button>
                ))}
              </span>
            ) : null}
          </span>
        ) : null}
        {isCsv && onOpenAsText ? (
          <button className="pw-ftb-btn" title={t("sheet.asTextTitle")} onClick={onOpenAsText}>
            {t("sheet.asText")}
          </button>
        ) : null}
        <div className="spacer" />
        {!isCsv ? <span className="pw-sheet-fidelity">{t("sheet.fidelityHint")}</span> : null}
      </div>
      {conflict ? (
        <div className="pw-sheet-conflict">
          <span>{t("sheet.conflictText")}</span>
          <button className="pw-ftb-btn" onClick={reloadFromDisk}>
            {t("sheet.conflictReload")}
          </button>
          <button className="pw-ftb-btn" onClick={keepMyEdits}>
            {t("sheet.conflictKeep")}
          </button>
        </div>
      ) : null}
      <div className="pw-sheet-body">
        {/* host 由 Univer 全权接管 DOM,React 不得在其内部渲染子节点(加载态用兄弟浮层)。 */}
        <div className="pw-sheet-host" ref={hostRef} />
        {status === "loading" ? <div className="pw-sheet-loading">{t("sheet.loading")}</div> : null}
        {panelOpen ? (
          <SheetAnnotationPanel
            annotations={annotations}
            selection={selection}
            onAdd={addAnnotation}
            onRemove={(id) => setAnnotations((prev) => prev.filter((a) => a.id !== id))}
            onSend={sendAnnotations}
            onClose={() => setPanelOpen(false)}
          />
        ) : null}
        {chartsOpen ? (
          <SheetChartsPanel
            charts={panelCharts}
            onClose={() => setChartsOpen(false)}
            onRemove={removeChart}
            onChangeKind={changeKind}
          />
        ) : null}
      </div>
    </div>
  );
}
