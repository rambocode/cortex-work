// 表格图表侧栏:渲染从 xlsx 解析/用户新建的图表。echarts 动态 import(重依赖懒加载,
// 范式同 Univer/Monaco);图表数据是当前数据基线的快照(编辑后经防抖重绘刷新)。
// origin=user 的图表(本次会话新建,保存后写成原生图表)可改类型/删除;file 来源只读。
// option 构建与配色规则在 chart-render(与网格浮动图片共用)。
import { useEffect, useRef } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import type { ChartKind, ResolvedChart } from "./chart-io";
import { buildOption, themeVars } from "./chart-render";

export interface PanelChart {
  rid: string;
  origin: "file" | "user";
  kind: ChartKind;
  resolved: ResolvedChart;
}

// 用户图表可切换的类型集合(与工具栏插入菜单一致)。
const KIND_OPTIONS: ChartKind[] = ["bar", "line", "area", "pie"];

export function SheetChartsPanel({
  charts,
  onClose,
  onRemove,
  onChangeKind,
}: {
  charts: PanelChart[];
  onClose: () => void;
  onRemove?: (rid: string) => void;
  onChangeKind?: (rid: string, kind: ChartKind) => void;
}) {
  const { t } = useTranslation("files");
  const hostsRef = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let disposed = false;
    let instances: { dispose(): void; resize(): void }[] = [];
    let observer: ResizeObserver | null = null;
    void (async () => {
      let echarts: typeof import("echarts");
      try {
        echarts = await import("echarts");
      } catch {
        return; // 加载失败:面板留空,不影响表格本体
      }
      if (disposed) return;
      const theme = themeVars();
      instances = charts.flatMap((chart, i) => {
        const host = hostsRef.current[i];
        if (!host) return [];
        const inst = echarts.init(host);
        inst.setOption(buildOption(chart.resolved, theme));
        return [inst];
      });
      // 面板/窗口尺寸变化时跟随重排。
      if (typeof ResizeObserver !== "undefined" && hostsRef.current[0]) {
        observer = new ResizeObserver(() => instances.forEach((c) => c.resize()));
        observer.observe(hostsRef.current[0]!.parentElement ?? hostsRef.current[0]!);
      }
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      instances.forEach((c) => c.dispose());
    };
  }, [charts]);

  return (
    <div className="pw-sheet-charts">
      <div className="pw-sheet-side-h">
        <span>{t("sheet.chartsTitle")}</span>
        <div className="spacer" />
        <button className="pw-icon-btn" title={t("sheet.closePanel")} onClick={onClose}>
          <Icon.X size={12} />
        </button>
      </div>
      <div className="pw-sheet-charts-list">
        {charts.map((chart, i) => (
          <div key={chart.rid} className="pw-sheet-chart-card">
            <div className="pw-sheet-chart-h">
              <span className="pw-sheet-chart-title" title={chart.resolved.title}>
                {chart.resolved.title || t("sheet.chartUntitled")}
              </span>
              {chart.origin === "user" ? <span className="pw-sheet-chart-tag is-user">{t("sheet.chartOriginUser")}</span> : null}
              {chart.resolved.sheetName ? <span className="pw-sheet-chart-tag">{chart.resolved.sheetName}</span> : null}
            </div>
            {chart.resolved.series.every((s) => s.values.length === 0) ? (
              <div className="pw-empty-hint">{t("sheet.chartNoData")}</div>
            ) : (
              <div
                className="pw-sheet-chart-host"
                ref={(el) => {
                  hostsRef.current[i] = el;
                }}
              />
            )}
            {chart.origin === "user" && (onRemove || onChangeKind) ? (
              <div className="pw-sheet-chart-actions">
                {onChangeKind ? (
                  <select
                    value={chart.kind}
                    onChange={(e) => onChangeKind(chart.rid, e.target.value as ChartKind)}
                    title={t("sheet.chartKindTitle")}
                  >
                    {KIND_OPTIONS.map((k) => (
                      <option key={k} value={k}>
                        {t(`sheet.kind.${k}`)}
                      </option>
                    ))}
                  </select>
                ) : null}
                <div className="spacer" />
                {onRemove ? (
                  <button className="pw-ftb-btn" title={t("sheet.chartDeleteTitle")} onClick={() => onRemove(chart.rid)}>
                    <Icon.X size={11} />
                    {t("sheet.chartDelete")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
