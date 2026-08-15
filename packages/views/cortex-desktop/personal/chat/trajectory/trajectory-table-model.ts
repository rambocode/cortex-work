// 台账行投影(复刻 deepseek-harness TrajectoryTable 的 flatten/filter/collapse/请求边界纯逻辑),
// 独立成文件供台账组件与详情面板共用,且可单测。
import {
  trajectoryRecordId,
  type TrajectoryCellProps,
  type TrajectoryRequestInfo,
  type TrajectoryTurnModel,
} from "./trajectory-model";

/** 台账一行(cell + 分组/轮边界标记与折叠摘要)。 */
export interface TableRecord {
  turn: number;
  section: number;
  group: string;
  groupStart: boolean;
  turnStart: boolean;
  cell: TrajectoryCellProps;
  turnEnd: boolean;
  collapsedSummary?: string;
  collapsedSummaryKind?: "turn" | "assistant";
}

/** 行状态:完成/在途/失败。 */
export type RecordState = "complete" | "running" | "error";

/** 请求检查器选中标识。 */
export interface SelectedRequest {
  turn: number;
  group: string;
}

/** 轮/组结构 → 平铺行列表(标注 groupStart/turnStart/turnEnd)。 */
export function flattenRecords(turns: TrajectoryTurnModel[]): TableRecord[] {
  return turns.flatMap((turn, section) => {
    let firstInSection = true;
    const records = turn.groups.flatMap((group) =>
      group.cells.map((cell, index) => {
        const turnStart = firstInSection;
        if (turnStart) firstInSection = false;
        return {
          turn: turn.turn,
          section,
          group: group.title,
          groupStart: index === 0,
          turnStart,
          cell,
          turnEnd: false,
        };
      }),
    );
    const last = records[records.length - 1];
    if (last !== undefined) last.turnEnd = true;
    return records;
  });
}

/** 搜索命中过滤:仅保留命中行并重算边界标记。 */
export function filterRecords(records: TableRecord[], matches: ReadonlySet<number>): TableRecord[] {
  const filtered = records
    .filter((record) => matches.has(record.cell.index))
    .map((record) => ({ ...record, groupStart: false, turnStart: false, turnEnd: false }));
  const startedSections = new Set<number>();
  for (const [index, record] of filtered.entries()) {
    const previous = filtered[index - 1];
    const next = filtered[index + 1];
    record.groupStart =
      previous === undefined || previous.section !== record.section || previous.group !== record.group;
    record.turnStart = !startedSections.has(record.section);
    if (record.turnStart) startedSections.add(record.section);
    record.turnEnd = next === undefined || next.section !== record.section;
  }
  return filtered;
}

/** `Step N` 组名 → 步号;非步组返回 undefined。 */
export function requestStep(group: string): number | undefined {
  if (!group.startsWith("Step ")) return undefined;
  const value = Number(group.slice("Step ".length));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** (turn, group) 请求键。 */
export function requestKey(turn: number, group: string): string {
  return `${turn}\u0000${group}`;
}

/** 每个 Step 组的首个内容行序号(请求边界圆点挂在该行上)。 */
export function indexRequestBoundaries(records: TableRecord[]): ReadonlyMap<string, number> {
  const boundaries = new Map<string, number>();
  for (const record of records) {
    const key = requestKey(record.turn, record.group);
    if (boundaries.has(key)) continue;
    if (requestStep(record.group) === undefined) continue;
    if (record.cell.kind === "user" || record.cell.kind === "context") continue;
    boundaries.set(key, record.cell.index);
  }
  return boundaries;
}

/** (turn, group) → 会话全局请求号。 */
export function indexRequestNumbers(requests: TrajectoryRequestInfo[]): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  for (const request of requests) numbers.set(requestKey(request.turn, request.group), request.number);
  return numbers;
}

/** 轮标签文案。 */
export function sectionLabel(turn: number): string {
  return `Turn ${turn}`;
}

// 折叠轮摘要:步数 + 工具调用数。
function summarizeTurn(records: TableRecord[]): string {
  const steps = new Set(records.map((record) => record.group).filter((group) => group.startsWith("Step "))).size;
  const toolCalls = records.filter((record) => record.cell.kind === "tool").length;
  return [`${steps} ${steps === 1 ? "step" : "steps"}`, `${toolCalls} tool ${toolCalls === 1 ? "call" : "calls"}`].join(
    " · ",
  );
}

