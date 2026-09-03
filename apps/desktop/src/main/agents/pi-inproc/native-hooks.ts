// pi in-process 引擎的「原生能力注入」层：把 `pi-extensions.ts` 里那五段**渲染成 .js 文件再经 `-e`
// 加载**的字符串模板，换成主进程内直接构造的原生对象（迁移计划 U3 第 1 项 / R4）。
//
// ── 它替换了什么 ──────────────────────────────────────────────────────────────────────
// | 旧（pi-extensions.ts）          | 新（本文件）                                        |
// |---------------------------------|-----------------------------------------------------|
// | `renderApprovalExtension()`     | `createApprovalExtension()` → InlineExtension        |
// | `renderTodoExtension()`         | `createTodoTool()`        → ToolDefinition           |
// | `renderAskQuestionExtension()`  | `createAskQuestionTool()` → ToolDefinition           |
// | `renderCustomToolExtension()`   | `createSampleEchoTool()`  → ToolDefinition           |
// | `renderSlashCommandExtension()` | `createSampleCommandExtension()` → InlineExtension   |
//
// 产物按注入点分两堆，正好对应 `session.ts` 的 `PiInProcDeps`：
//   · 工具（`registerTool` 的等价物）→ `customTools`（`createAgentSessionFromServices({customTools})`）
//   · 事件 hook 与斜杠命令        → `extensionFactories`（`resourceLoaderOptions.extensionFactories`）
// 集成阶段只需 `const { customTools, extensionFactories } = createPiNativeHooks(...)` 再塞进 deps。
// （`PiInProcDeps` 还有一个并存的 `additionalExtensionPaths` —— 那是 `~/.pi` 下的磁盘 extension 包，
//  如 Computer Use 的 `pi-computer-use`。本文件不产出它，但审批 hook 必须能拦到它注册的工具，
//  见 `createApprovalExtension()` 上「挂法不可改」那段。）
//
// ── 收益（为什么值得换）────────────────────────────────────────────────────────────────
// 旧路径把这些逻辑以**源码字符串**落到 `userData/pi-extensions/*.js`（mode 0600）再交给 pi 加载：
// 没有类型检查、没有单步调试、每次 open 都要落盘、`-a` 还得整批信任。换成原生对象后，签名漂移
// 变成 TS 编译错误，落盘面消失，信任门连同它一起消失。
//
// ── 参数 schema 为什么是「裸 JSON 对象 + cast」而不是 TypeBox ─────────────────────────
// `ToolDefinition.parameters` 的类型是 typebox 的 `TSchema`，但 `typebox` 是**纯 ESM** 包，
// 且不是 apps/desktop 的直接依赖。为它引一条 KTD1 式的动态 import（或加一个 phantom dependency）
// 完全不划算 —— pi-ai 的 `validateToolArguments()` 里有一条**显式**的非 TypeBox 分支：
// 当 schema 上没有 `TYPEBOX_KIND` symbol 时走 `coerceWithJsonSchema()`，即裸 JSON Schema 是
// 上游支持的用法（旧的 .js extension 一直就是这么写的，spike 也验过）。故这里保持裸对象 + 一次
// 集中 cast（`asToolSchema`），把打包与依赖风险降到零。
//
// ── 错误信号：0.82.1 只认「抛异常」──────────────────────────────────────────────────
// `AgentToolResult` 在 0.82.1 **没有** `isError` 字段：agent-loop 的 `executePreparedToolCall`
// 固定返回 `{result, isError:false}`，只有 `execute()` 抛出时才走 `createErrorToolResult()` 并置
// `isError:true`。也就是说旧模板里那些 `return {..., isError: true}` 被运行时**静默丢弃**了 ——
// 正是本次迁移要消灭的一类「字符串模板写了但没人执行」的隐性 bug。本文件的错误分支一律 `throw`，
// 文案与旧模板逐字一致，模型看到的文本不变，但错误标记这次是真的生效了。

import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { DEFAULT_APPROVAL_TOOLS, TODO_TOOL_NAME, normalizePiTodos } from "../pi-extensions";
import { recordAgentTrace } from "../../ipc/agent-trace";
import { createLogger } from "../../log";
import { createToolContextExtension, type ToolContextProjectionReport } from "./tool-context";
import { createToolFailureHintExtension } from "./tool-failure-hints";

