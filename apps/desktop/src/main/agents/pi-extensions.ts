// pi 扩展能力的共享常量与归一化纯函数。
//
// 历史：本文件曾把「审批 hook / todo / askquestion / 样例工具与命令」渲染成 .js extension
// 落盘 `userData/pi-extensions/` 再经二进制的 `-e` 加载。binary 路径删除后，这些能力全部由
// `pi-inproc/native-hooks.ts` 以原生对象（ToolDefinition / InlineExtension）注入，
// 渲染与落盘生成器一并删除。此处只保留仍被多方消费的三样：
//   · `DEFAULT_APPROVAL_TOOLS` —— 审批集缺省值（native-hooks 兜底用）；
//   · `TODO_TOOL_NAME`         —— todo_write 工具名（native-hooks 注册名与 pi.ts /
//                                  pi-inproc/rpc-shared.ts 的事件特判必须同源，单一出处防漂移）；
//   · `normalizePiTodos`       —— todo 整表快照归一化（adapter 特判与 native-hooks 计数共用）。

// 默认需审批的工具（写/执行类高风险操作）。
export const DEFAULT_APPROVAL_TOOLS = ["bash", "write", "edit"];

// 任务清单工具名:native-hooks 注册名与 pi.ts / rpc-shared.ts adapter 特判同源,单一出处防漂移。
export const TODO_TOOL_NAME = "todo_write";

// todo_write 调用参数归一化(host 侧):tool_execution_start.args.todos → todo 事件整表快照。
// 非法项跳过,未知状态回退 pending;与 claude/codex adapter 的归一化形状一致。
export function normalizePiTodos(args: unknown): Array<{ text: string; status: "pending" | "in_progress" | "completed" }> {
  const todos = (args as Record<string, unknown> | null | undefined)?.todos;
  if (!Array.isArray(todos)) return [];
  const out: Array<{ text: string; status: "pending" | "in_progress" | "completed" }> = [];
  for (const t of todos) {
    if (!t || typeof t !== "object") continue;
    const item = t as Record<string, unknown>;
    if (typeof item.text !== "string" || !item.text) continue;
    const status = item.status === "in_progress" || item.status === "completed" ? item.status : "pending";
    out.push({ text: item.text, status });
  }
  return out;
}
