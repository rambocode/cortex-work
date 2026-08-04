// 阶段3 深度定制:把「工具执行审批 hook / 自定义工具 / 自定义斜杠命令」渲染成 pi extension,
// 经 -e 加载。与 pi-providers.ts 的 provider extension **独立共存**（pi:open 各生成一个文件、
// buildRpcArgs 各加一个 -e;provider 注入逻辑不动）。
//
// 模板法与 pi-providers 一致:纯函数 renderXxx()（便于单测字符串结构）+ writeXxx() 落盘
// userData/pi-extensions/（mode 0600）。default export `function (pi)`,runtime 注入 pi,
// 文件零 import（spike 已证 registerTool 用普通 JSON 对象 parameters 即可,无需 typebox)。

import { app } from "electron";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// 默认需审批的工具（写/执行类高风险操作）。
export const DEFAULT_APPROVAL_TOOLS = ["bash", "write", "edit"];

// 审批 hook extension:拦 tool_call,对需审批工具经 ctx.ui.confirm() 弹窗,拒绝则 block。
// ctx.hasUI=false（如纯 json 模式）时放行——审批是 UI 能力,无 UI 不阻断正常运行。
export function renderApprovalExtension(tools: string[] = DEFAULT_APPROVAL_TOOLS): string {
  return [
    "// 由 Cortex Desktop 自动生成（工具执行审批 hook）,请勿手改。",
    `const NEEDS = new Set(${JSON.stringify(tools)});`,
    "export default function (pi) {",
    "  pi.on(\"tool_call\", async (event, ctx) => {",
    "    if (!NEEDS.has(event.toolName)) return;",
    "    if (!ctx.hasUI) return;",
    // 截断长度 600（原 200）:审批弹窗上用户看到的就是这段。像 create_calendar_event 这种参数
    // 里有长 notes 的工具,200 字很容易在用户看到起止时间之前就被截掉——那等于让人盲签。
    "    const detail = (() => { try { return JSON.stringify(event.input).slice(0, 600); } catch { return \"\"; } })();",
    "    const ok = await ctx.ui.confirm(\"允许执行工具 \" + event.toolName + \"?\", detail);",
    "    if (!ok) return { block: true, reason: \"用户拒绝执行\" };",
    "  });",
    "}",
    "",
  ].join("\n");
}

// 自定义工具样例:registerTool（普通 JSON 对象 parameters,spike 已证可用;execute 返回 content）。
export function renderCustomToolExtension(): string {
  return [
    "// 由 Cortex Desktop 自动生成（自定义工具样例 echo_upper）,请勿手改。",
    "export default function (pi) {",
    "  pi.registerTool({",
    "    name: \"echo_upper\",",
    "    description: \"把输入文本转成大写返回（Cortex 自定义工具样例）\",",
    "    parameters: { type: \"object\", properties: { text: { type: \"string\" } }, required: [\"text\"] },",
    "    async execute(toolCallId, params) {",
    "      const text = params && typeof params.text === \"string\" ? params.text : \"\";",
    "      return { content: [{ type: \"text\", text: text.toUpperCase() }], isError: false };",
    "    },",
    "  });",
    "}",
    "",
  ].join("\n");
}

// 自定义斜杠命令样例:registerCommand（handler 调 ctx.ui.notify;无回写需求）。
export function renderSlashCommandExtension(): string {
  return [
    "// 由 Cortex Desktop 自动生成（自定义斜杠命令样例 /greet）,请勿手改。",
    "export default function (pi) {",
    "  pi.registerCommand(\"greet\", {",
    "    description: \"打个招呼（Cortex 自定义命令样例）\",",
    "    handler: async (args, ctx) => {",
    "      if (ctx.ui && ctx.ui.notify) ctx.ui.notify(\"hello \" + (args || \"\"), \"info\");",
    "    },",
    "  });",
    "}",
    "",
  ].join("\n");
}

