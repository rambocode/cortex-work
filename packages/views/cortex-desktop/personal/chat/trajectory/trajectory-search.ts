// 台账实时搜索(复刻 deepseek-harness trajectory-search-index 的匹配语义,规模化简):
// 空白分词、全词 AND、大小写不敏感,命中返回记录序号集合;空查询返回 null(= 不过滤)。
// 本仓库事件流上限 1000 条,直接线性匹配即可,无需参照实现的增量索引与节流。
import { trajectoryPreviewText, type TrajectoryTurnModel } from "./trajectory-model";

// 单条记录的可搜索文本(轮位置 + 类型 + 各正文字段)。
function recordText(turn: number, group: string, cell: TrajectoryTurnModel["groups"][number]["cells"][number]): string {
  return [
    `turn ${turn}`,
    group,
    cell.kind,
    cell.kind === "message" ? "assistant" : "",
    cell.text,
    cell.previewText ?? "",
    cell.inputDetail ?? "",
    cell.outputDetail ?? "",
    cell.thinkingDetail ?? "",
    cell.result ?? "",
    cell.resultPreviewText ?? (cell.outputDetail ? trajectoryPreviewText(cell.outputDetail) : ""),
    cell.callId ?? "",
  ]
    .join("\n")
    .toLocaleLowerCase();
}

/**
 * 查询 → 命中记录序号集合;无查询词返回 null。
 */
export function trajectorySearchMatches(
  turns: TrajectoryTurnModel[],
  query: string,
): ReadonlySet<number> | null {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  const matches = new Set<number>();
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const cell of group.cells) {
        const text = recordText(turn.turn, group.title, cell);
        if (terms.every((term) => text.includes(term))) matches.add(cell.index);
      }
    }
  }
  return matches;
}
