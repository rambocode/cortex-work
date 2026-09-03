// Trajectory 数据模型与格式化(复刻 deepseek-harness ui-trajectory 的 record/format 契约):
// 单元格(cell)= 台账一行;组(group)= Message / Step N;轮(turn)= 一次 run。
// 数据源是本仓库的 RunEvent 流(见 trajectory-layout.ts),字段裁剪到本仓库实际可得的子集。

/** 台账行类型(参照 multica trajectory 的 kind 闭集,裁剪掉本仓库不存在的 system/compacted/subtool)。 */
export type TrajectoryCellKind = "user" | "context" | "message" | "tool";

/** 一条台账记录的数据与展示字段。 */
export interface TrajectoryCellProps {
  /** 1-based 全局序号(#N 与时间线索引共用)。 */
  index: number;
  /** 稳定身份(跨重建保持选中/折叠);tool 行优先 callId。 */
  recordId: string;
  kind: TrajectoryCellKind;
  /** 非 Markdown 摘要前缀(tool 名等);溢出走 CSS 省略。 */
  text: string;
  /** 已展平的单行预览正文(Markdown 源在消费端截断展平)。 */
  previewText?: string;
  /** 详情面板完整输入(用户消息正文 / tool 入参 JSON)。 */
  inputDetail?: string;
  /** 详情面板完整输出(assistant 正文 / tool 输出)。 */
  outputDetail?: string;
  /** assistant 思考全文。 */
  thinkingDetail?: string;
  /** tool 行结果摘要(有预览时为空串)。 */
  result?: string;
  /** tool 行结果单行预览。 */
  resultPreviewText?: string;
  /** tool 调用 id(结果配对/跳转)。 */
  callId?: string;
  isError?: boolean;
  /**
   * 「已恢复」的失败:tool 行 isError 为真,但同一轮后续又有同名 tool 调用成功落地
   * (典型是模型探路失败后立刻换姿势重试成功)。语义上仍是失败,只是不应再按「未处理的错误」
   * 标红;轮末 result 失败补的 Error 行与被判 interrupted 的行永远不会置此标记。
   * 由 trajectory-layout 收尾阶段回填,消费端(表格/时间线/详情)据此降为琥珀色。
   */
  recovered?: boolean;
  /** tool 调用仍在途(无结果帧)。 */
  running?: boolean;
  /** 自身耗时秒;未知为 null(渲染 —)。 */
  timeSeconds: number | null;
  /** epoch 毫秒开始时间;未知 null。 */
  startedAt?: number | null;
  /** message 行 usage(input/cacheRead/output tokens)。 */
  input?: number;
  cacheRead?: number;
  output?: number;
  /** 该 user 行开启新一轮。 */
  opensTurn?: boolean;
}

/** 一轮内的 Message / Step 组。 */
export interface TrajectoryGroupModel {
  title: string;
  cells: TrajectoryCellProps[];
}

/** 一个可粘性折叠的轮。 */
export interface TrajectoryTurnModel {
  turn: number;
  runId: string;
  groups: TrajectoryGroupModel[];
}

/** 一次模型请求(= 一个 Step)的检查器信息。 */
export interface TrajectoryRequestInfo {
  turn: number;
  step: number;
  group: string;
  number: number;
  status: "complete" | "running" | "error";
  startedAt?: number;
  completedAt?: number | null;
  error?: string;
  /** 本步观察到的重试次数。 */
  retries?: number;
  usage?: TrajectoryUsage;
  cumulativeUsage?: TrajectoryUsage;
  costUsd?: number;
}

/** provider token 分桶(与参照实现同名字段,cacheWrite/reasoning 本仓库拿不到故省略)。 */
export interface TrajectoryUsage {
  input?: number;
  cacheRead?: number;
  output?: number;
}

/**
 * 行稳定身份:优先显式 recordId,tool 行退 callId。
 * 与参照实现 trajectoryRecordId 同语义,保证折叠/选中跨数据重建存活。
 */
export function trajectoryRecordId(cell: TrajectoryCellProps): string {
  if (cell.recordId !== "") return cell.recordId;
  if (cell.callId !== undefined) return `${cell.kind}\u0000call\u0000${cell.callId}`;
  return `${cell.kind}\u0000index\u0000${cell.index}`;
}

/** 毫秒时长 → 千分位整数毫秒标签;未知渲染 em dash(参照实现同款)。 */
export function formatDurationMillis(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  const integer = String(Math.round(milliseconds));
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ms`;
}

/** 秒时长 → 毫秒标签。 */
export function formatElapsedSeconds(seconds: number | null): string {
  return formatDurationMillis(seconds === null ? null : seconds * 1000);
}

/** 短毫秒时长(重试延迟/请求耗时):<1s 用 ms,否则秒一位小数。 */
export function formatDurationMs(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

/** epoch 毫秒 → `YYYY-MM-DD HH:mm:ss.SSS` 本地时间;未知返回 null 由调用方兜底文案。 */
export function formatStartedAt(timestamp: number | null | undefined): string | null {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const two = (value: number) => String(value).padStart(2, "0");
  const three = (value: number) => String(value).padStart(3, "0");
  const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`;
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  return `${day} ${time}`;
}

const PREVIEW_SOURCE_CHARACTERS = 2_048;
const PREVIEW_OUTPUT_CHARACTERS = 512;

// 轻量 Markdown 展平:去围栏/标题/强调/链接壳,折叠空白。参照实现走完整 Markdown 解析器,
// 此处预览只需要「一行可读文本」,正则足够且零依赖。
function stripMarkdown(source: string): string {
  return source
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/^\s*[-+>]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 有界单行预览(参照 trajectoryPreviewText):源截 2048 字符再展平,输出截 512,
 * 任一侧截断补省略号。
 */
export function trajectoryPreviewText(text: string): string {
  const source = text.slice(0, PREVIEW_SOURCE_CHARACTERS);
  const compact = stripMarkdown(source);
  const preview = compact.slice(0, PREVIEW_OUTPUT_CHARACTERS).trimEnd();
  return source.length < text.length || preview.length < compact.length ? `${preview}…` : preview;
}

/** unknown 入参 → 可读 JSON 文本(详情面板/预览共用)。 */
export function jsonDetail(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}