const log = createLogger("pi-inproc-hooks");

// ── 常量 ──────────────────────────────────────────────────────────────────────────────

/**
 * 审批弹窗 detail 的截断长度。**保持 600**（历史上从 200 提上来的）：
 * 像 `create_calendar_event` 这种参数里带长 notes 的工具，200 字会在用户看到起止时间之前就截断，
 * 那等于让人盲签。改小这个数是安全回退，不要「顺手优化」。
 */
export const APPROVAL_DETAIL_MAX_CHARS = 600;

/** askquestion 工具名。与旧模板、`ui-context.ts` 的归一化目标 `method:"askquestion"` 同源。 */
export const ASK_QUESTION_TOOL_NAME = "askquestion";

/**
 * askquestion 单次调用的问题组上限。与 `pi-rpc.ts` 的 `ASKQ_MAX_GROUPS`（host 侧 sanitize）
 * 对称：超限就地给模型一个可纠偏的错误，而不是交给 host 拒绝后退化成笼统的「用户取消」
 *（agent 据此可能带着同样过大的入参重试）。那个常量是模块私有的，故这里保留一份副本；
 * 两处必须同时改，改一处等于把纠偏反馈变回「用户取消」。
 */
export const ASK_QUESTION_MAX_GROUPS = 12;

/** askquestion 每组选项上限（同上，与 host 的 `ASKQ_MAX_OPTIONS` 对称）。 */
export const ASK_QUESTION_MAX_OPTIONS = 3;

/** 样例自定义工具 / 斜杠命令的名字（与旧模板一致，仅供设置页的「样例」开关使用）。 */
export const SAMPLE_TOOL_NAME = "echo_upper";
export const SAMPLE_COMMAND_NAME = "greet";

// 便于集成侧只 import 本文件即可拿齐审批相关符号（判定侧仍在 core/personal/permissionMode.ts）。
export { DEFAULT_APPROVAL_TOOLS, TODO_TOOL_NAME };

// ── 通用小工具 ────────────────────────────────────────────────────────────────────────

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 裸 JSON Schema → pi 的 `TSchema`（理由见文件头）。
 *
 * 类型侧零成本：typebox 1.x 的 `TSchema` 就是个空接口 `interface TSchema {}`，任何对象都能赋值，
 * 因此这里不需要 `as` 断言。用 `ToolDefinition["parameters"]` 取类型而不是
 * `import type { TSchema } from "typebox"`：后者会给 apps/desktop 添一个未声明的 phantom 依赖。
 * 保留这个函数是为了让「schema 是裸 JSON、不是 TypeBox 构造出来的」这件事有一个显式的、带注释的落点。
 */
function asToolSchema(schema: Record<string, unknown>): ToolDefinition["parameters"] {
  return schema;
}

/** 单条文本结果。pi 0.82.1 的 `AgentToolResult` 要求 `details` 存在（可为 undefined）。 */
function textResult(text: string): { content: [{ type: "text"; text: string }]; details: undefined } {
  return { content: [{ type: "text", text }], details: undefined };
}

// ── 1. 审批 hook（对应 renderApprovalExtension）────────────────────────────────────────

/** 一次审批判定的留痕记录。 */
export interface PiApprovalRecord {
  /** 被审批的工具名。 */
  toolName: string;
  /** 弹窗上展示的入参摘要（已按 `APPROVAL_DETAIL_MAX_CHARS` 截断）。 */
  detail: string;
  /**
   * · `approved` 用户点了允许
   * · `denied`   用户拒绝 → 已 block
   * · `skipped`  **没有 UI 出口，按旧路径语义放行**（见 `PiApprovalHookOptions.hasUiOutlet`）
   * · `failed`   审批流程本身异常 → 已 block（fail-closed）
   */
  decision: "approved" | "denied" | "skipped" | "failed";
  /** skipped / failed 的原因，便于事后定位。 */
  reason?: string;
}