// askquestion 提问工具的 parameters schema（给 LLM）。纯 JSON（无函数）,经 JSON.stringify 嵌入源码。
const ASK_QUESTION_PARAMS = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      description: "一组或多组问题。每组最多 3 个选项;可标推荐项;可允许用户自定义输入。",
      items: {
        type: "object",
        properties: {
          header: { type: "string", description: "简短标签(可选)" },
          question: { type: "string", description: "问题文本" },
          options: {
            type: "array",
            description: "候选项,最多 3 个",
            items: {
              type: "object",
              properties: { label: { type: "string" }, description: { type: "string" } },
              required: ["label"],
            },
          },
          recommended: { type: "number", description: "推荐选项的下标(从 0 开始,可选)" },
          allowCustom: { type: "boolean", description: "是否允许用户填写自定义回答(可选)" },
        },
        required: ["question", "options"],
      },
    },
  },
  required: ["groups"],
};

// askquestion 自定义工具:execute 内把多组问题信封经 ctx.ui.input 的 title 借「sentinel + JSON」抛给
// host（U0 实测 input.title 原样承载长 JSON 零截断;不在 session 生命周期 hook 调,避免死锁）,await
// 用户答案(value)/取消(undefined),return 含「逐组 问/答」的人类可读 result。sentinel 为每会话高熵
// token（由 pi:open 注入,防 LLM 在裸 input 的 title 里伪造）。零 import（普通对象 parameters,无 typebox）。
export function renderAskQuestionExtension(sentinel: string): string {
  return [
    "// 由 Cortex Desktop 自动生成（askquestion 提问工具）,请勿手改。",
    `const SENTINEL = ${JSON.stringify(sentinel)};`,
    `const PARAMS = ${JSON.stringify(ASK_QUESTION_PARAMS)};`,
    "function buildGroups(raw) {",
    "  const out = [];",
    "  for (let i = 0; i < raw.length; i++) {",
    "    const g = raw[i] || {};",
    "    const rawOpts = Array.isArray(g.options) ? g.options.slice(0, 3) : [];",
    "    const options = rawOpts.map((o) => {",
    "      const opt = { label: String(o && o.label != null ? o.label : o) };",
    "      if (o && o.description != null) opt.description = String(o.description);",
    "      return opt;",
    "    });",
    '    let recommended = typeof g.recommended === "number" ? g.recommended : undefined;',
    "    if (recommended != null && (recommended < 0 || recommended >= options.length)) recommended = undefined;",
    '    const group = { id: "g" + i, question: String(g.question != null ? g.question : ""), options: options, allowCustom: !!g.allowCustom };',
    "    if (g.header != null) group.header = String(g.header);",
    "    if (recommended != null) group.recommended = recommended;",
    "    out.push(group);",
    "  }",
    "  return out;",
    "}",
    "export default function (pi) {",
    "  pi.registerTool({",
    '    name: "askquestion",',
    '    description: "在确实需要用户做出选择或澄清时,向用户弹出一组或多组问题(每组最多 3 个选项,可标推荐项,可允许自定义输入)。仅在存在真实歧义、必须由用户裁决时调用;能自行决定的事项不要调用。",',
    "    parameters: PARAMS,",
    "    async execute(toolCallId, params, signal, onUpdate, ctx) {",
    "      const raw = params && Array.isArray(params.groups) ? params.groups : [];",
    '      if (!raw.length) return { content: [{ type: "text", text: "askquestion 调用未提供任何问题组。" }], isError: true };',
    // 与 host sanitizeAskQuestionEnvelope 的 ASKQ_MAX_GROUPS 对称:超限直接给 LLM 可纠偏的 isError 反馈,
    // 而非交给 host 拒绝后退化成笼统的「用户取消」(agent 据此可能重试同样过大的调用)。
    '      if (raw.length > 12) return { content: [{ type: "text", text: "问题组过多(最多 12 组),请精简后重试。" }], isError: true };',
    "      const groups = buildGroups(raw);",
    "      let value;",
    "      try { value = await ctx.ui.input(SENTINEL + JSON.stringify({ groups: groups })); }",
    '      catch (e) { return { content: [{ type: "text", text: "提问过程出错: " + String(e) }], isError: true }; }',
    '      if (value === undefined || value === null) return { content: [{ type: "text", text: "用户取消了提问,未作选择。" }], isError: false };',
    "      let parsed;",
    '      try { parsed = JSON.parse(value); } catch (e) { return { content: [{ type: "text", text: "无法解析用户的回答。" }], isError: true }; }',
    "      const answers = parsed && Array.isArray(parsed.answers) ? parsed.answers : [];",
    "      const qById = {};",
    "      for (const g of groups) qById[g.id] = g.question;",
    '      const lines = answers.map((a) => "问: " + (qById[a && a.groupId] || (a && a.groupId) || "?") + "\\n答: " + String(a && a.value != null ? a.value : "") + (a && a.isCustom ? "（自定义）" : ""));',
    '      const text = lines.length ? "用户回答如下:\\n" + lines.join("\\n\\n") : "用户未提供有效回答。";',
    '      return { content: [{ type: "text", text: text }], isError: false };',
    "    },",
    "  });",
    "}",
    "",
  ].join("\n");
}

