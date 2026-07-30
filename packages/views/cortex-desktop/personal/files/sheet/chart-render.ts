// echarts 渲染共用层:option 构建(侧栏面板与网格浮动图片共用)+ 离屏渲染成 PNG dataURL
// (把图表按 Excel 原锚点以浮动图片插回网格用)。echarts 只在函数内动态 import(重依赖懒加载)。
// 配色:源文件指定的系列色优先(作者意图);缺省回退经 CVD 校验的分类色序(dataviz 调色板 light 序)。
import type { ResolvedChart } from "./chart-io";

// 回退分类色序(相邻对 CVD ΔE≥8 已验证;顺序固定,不可循环重排)。
export const FALLBACK_PALETTE = ["#2a78d6", "#008300", "#e87ba4", "#eda100", "#1baf7a", "#eb6834", "#4a3aa7", "#e34948"];

export interface ChartTheme {
  text: string;
  grid: string;
}

// 读应用主题 token 给 echarts 文本/网格用(echarts 不认 CSS 变量,需取计算值)。
export function themeVars(): ChartTheme {
  const style = getComputedStyle(document.documentElement);
  return {
    text: style.getPropertyValue("--text-2").trim() || "#6b6355",
    grid: style.getPropertyValue("--border-soft").trim() || "#e6ddcc",
  };
}

// 离屏图片走固定浅色主题(图片底是白色,与应用主题无关,观感对齐 Excel 图表区)。
export const IMAGE_THEME: ChartTheme = { text: "#555555", grid: "#dddddd" };

export type EChartsOption = Record<string, unknown>;

// ResolvedChart → echarts option。单轴、多系列带图例、悬浮 tooltip;
// bar/hbar/line/area 走类目轴,pie/doughnut 取首系列,scatter 类目值配对。
// withTitle:把标题画进图里(浮动图片没有卡片头;侧栏卡片自带标题行则传 false)。
export function buildOption(chart: ResolvedChart, theme: ChartTheme, withTitle = false): EChartsOption {
  const colorOf = (i: number) => chart.series[i]?.color ?? FALLBACK_PALETTE[i % FALLBACK_PALETTE.length];
  const axisCommon = {
    axisLabel: { color: theme.text, fontSize: 10 },
    axisLine: { lineStyle: { color: theme.grid } },
    splitLine: { lineStyle: { color: theme.grid } },
  };
  const gridTop = withTitle && chart.title ? 34 : 10;
  const base: EChartsOption = {
    animation: false,
    tooltip: { trigger: chart.kind === "pie" || chart.kind === "doughnut" ? "item" : "axis", confine: true },
    title:
      withTitle && chart.title
        ? { text: chart.title, left: "center", top: 6, textStyle: { fontSize: 12, color: "#333333", fontWeight: 600 } }
        : undefined,
    legend:
      chart.series.length > 1
        ? { bottom: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: theme.text, fontSize: 10 } }
        : undefined,
    grid: { left: 8, right: 12, top: gridTop, bottom: chart.series.length > 1 ? 28 : 8, containLabel: true },
  };

  if (chart.kind === "pie" || chart.kind === "doughnut") {
    const s = chart.series[0];
    return {
      ...base,
      series: [
        {
          type: "pie",
          radius: chart.kind === "doughnut" ? ["40%", "70%"] : "70%",
          label: { color: theme.text, fontSize: 10 },
          data: chart.categories.map((c, i) => ({
            name: String(c),
            value: s?.values[i] ?? 0,
            itemStyle: { color: FALLBACK_PALETTE[i % FALLBACK_PALETTE.length] },
          })),
        },
      ],
    };
  }

  if (chart.kind === "scatter") {
    return {
      ...base,
      xAxis: { type: "value", ...axisCommon },
      yAxis: { type: "value", ...axisCommon },
      series: chart.series.map((s, i) => ({
        type: "scatter",
        name: s.name,
        symbolSize: 8,
        itemStyle: { color: colorOf(i) },
        data: s.values.map((v, j) => [Number(chart.categories[j] ?? j), v]),
      })),
    };
  }

  const catAxis = { type: "category", data: chart.categories.map(String), ...axisCommon };
  const valAxis = { type: "value", ...axisCommon };
  return {
    ...base,
    xAxis: chart.kind === "hbar" ? valAxis : catAxis,
    yAxis: chart.kind === "hbar" ? catAxis : valAxis,
    series: chart.series.map((s, i) => ({
      type: chart.kind === "line" || chart.kind === "area" ? "line" : "bar",
      name: s.name,
      data: s.values,
      itemStyle: { color: colorOf(i) },
      lineStyle: { width: 2 },
      symbolSize: 6,
      barMaxWidth: 26,
      ...(chart.kind === "area" ? { areaStyle: { opacity: 0.25 } } : {}),
    })),
  };
}

// 离屏渲染成 PNG dataURL(2x 像素密度,白底)。失败返回 null,调用方静默跳过。
export async function renderChartToDataUrl(chart: ResolvedChart, width: number, height: number): Promise<string | null> {
  let echarts: typeof import("echarts");
  try {
    echarts = await import("echarts");
  } catch {
    return null;
  }
  const host = document.createElement("div");
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  try {
    // detached 节点无布局尺寸,init 必须显式传宽高。
    const inst = echarts.init(host, null, { width, height });
    inst.setOption({ ...buildOption(chart, IMAGE_THEME, true), backgroundColor: "#ffffff" });
    const url = inst.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#ffffff" });
    inst.dispose();
    return url;
  } catch {
    return null;
  }
}