export interface PiApprovalHookOptions {
  /**
   * 需审批的工具集。**语义与旧模板逐字一致**：
   * · `undefined` → 用 `DEFAULT_APPROVAL_TOOLS`（bash/write/edit）
   * · `[]`        → 空集，任何工具都不审批（`permissionMode.ts` 的注释依赖这条：
   *                 「空集经 pi-extensions 会放行全部工具」，故它才要兜底塞 write/edit/bash）
   * 集合内容由 `packages/core/personal/permissionMode.ts` 的 `derivePiCapabilities()` 决定，
   * 本层**只执行不判定** —— 包括「`gui_*` 写工具在自动执行档仍强制进审批集」那条红线：
   * 它体现为 approvalTools 里出现 `gui_click` 等名字，本层照单命中即可，不做任何过滤或豁免。
   */
  tools?: string[];
  /**
   * 【安全关键】当前是否真的有一条能走到用户眼前的 UI 出口。**必填，强制集成侧显式表态。**
   *
   * 为什么不能直接用 `ctx.hasUI`：pi 的 `hasUI()` 实现是「`uiContext !== noOpUIContext`」，
   * 而 `session.ts` 的 `rebind()` **无条件**把 `uiBridge.context` 传给 `bindExtensions()`，
   * 于是 in-process 下 `ctx.hasUI` **恒为 true**，哪怕这一路（U5 单发）根本没有 `onUiRequest`。
   * 而 `ui-context.ts` 的 `dialog()` 在缺 `onUiRequest` 时立刻按 defaultValue 结算，`confirm`
   * 的 defaultValue 是 `false` —— 直接照抄旧模板的 `if (!ctx.hasUI) return;` 会让单发路径从
   * 「全部放行」翻转成「全部 block」，无人值守的自动化会静默停摆。
   *
   * 旧路径的等价事实：`--mode json` 单发压根不加载审批 extension（`ipc/cli.ts` 只推 todo），
   * 且即便加载了，pi 在无 uiContext 时 `ctx.hasUI` 为 false → `return` → 放行。
   * 所以「无 UI 出口 = 放行」才是与旧路径一致的语义，本层照此实现。
   *
   * 但「放行」不等于「静默」：这条路径**必定**产出一条 `decision:"skipped"` 的留痕
   *（默认 sink 写 warn 日志 + agent trace），保证事后可查到「哪个工具在无人值守下被免审执行」。
   *
   * 集成侧接线：聊天 RPC 路径传 `() => true`（有 `onUiRequest`），单发/编排无审批 UI 的路径
   * 传 `() => false`。判据与 `PiInProcOpenOptions.onUiRequest` 是否存在保持一致。
   */
  hasUiOutlet: () => boolean;
  /** 留痕出口。缺省写 warn/info 日志 + `recordAgentTrace`（scope=pi, phase=approval）。 */
  onDecision?: (record: PiApprovalRecord) => void;
  /** 会话 id，仅用于留痕定位。 */
  uiSessionId?: string;
}

/** 入参摘要。不可序列化（含循环引用 / undefined）时退化为空串，**绝不抛**（与旧模板同）。 */
function approvalDetail(input: unknown): string {
  try {
    return JSON.stringify(input).slice(0, APPROVAL_DETAIL_MAX_CHARS);
  } catch {
    return "";
  }
}

/** 默认留痕：日志 + agent trace。trace 只在审批集命中时产生，频次低，不会淹没 trace 缓冲。 */
function defaultRecordApproval(record: PiApprovalRecord, uiSessionId?: string): void {
  const detail = { tool: record.toolName, decision: record.decision, reason: record.reason };
  if (record.decision === "skipped" || record.decision === "failed") log.warn("pi 工具审批", detail);
  else log.info("pi 工具审批", detail);
  recordAgentTrace({
    scope: "pi",
    phase: "approval",
    summary: `pi 工具审批：${record.toolName} → ${record.decision}`,
    agent: "pi",
    ...(uiSessionId ? { sessionId: uiSessionId } : {}),
    data: { tool: record.toolName, decision: record.decision, detail: record.detail, reason: record.reason },
  });
}