/** 折叠轮:保留首内容行,其余并入一条省略摘要行。 */
export function collapseTurnRecords(records: TableRecord[], collapsedTurns: ReadonlySet<number>): TableRecord[] {
  const recordsByTurn = new Map<number, TableRecord[]>();
  for (const record of records) {
    const turnRecords = recordsByTurn.get(record.turn) ?? [];
    turnRecords.push(record);
    recordsByTurn.set(record.turn, turnRecords);
  }
  return records.flatMap((record) => {
    if (!collapsedTurns.has(record.turn)) return [record];
    const turnRecords = recordsByTurn.get(record.turn) ?? [record];
    if (turnRecords.length <= 1) return [record];
    if (record.cell.index !== turnRecords[0]?.cell.index) return [];
    return [
      { ...record, turnEnd: false },
      {
        ...record,
        groupStart: false,
        turnStart: false,
        turnEnd: true,
        collapsedSummary: summarizeTurn(turnRecords.slice(1)),
        collapsedSummaryKind: "turn" as const,
      },
    ];
  });
}

/** assistant 行之后连续的工具行(折叠/双击判定用)。 */
export function assistantToolCalls(records: TableRecord[], assistantIndex: number): TableRecord[] {
  const at = records.findIndex((record) => record.cell.index === assistantIndex);
  if (at === -1 || records[at]?.cell.kind !== "message") return [];
  const calls: TableRecord[] = [];
  for (let i = at + 1; i < records.length; i++) {
    const record = records[i];
    if (record === undefined || record.cell.kind !== "tool") break;
    calls.push(record);
  }
  return calls;
}

// 折叠 assistant 摘要:调用数 + 去重工具名。
function summarizeAssistantTools(records: TableRecord[]): string {
  const names = [...new Set(records.map((record) => record.cell.text).filter((name) => name !== ""))];
  const count = records.length;
  const summary = `${count} tool ${count === 1 ? "call" : "calls"}`;
  return names.length > 0 ? `${summary} · ${names.join(", ")}` : summary;
}

/** 折叠 assistant 名下工具调用为一条摘要行。 */
export function collapseAssistantRecords(
  records: TableRecord[],
  collapsedAssistants: ReadonlySet<string>,
): TableRecord[] {
  const out: TableRecord[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined) continue;
    out.push(record);
    if (record.cell.kind !== "message" || !collapsedAssistants.has(trajectoryRecordId(record.cell))) continue;
    const calls: TableRecord[] = [];
    for (let j = i + 1; j < records.length; j++) {
      const candidate = records[j];
      if (candidate === undefined || candidate.collapsedSummary !== undefined || candidate.cell.kind !== "tool") break;
      calls.push(candidate);
    }
    if (calls.length === 0) continue;
    const last = calls[calls.length - 1];
    out[out.length - 1] = { ...record, turnEnd: false };
    out.push({
      ...record,
      groupStart: false,
      turnStart: false,
      turnEnd: last?.turnEnd ?? false,
      collapsedSummary: summarizeAssistantTools(calls),
      collapsedSummaryKind: "assistant",
    });
    i += calls.length;
  }
  return out;
}

/** 行状态推导:错误 > 在途(工具无结果/末段生成中) > 完成。 */
export function stateOf(record: TableRecord, sessionRunning: boolean): RecordState {
  if (record.cell.isError) return "error";
  if (record.cell.kind === "tool" && record.cell.running) return "running";
  if (record.cell.kind === "message" && sessionRunning && record.cell.timeSeconds === null) return "running";
  return "complete";
}

/** 状态标签(详情面板)。 */
export function statusLabel(state: RecordState): string {
  if (state === "error") return "Failed";
  if (state === "running") return "Pending";
  return "Completed";
}

/** tool/subtool 行的展示文本拆分:名称 + 参数预览。 */
export interface ToolCallTextParts {
  name: string;
  args?: string;
}

/** tool 行列表文本:text 是名称,previewText 是参数预览。 */
export function toolCallTextParts(record: TableRecord): ToolCallTextParts | undefined {
  if (record.cell.kind !== "tool") return undefined;
  return {
    name: record.cell.text,
    ...(record.cell.previewText !== undefined && record.cell.previewText !== ""
      ? { args: record.cell.previewText }
      : {}),
  };
}

/** 非 tool 行的单行展示文本。 */
export function recordDisplayText(cell: TrajectoryCellProps): string {
  if (cell.previewText !== undefined && cell.previewText !== "") {
    return cell.text === "" ? cell.previewText : `${cell.text} · ${cell.previewText}`;
  }
  return cell.text;
}

/** tool 行结果预览文本(→ 之后的部分)。 */
export function recordResultText(cell: TrajectoryCellProps): string | undefined {
  if (cell.kind !== "tool") return undefined;
  return cell.resultPreviewText !== undefined ? cell.resultPreviewText : cell.result;
}