// 任务清单工具名:extension 注册名与 pi.ts / pi-rpc.ts adapter 特判同源,单一出处防漂移。
export const TODO_TOOL_NAME = "todo_write";

// todo_write 的 parameters schema(给 LLM)。整表覆盖语义:每次调用传完整清单,对齐 claude TodoWrite。
const TODO_WRITE_PARAMS = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "完整任务清单(整表覆盖上一次调用的清单)",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "任务内容(简短祈使句)" },
          status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "任务状态" },
        },
        required: ["text", "status"],
      },
    },
  },
  required: ["todos"],
};

// 任务清单工具 extension:pi 无原生 TodoWrite,注册 todo_write 补齐。execute 无状态——
// 清单不存 pi 侧,host 从 tool_execution_start.args 直接取整表快照(见 pi.ts / pi-rpc.ts 特判),
// 这里只回一句确认文本给 LLM。复杂度判断交给模型(description 约束「复杂多步任务才用」)。
export function renderTodoExtension(): string {
  return [
    "// 由 Cortex Desktop 自动生成（任务清单工具 todo_write,对齐 claude TodoWrite 语义）,请勿手改。",
    `const PARAMS = ${JSON.stringify(TODO_WRITE_PARAMS)};`,
    "export default function (pi) {",
    "  pi.registerTool({",
    `    name: ${JSON.stringify(TODO_TOOL_NAME)},`,
    '    description: "维护当前任务的任务清单。仅在复杂多步任务(3 步以上)时使用:开工前列出计划,每完成一步立即再次调用更新状态;每次调用必须传完整清单(整表覆盖),同一时刻至多一项 in_progress。简单任务不要使用本工具。",',
    '    promptSnippet: "todo_write - 复杂多步任务时创建并维护任务清单(整表覆盖)",',
    "    parameters: PARAMS,",
    "    async execute(toolCallId, params) {",
    "      const todos = params && Array.isArray(params.todos) ? params.todos : [];",
    '      const done = todos.filter((t) => t && t.status === "completed").length;',
    '      return { content: [{ type: "text", text: "任务清单已更新(" + done + "/" + todos.length + " 项完成)" }], isError: false };',
    "    },",
    "  });",
    "}",
    "",
  ].join("\n");
}

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

// 落盘 extension 文件,返回绝对路径。固定文件名（无 per-instance 状态,每次 open 覆盖重写）。
function writeExtension(name: string, content: string): string {
  const dir = join(app.getPath("userData"), "pi-extensions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.js`);
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

export function writeApprovalExtension(tools?: string[]): string {
  return writeExtension("approval", renderApprovalExtension(tools));
}

export function writeCustomToolExtension(): string {
  return writeExtension("sample-tools", renderCustomToolExtension());
}

export function writeSlashCommandExtension(): string {
  return writeExtension("sample-commands", renderSlashCommandExtension());
}

// askquestion 工具 extension（常驻;sentinel 每会话高熵,由 pi:open 生成传入）。
export function writeAskQuestionExtension(sentinel: string): string {
  return writeExtension("askquestion", renderAskQuestionExtension(sentinel));
}

// 任务清单工具 extension（常驻,RPC 与单发两条路径都加载）。
export function writeTodoExtension(): string {
  return writeExtension("todo", renderTodoExtension());
}