/**
 * 判定本次是否能真的弹窗。两个条件取**与**：pi 自己认为有 UI，且集成侧确认有出口。
 * `hasUiOutlet()` 抛错视为「没有出口」——它是集成侧注入的谓词，抛错说明状态未知，
 * 此时按旧路径语义放行（并留痕），而不是把用户的正常操作 block 掉。
 */
function canPromptForApproval(
  ctx: Pick<ExtensionContext, "hasUI">,
  hasUiOutlet: () => boolean,
): { ok: true } | { ok: false; reason: string } {
  if (ctx.hasUI === false) return { ok: false, reason: "pi 上下文无 UI（hasUI=false）" };
  try {
    return hasUiOutlet() ? { ok: true } : { ok: false, reason: "无 UI 出口（单发/无审批 UI 路径）" };
  } catch (err) {
    return { ok: false, reason: `UI 出口判定异常：${errText(err)}` };
  }
}

/**
 * 工具执行审批 hook。拦 `tool_call`，命中审批集的工具经 `ctx.ui.confirm()` 逐次确认，拒绝则 block。
 *
 * ⚠️【挂法不可改】它必须是 **extension 级的 `pi.on("tool_call", …)` 事件处理器**，
 * 绝不能退化成「只包住自家 `customTools` 的 execute wrapper」。
 *
 * 理由是审批集里最要命的那批工具**根本不是我们注册的**：`gui_*`（Computer Use 写工具）来自
 * 装在 `~/.pi` 的第三方包 `pi-computer-use`，经 `PiInProcDeps.additionalExtensionPaths` 以
 * **磁盘 extension** 形态加载。wrapper 方案物理上拦不到它们，而且**不会有任何报错**——
 * 审批闸静默消失，`gui_click` 在「自动执行」档直接操作用户电脑。这是本次迁移最危险的失败模式。
 *
 * 事件挂法为什么一定拦得到（已核 0.82.1 源码）：
 *   `AgentSession._installAgentToolHooks()` 把 `agent.beforeToolCall` 装在 Agent 上**一次**，
 *   对每一次工具调用生效，与该工具由谁注册无关；它转发给 `ExtensionRunner.emitToolCall()`，
 *   后者遍历**同一个 runner 内全部 extension** 的 `tool_call` 处理器，任一返回 `{block:true}`
 *   立即短路。磁盘 extension 与本文件的 inline factory 进的是同一个 runner
 *  （`DefaultResourceLoader.loadFinalExtensionSet()` 先按路径加载拿到 runtime，再用同一个
 *   runtime 加载 `extensionFactories`）。两边互不需要为对方做任何事。
 *
 * 与旧 `renderApprovalExtension()` 的逐条对照：
 *   · 不在 NEEDS 集 → 直接放行                                （同）
 *   · 无 UI            → 放行（旧：`if (!ctx.hasUI) return;`）    （同，但判据换成 `hasUiOutlet`，
 *                        且**必留痕**，见 `hasUiOutlet` 的长注释）
 *   · detail 截断 600 / 序列化失败退空串                       （同）
 *   · 弹窗文案 `允许执行工具 X?` + detail                       （同）
 *   · 拒绝 → `{block:true, reason:"用户拒绝执行"}`              （同）
 * 新增的一条：`confirm()` 抛错时 **fail-closed**（block）。旧路径下 handler 抛错会冒到
 * `ExtensionRunner.emitToolCall()`（该方法**没有** try/catch）→ agent-loop 的 `prepareToolCall`
 * catch 住 → 工具同样不执行。这里只是把那条隐式路径写成显式的、带可读 reason 的 block。
 */
export function createApprovalExtension(options: PiApprovalHookOptions): InlineExtension {
  const needs = new Set(options.tools ?? DEFAULT_APPROVAL_TOOLS);
  const record =
    options.onDecision ?? ((r: PiApprovalRecord) => defaultRecordApproval(r, options.uiSessionId));

  return {
    name: "cortex-approval",
    factory: (pi: ExtensionAPI) => {
      pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | void> => {
        if (!needs.has(event.toolName)) return;
        const detail = approvalDetail(event.input);

        const gate = canPromptForApproval(ctx, options.hasUiOutlet);
        if (!gate.ok) {
          record({ toolName: event.toolName, detail, decision: "skipped", reason: gate.reason });
          return; // 放行：与旧路径 `if (!ctx.hasUI) return;` 逐字同义
        }

        let approved: boolean;
        try {
          approved = await ctx.ui.confirm(`允许执行工具 ${event.toolName}?`, detail);
        } catch (err) {
          record({ toolName: event.toolName, detail, decision: "failed", reason: errText(err) });
          return { block: true, reason: "审批流程异常，已拒绝执行" };
        }

        if (!approved) {
          record({ toolName: event.toolName, detail, decision: "denied" });
          return { block: true, reason: "用户拒绝执行" };
        }
        record({ toolName: event.toolName, detail, decision: "approved" });
      });
    },
  };
}

// ── 2. todo_write 工具（对应 renderTodoExtension）──────────────────────────────────────

// 整表覆盖语义：每次调用传完整清单，对齐 claude 的 TodoWrite。
const TODO_WRITE_PARAMS = asToolSchema({
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "完整任务清单(整表覆盖上一次调用的清单)",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "任务内容(简短祈使句)" },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed"],
            description: "任务状态",
          },
        },
        required: ["text", "status"],
      },
    },
  },
  required: ["todos"],
});

/**
 * 任务清单工具。pi 无原生 TodoWrite，注册 `todo_write` 补齐。
 *
 * **execute 无状态**：清单不存在 pi 侧，host 从 `tool_execution_start.args` 直接取整表快照
 *（见 `pi.ts` / `pi-rpc.ts` 的特判 → 渲染端折叠成任务清单卡片），这里只回一句确认文本给模型。
 *
 * 计数复用 host 侧的 `normalizePiTodos()`（**不重写归一化逻辑**）：它跳过非法项、未知状态回退
 * pending。因此确认文本里的 `n/m` 与渲染端卡片显示的条数天然一致；旧模板直接数裸数组，
 * 模型塞进来的脏项会让两边对不上。
 */
export function createTodoTool(): ToolDefinition {
  return {
    name: TODO_TOOL_NAME,
    label: "任务清单",
    description:
      "维护当前任务的任务清单。仅在复杂多步任务(3 步以上)时使用:开工前列出计划,每完成一步立即再次调用更新状态;每次调用必须传完整清单(整表覆盖),同一时刻至多一项 in_progress。简单任务不要使用本工具。",
    promptSnippet: "todo_write - 复杂多步任务时创建并维护任务清单(整表覆盖)",
    parameters: TODO_WRITE_PARAMS,
    async execute(_toolCallId, params) {
      const todos = normalizePiTodos(params);
      const done = todos.filter((t) => t.status === "completed").length;
      return textResult(`任务清单已更新(${done}/${todos.length} 项完成)`);
    },
  };
}

// ── 3. askquestion 工具（对应 renderAskQuestionExtension）──────────────────────────────

const ASK_QUESTION_PARAMS = asToolSchema({
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
});

/** 归一化后的一组问题（信封内形状，与 host 的 `AskQuestionGroup` 对齐）。 */
interface AskQuestionGroupPayload {
  id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  allowCustom: boolean;
  header?: string;
  recommended?: number;
}

/**
 * 模型入参 → 信封内的问题组。与旧模板的 `buildGroups()` 逐条同义：
 * 组 id 按位置生成（`g0`/`g1`…）、选项截到 3 个、`recommended` 越界丢弃、`allowCustom` 布尔化。
 *
 * 这一步**不能**省掉去让 host 的 `sanitizeAskQuestionEnvelope()` 独扛：后者是 host 侧的
 * 不信任校验（还会把推荐项重排到首位），它要求入参已经是「带 id 的组」形状，两层职责不同。
 */
function buildAskQuestionGroups(raw: unknown[]): AskQuestionGroupPayload[] {
  const out: AskQuestionGroupPayload[] = [];
  for (let i = 0; i < raw.length; i++) {
    const g = (raw[i] ?? {}) as Record<string, unknown>;
    const rawOpts = Array.isArray(g.options) ? g.options.slice(0, ASK_QUESTION_MAX_OPTIONS) : [];
    const options = rawOpts.map((o) => {
      const oo = (o ?? {}) as Record<string, unknown>;
      const opt: { label: string; description?: string } = {
        label: String(oo.label != null ? oo.label : o),
      };
      if (oo.description != null) opt.description = String(oo.description);
      return opt;
    });
    let recommended = typeof g.recommended === "number" ? g.recommended : undefined;
    if (recommended != null && (recommended < 0 || recommended >= options.length)) recommended = undefined;
    const group: AskQuestionGroupPayload = {
      id: `g${i}`,
      question: String(g.question != null ? g.question : ""),
      options,
      allowCustom: !!g.allowCustom,
    };
    if (g.header != null) group.header = String(g.header);
    if (recommended != null) group.recommended = recommended;
    out.push(group);
  }
  return out;
}

/**
 * 向用户提问的工具。
 *
 * 【跨进程契约 · 务必与 `pi-inproc/ui-context.ts` 一起看】
 * 它**不**新造一条 UI 通道，而是沿用旧路径那条「借 `ctx.ui.input` 的 title 夹带信封」的约定：
 *   `ctx.ui.input(SENTINEL + JSON.stringify({groups}))`
 * `ui-context.ts` 的 `normalizeUiRequest()` 看到 title 以本会话 sentinel 开头，就把它解析并
 * 经 `sanitizeAskQuestionEnvelope()` 校验后，归一成 `method:"askquestion"` 的富信封发给渲染端。
 * 这一层归一化**已经由引擎层实现**，本文件只负责按同一格式发出去，绝不另起炉灶。
 *
 * sentinel 是每会话高熵 token（由 `pi:open` 生成）：LLM 无法在裸 `input` 的 title 里伪造它，
 * 因此拿不到 askquestion 的富交互 UI。sentinel 缺省时集成侧应干脆不注册本工具。
 *
 * 为什么在 execute 内直接 await `ctx.ui.input`：它不在会话生命周期 hook 上，不会死锁；
 * 挂起的对话框由 `ui-context.ts` 的 `cancelAll()` 在会话 stop 时统一解锁。
 */
export function createAskQuestionTool(sentinel: string): ToolDefinition {
  return {
    name: ASK_QUESTION_TOOL_NAME,
    label: "提问",
    description:
      "在确实需要用户做出选择或澄清时,向用户弹出一组或多组问题(每组最多 3 个选项,可标推荐项,可允许自定义输入)。仅在存在真实歧义、必须由用户裁决时调用;能自行决定的事项不要调用。",
    parameters: ASK_QUESTION_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const raw = (params as { groups?: unknown } | null | undefined)?.groups;
      const groupsRaw = Array.isArray(raw) ? raw : [];
      // 下面两条 throw 与旧模板的 `isError:true` 同文案（见文件头：0.82.1 只认抛异常）。
      if (!groupsRaw.length) throw new Error("askquestion 调用未提供任何问题组。");
      if (groupsRaw.length > ASK_QUESTION_MAX_GROUPS) {
        throw new Error(`问题组过多(最多 ${ASK_QUESTION_MAX_GROUPS} 组),请精简后重试。`);
      }

      const groups = buildAskQuestionGroups(groupsRaw);
      let value: string | undefined;
      try {
        value = await ctx.ui.input(sentinel + JSON.stringify({ groups }));
      } catch (err) {
        throw new Error(`提问过程出错: ${errText(err)}`);
      }

      // 取消是**正常结果**而非错误：用户点了取消不该让模型收到一个 error tool result。
      if (value === undefined || value === null) return textResult("用户取消了提问,未作选择。");

      let parsed: { answers?: Array<{ groupId?: string; value?: unknown; isCustom?: boolean }> };
      try {
        parsed = JSON.parse(value) as typeof parsed;
      } catch {
        throw new Error("无法解析用户的回答。");
      }
      const answers = Array.isArray(parsed?.answers) ? parsed.answers : [];
      const questionById = new Map(groups.map((g) => [g.id, g.question]));
      const lines = answers.map((a) => {
        const question = questionById.get(a?.groupId ?? "") ?? a?.groupId ?? "?";
        const answer = String(a?.value != null ? a.value : "");
        return `问: ${question}\n答: ${answer}${a?.isCustom ? "（自定义）" : ""}`;
      });
      return textResult(lines.length ? `用户回答如下:\n${lines.join("\n\n")}` : "用户未提供有效回答。");
    },
  };
}

// ── 4. 样例自定义工具 / 斜杠命令（对应 renderCustomToolExtension / renderSlashCommandExtension）──

const SAMPLE_ECHO_PARAMS = asToolSchema({
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
});

/** 样例自定义工具：把输入文本转大写。仅由设置页的「自定义工具样例」开关启用，用于验证注册链路。 */
export function createSampleEchoTool(): ToolDefinition {
  return {
    name: SAMPLE_TOOL_NAME,
    label: "Echo Upper",
    description: "把输入文本转成大写返回（Cortex 自定义工具样例）",
    parameters: SAMPLE_ECHO_PARAMS,
    async execute(_toolCallId, params) {
      const text = (params as { text?: unknown } | null | undefined)?.text;
      return textResult(typeof text === "string" ? text.toUpperCase() : "");
    },
  };
}

/**
 * 样例斜杠命令 `/greet`。用 `registerCommand` 注册，故它在 `getCommands()` 里的 `source`
 * 仍是 `"extension"` —— 与旧路径一致，`session.ts` 的「扩展命令补发 result 收尾」判定不受影响。
 */
export function createSampleCommandExtension(): InlineExtension {
  return {
    name: "cortex-sample-commands",
    factory: (pi: ExtensionAPI) => {
      pi.registerCommand(SAMPLE_COMMAND_NAME, {
        description: "打个招呼（Cortex 自定义命令样例）",
        handler: async (args, ctx) => {
          ctx.ui?.notify(`hello ${args || ""}`, "info");
        },
      });
    },
  };
}

// ── 5. 聚合入口 ───────────────────────────────────────────────────────────────────────

export interface PiNativeHooksOptions {
  /** 对应 `PiOpenRequest.enableToolApproval`。 */
  enableToolApproval?: boolean;
  /** 对应 `PiOpenRequest.approvalTools`（判定侧产物，本层只执行）。 */
  approvalTools?: string[];
  /** 【必填】见 `PiApprovalHookOptions.hasUiOutlet` 的长注释——这是本次迁移最容易翻车的一处。 */
  hasUiOutlet: () => boolean;
  /** 审批留痕出口（测试注入 / 集成侧自定义）。缺省写日志 + agent trace。 */
  onApprovalDecision?: (record: PiApprovalRecord) => void;
  /** 会话 id，仅用于留痕定位。 */
  uiSessionId?: string;
  /** 对应 `PiOpenRequest.enableSampleTools`。 */
  enableSampleTools?: boolean;
  /** 对应 `PiOpenRequest.enableSampleCommands`。 */
  enableSampleCommands?: boolean;
  /** askquestion 的会话级 sentinel。**缺省则不注册 askquestion**（无 sentinel 等于没有防伪）。 */
  askQuestionSentinel?: string;
  /** todo_write 是否注册。缺省 true —— 旧路径两条链路（RPC 与单发）都常驻加载它。 */
  enableTodoTool?: boolean;
  /**
   * 仅 gateway 长驻会话启用的模型上下文投影。renderer/PiOpenRequest 不暴露此开关，防止用户
   * 为节省 token 关闭运行正确性保护；oneshot 没有长驻历史，首版保持 false。
   */
  enableToolContextProjection?: boolean;
}

/** 可直接铺进 `PiInProcDeps` 的两堆产物。 */
export interface PiNativeHooks {
  /** → `PiInProcDeps.customTools`。 */
  customTools: ToolDefinition[];
  /** → `PiInProcDeps.extensionFactories`。 */
  extensionFactories: InlineExtension[];
}

/** 投影发生时只记录计数/估算值，绝不把路径、命令或工具正文写进 trace。 */
function recordToolContextProjection(sessionId: string | undefined, report: ToolContextProjectionReport): void {
  recordAgentTrace({
    scope: "pi",
    phase: "context-project",
    summary: report.budgetExhausted ? "工具上下文投影后仍超预算" : "已投影工具上下文",
    ...(sessionId ? { sessionId } : {}),
    data: report,
  });
}

/**
 * 按开关组装本次会话的原生能力集合。等价于旧 `pi-session.ts` 里那段
 * 「按开关 push 各个 `writeXxxExtension()` 路径到 `extraExtensionPaths`」，只是不再落盘。
 *
 * 组装顺序与旧路径一致（审批 → 样例工具 → 样例命令 → askquestion → todo）；工具重名时
 * pi 侧后者覆盖前者，故顺序仍有语义，不要随手调整。
 */
/** 【临时调试】DeepSeek「关闭思考仍思考」排查:观测真实发包的思考相关字段。
 * 客户端各层已证伪(off 档应发 thinking:{type:"disabled"}),before_provider_request 是
 * 发包前最后一站,打出实际 payload 即可在「扩展链改写」vs「服务端忽略」之间定案。
 * 事件载荷是包裹对象 {type,payload},请求体在 event.payload;handler 必须返回 undefined
 * ——任何返回值都会被当作替换后的请求体。只读不改写;定案后整个函数删除。 */
function createPayloadDebugExtension(): InlineExtension {
  return {
    name: "cortex-payload-debug",
    factory: (pi: ExtensionAPI) => {
      (pi as unknown as { on(ev: string, cb: (event: { payload?: unknown }) => void): void }).on(
        "before_provider_request",
        (event) => {
          try {
            const p = (event?.payload ?? {}) as Record<string, unknown>;
            const line = JSON.stringify({
              model: p.model,
              thinking: p.thinking,
              reasoning_effort: p.reasoning_effort,
              chat_template_kwargs: p.chat_template_kwargs,
              enable_thinking: p.enable_thinking,
            });
            log.info("[pi-payload]", line);
            // 双保险:worker 的 logger 汇聚链路若失效,stdout 仍会被主进程捕获。
            console.log("[pi-payload]", line);
          } catch { /* 观测失败不影响请求 */ }
        },
      );
    },
  };
}

export function createPiNativeHooks(options: PiNativeHooksOptions): PiNativeHooks {
  const customTools: ToolDefinition[] = [];
  const extensionFactories: InlineExtension[] = [];

  // 【临时调试】发包观测扩展必须无条件注入:审批扩展在「完全访问」档不加载,挂在
  // 那里会漏掉关审批的会话(实测踩到)。定案后连同 createPayloadDebugExtension 一起删。
  extensionFactories.push(createPayloadDebugExtension());
  // bash 失败纠偏提示无条件注入:它只读工具结果、不改 isError、不弹 UI,任何权限档位都适用;
  // 与审批扩展不同,没有「关掉它更安全」的场景。见 tool-failure-hints.ts 文件头。
  extensionFactories.push(createToolFailureHintExtension());

  if (options.enableToolApproval) {
    extensionFactories.push(
      createApprovalExtension({
        ...(options.approvalTools ? { tools: options.approvalTools } : {}),
        hasUiOutlet: options.hasUiOutlet,
        ...(options.onApprovalDecision ? { onDecision: options.onApprovalDecision } : {}),
        ...(options.uiSessionId ? { uiSessionId: options.uiSessionId } : {}),
      }),
    );
  }
  if (options.enableSampleTools) customTools.push(createSampleEchoTool());
  if (options.enableSampleCommands) extensionFactories.push(createSampleCommandExtension());
  if (options.askQuestionSentinel) customTools.push(createAskQuestionTool(options.askQuestionSentinel));
  if (options.enableTodoTool !== false) customTools.push(createTodoTool());
  if (options.enableToolContextProjection) {
    // uiSessionId 是 gateway 的稳定会话命名空间；临时输出以其 hash 分目录，避免文件名泄露用户内容。
    extensionFactories.push(
      createToolContextExtension({
        sessionId: options.uiSessionId ?? "pi-session",
        onReport: (report) => recordToolContextProjection(options.uiSessionId, report),
      }),
    );
  }

  return { customTools, extensionFactories };
}
