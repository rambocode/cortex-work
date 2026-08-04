// 自动化 MCP server：把「定时任务」暴露成模型可在会话中直接调用的工具，让用户能在聊天里说
// 「每天早上 9 点帮我总结 AI 新闻」就建好任务、问「我有哪些定时任务」就查到。
//
// 架构复用 capabilities/loop-workflows/server.ts 的范式：createMcpHost 独立实例 +
// per-session Map + buildXxxMcpServerConfig 门控。领域逻辑一律委托 automation/service.ts
// （与 IPC 路径共用同一份，见该文件头注释）。
//
// ⚠️ 【安全约束一：只在 pi RPC 聊天路径注入】
// 写工具（create/update/delete/run_now）必须逐次经用户确认，而真审批回路只在 pi RPC 路径存在：
//   · claude 在 full-auto 下走 --dangerously-skip-permissions（agents/claude.ts），全放行；
//   · codex 的内置 server 被强制 default_tools_approval_mode="approve"（ipc/mcp-config.ts），自动批准；
//   · pi 单发路径不写审批 extension，且 extension 里的 ctx.hasUI 为 false，审批 hook 直接 return。
// 所以本 server 只接 ipc/pi-session.ts 一处，**刻意不进** ipc/cli.ts 的 builtinServers / piBridgeCfgs。
// 这与 capabilities/computer-use/inject.ts 的既定判例同源。
//
// ⚠️ 【安全约束二：定时任务自身的执行路径绝不注入】
// automation/runner.ts 是无人值守的单发路径，没有任何审批 UI。在那里给模型建/删自动化的权限，
// 等于让 agent 无监督地自增殖。结构上 runner 自己拼 CliStartRequest 直接 spawn，压根不经过本
// 文件；下面的 G1 守卫（sessionStateMap 未注册即一个工具都不注册）是第二道保险 —— 即使日后
// 有人好心把 config 接进 runner，run.id 也永远不在 sessionStateMap 里，拿不到任何工具。

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHost, type McpHostHandle, type ToolContext } from "../mcp-host/server";
import { getPersistedState } from "../../ipc/store";
import type {
  AgentKind,
  AutomationInput,
  AutomationMeta,
  AutomationToolsSettings,
  McpServerConfig,
  PushChannelKind,
  ReasoningEffort,
} from "../../ipc/types";
import { AUTOMATION_READONLY_TOOLS, AUTOMATION_WRITE_TOOLS } from "../../ipc/types";
import {
  createAutomation,
  deleteAutomation,
  runAutomationNow,
  setAutomationEnabled,
  updateAutomation,
} from "../../automation/service";
import { getAutomation, loadAutomations, loadRuns } from "../../automation/store";
import { buildScheduleSpec, describeSchedule, touchesSchedule, type ScheduleInputArgs } from "./schedule-input";

// 注入用 server id（= MCP server 名）。须为 TOML 裸键安全（见 mcp-config.isValidServerId）。
export const AUTOMATION_SERVER_ID = "cortex-automation";

const automationHost = createMcpHost(AUTOMATION_SERVER_ID);

// ── per-session 状态 ─────────────────────────────────────────────────────────
//
// agent / model / effort / cwd / providerId 一律**从会话继承、不暴露给模型**：
//   · cwd 若允许模型传参，等于任意路径注入（同 loop-workflows/server.ts 的既定理由）；
//   · providerId 解析不出时，失败点在后台、用户不在场（automation/runner.ts 的 resolveProvider
//     注释称其为最难被发现的静默错），用会话当前值是唯一不会错的取法；
//   · model/effort 模型并不知道用户配了哪些，猜错的代价是每天定时任务静默报错。
// 语义上这也最符合用户预期：「跟我现在这个对话一样地跑」。

interface SessionState {
  cwd: string;
  agent: AgentKind;
  model?: string;
  effort?: ReasoningEffort;
  providerId?: string;
}

const sessionStateMap = new Map<string, SessionState>();

export function registerAutomationSession(sessionId: string, state: SessionState): void {
  sessionStateMap.set(sessionId, state);
}

export function unregisterAutomationSession(sessionId: string): void {
  sessionStateMap.delete(sessionId);
}

/** 单元测试与守卫用：判断某 sessionId 当前是否持有工具权限。 */
export function hasAutomationSession(sessionId: string): boolean {
  return sessionStateMap.has(sessionId);
}

// ── 工具结果构造（形状对齐 loop-workflows/server.ts，保持跨 capability 一致）──────

function makeErrorResult(message: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

function makeSuccessResult(
  text: string,
  data?: Record<string, unknown>,
): { content: [{ type: "text"; text: string }] } {
  const fullText = data ? `${text}\n${JSON.stringify(data, null, 2)}` : text;
  return { content: [{ type: "text", text: fullText }] };
}

// ── 输出裁剪 ─────────────────────────────────────────────────────────────────
// 运行历史默认保留 200 条（automation/store.ts 的 DEFAULT_KEEP_RUNS），单条 output 上限 200KB。
// 不截断的话一次 get_automation_runs 就能灌爆整个上下文窗口。

const PROMPT_PREVIEW_MAX = 120;
const RUN_OUTPUT_MAX = 1500;
const RUNS_TOTAL_MAX = 8000;
const RUNS_DEFAULT_LIMIT = 5;
const RUNS_MAX_LIMIT = 20;

function truncate(text: string, max: number): string {
  const t = (text ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…（已截断，原文 ${t.length} 字）`;
}

function isoOrNull(ms: number | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 列表项：刻意不返回 cwd / providerId —— 模型用不到，且没必要把本机路径漏进上下文。 */
function toListItem(meta: AutomationMeta): Record<string, unknown> {
  return {
    id: meta.id,
    name: meta.name,
    enabled: meta.enabled,
    schedule: describeSchedule(meta.schedule),
    timezone: meta.timezone ?? null,
    next_run_at: isoOrNull(meta.nextRunAt),
    last_run_at: isoOrNull(meta.lastRunAt),
    last_status: meta.lastStatus ?? null,
    agent: meta.agent,
    created_by: meta.createdBy ?? "user",
    prompt_preview: truncate(meta.prompt, PROMPT_PREVIEW_MAX),
  };
}

// ── 开关 gate ────────────────────────────────────────────────────────────────

/** 缺省视为开启（同 Computer Use 的口径：默认开箱即用 + 写操作强制审批）。 */
export function automationToolsEnabled(settings: AutomationToolsSettings | undefined): boolean {
  return settings?.enabled !== false;
}

/**
 * handler 内的二次开关校验：用户在会话进行中关掉开关时，给模型一条可读错误而非静默成功。
 * pi 的工具集在 pi:open 时冻结，温会话仍会列出这些工具，故这道校验是必需的（同 media-gen）。
 */
async function ensureEnabled(): Promise<string | null> {
  try {
    const gs = (await getPersistedState()).generalSettings;
    if (!automationToolsEnabled(gs?.automationTools)) {
      return "自动化工具已被用户关闭（设置 → 插件管理 → MCP）。本次操作未执行。";
    }
  } catch {
    // 读设置失败不阻断：缺省即开启，与 automationToolsEnabled 的口径一致。
  }
  return null;
}

// ── 工具注册 ─────────────────────────────────────────────────────────────────

// 继承说明：写进每个工具的 description，避免模型反复尝试传 model/cwd 这些拿不到的参数。
const INHERIT_NOTE =
  "执行时使用的 Agent、模型、推理强度与工作目录**继承自当前会话**，不接受参数指定；" +
  "如需更改请让用户在「自动化」界面调整。";

const SCHEDULE_NOTE =
  "定时规则用 schedule_kind + 对应字段表达：" +
  "hourly 需 minute；daily/weekdays 需 hour+minute；weekly 需 weekday(0=周日..6=周六)+hour+minute；" +
  "cron 需 cron_expression(5 段：分 时 日 月 周)；once 需 at(如 2026-08-05T09:00，不带时区即按本机时区)。";

const scheduleShape = {
  schedule_kind: z
    .enum(["hourly", "daily", "weekdays", "weekly", "cron", "once"])
    .optional()
    .describe("定时类型"),
  minute: z.number().int().min(0).max(59).optional().describe("分钟 0-59"),
  hour: z.number().int().min(0).max(23).optional().describe("小时 0-23"),
  weekday: z.number().int().min(0).max(6).optional().describe("星期几，0=周日 .. 6=周六"),
  cron_expression: z.string().optional().describe("5 段 cron 表达式：分 时 日 月 周"),
  at: z.string().optional().describe("一次性触发时刻，如 2026-08-05T09:00；必须含时分"),
};

const NOTIFY_CHANNELS = ["wecom", "dingtalk", "feishu", "email", "internal"] as const;

/**
 * 注册自动化工具。
 *
 * 【G1 守卫】第一件事就是查 sessionStateMap：取不到就**一个工具都不注册**。
 * 这把「注入」与「授权」解耦 —— 未经 buildAutomationMcpServerConfig 登记的调用方
 * （定时任务的 run.id、陈旧凭据）即使连上 host，tools/list 也只有 ping。
 */
export function registerAutomationTools(mcp: McpServer, ctx: ToolContext): void {
  const state = ctx.sessionId ? sessionStateMap.get(ctx.sessionId) : undefined;
  if (!state) return;

  // ── list_automations ───────────────────────────────────────────────────────
  mcp.registerTool(
    "list_automations",
    {
      description:
        "列出用户当前的全部定时任务（自动化），返回 id、名称、是否启用、定时规则、下次/上次运行时间与上次结果。" +
        "修改或运行某条任务前，先用本工具拿到它的 id。",
      inputSchema: {},
    },
    async () => {
      let list: AutomationMeta[];
      try {
        list = await loadAutomations();
      } catch (e) {
        return makeErrorResult(`list_automations 失败：读取定时任务列表出错 —— ${String(e)}`);
      }
      if (list.length === 0) {
        // 空列表要说清楚是「真的没有」而非工具坏了，否则模型会反复重试或改用别的工具。
        return makeSuccessResult("当前没有任何定时任务。可以用 create_automation 新建一条。", {
          automations: [],
        });
      }
      const items = list.map(toListItem);
      const summary = items
        .map((i) => `- ${i.name}（id: ${i.id}，${i.schedule}${i.enabled ? "" : "，已暂停"}）`)
        .join("\n");
      return makeSuccessResult(`共 ${items.length} 条定时任务：\n${summary}`, { automations: items });
    },
  );

  // ── get_automation_runs ────────────────────────────────────────────────────
  mcp.registerTool(
    "get_automation_runs",
    {
      description:
        "查看某条定时任务最近的执行记录（状态、耗时、输出摘要、错误）。用于回答「上次跑得怎么样」「为什么失败了」。",
      inputSchema: {
        automation_id: z.string().min(1).describe("定时任务 id（来自 list_automations）"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(RUNS_MAX_LIMIT)
          .optional()
          .describe(`返回条数，默认 ${RUNS_DEFAULT_LIMIT}，最多 ${RUNS_MAX_LIMIT}`),
      },
    },
    async ({ automation_id, limit }: { automation_id: string; limit?: number }) => {
      const meta = await getAutomation(automation_id).catch(() => undefined);
      if (!meta) {
        return makeErrorResult(`定时任务「${automation_id}」不存在。请先用 list_automations 获取正确的 id。`);
      }
      let runs: Awaited<ReturnType<typeof loadRuns>>;
      try {
        runs = await loadRuns(automation_id);
      } catch (e) {
        return makeErrorResult(`get_automation_runs 失败：读取执行记录出错 —— ${String(e)}`);
      }
      if (runs.length === 0) {
        return makeSuccessResult(`定时任务「${meta.name}」还没有执行记录。`, { runs: [] });
      }
      // 双重裁剪：先按 limit 取，再按总字数封顶 —— 单条 output 上限 200KB，仅靠条数限不住。
      let budget = RUNS_TOTAL_MAX;
      const items = runs.slice(0, limit ?? RUNS_DEFAULT_LIMIT).map((r) => {
        const output = budget > 0 ? truncate(r.output, Math.min(RUN_OUTPUT_MAX, budget)) : "（已省略）";
        budget -= output.length;
        return {
          status: r.status,
          trigger: r.trigger,
          started_at: isoOrNull(r.startedAt),
          duration_ms: r.endedAt ? r.endedAt - r.startedAt : null,
          error: r.error ?? null,
          output,
        };
      });
      return makeSuccessResult(`定时任务「${meta.name}」最近 ${items.length} 次执行：`, { runs: items });
    },
  );

  // ── create_automation ──────────────────────────────────────────────────────
  mcp.registerTool(
    "create_automation",
    {
      description:
        "为用户新建一条定时任务。prompt 是到点时交给 Agent 执行的完整指令，要写成能独立执行的任务描述" +
        "（因为执行时没有当前对话的上下文）。" +
        SCHEDULE_NOTE +
        INHERIT_NOTE,
      inputSchema: {
        name: z.string().min(1).max(60).describe("任务名称，简短可辨识"),
        prompt: z.string().min(1).describe("到点执行的完整指令（无当前会话上下文，需自包含）"),
        ...scheduleShape,
        timezone: z.string().optional().describe("IANA 时区，如 Asia/Shanghai；省略即本机时区"),
        enabled: z.boolean().optional().describe("是否立即启用，默认 true"),
        notify_channels: z
          .array(z.enum(NOTIFY_CHANNELS))
          .optional()
          .describe("完成后通知渠道（需用户已在设置里配置该渠道才会真正发出）"),
      },
    },
    async (args: {
      name: string;
      prompt: string;
      timezone?: string;
      enabled?: boolean;
      notify_channels?: PushChannelKind[];
    } & ScheduleInputArgs) => {
      const blocked = await ensureEnabled();
      if (blocked) return makeErrorResult(blocked);

      const schedule = buildScheduleSpec(args);
      if (!schedule.ok) return makeErrorResult(`create_automation 参数有误：${schedule.error}`);

      const input: AutomationInput = {
        name: args.name,
        prompt: args.prompt,
        schedule: schedule.spec,
        timezone: args.timezone,
        enabled: args.enabled,
        notifyChannels: args.notify_channels,
        // 会话继承（模型不可指定）。
        agent: state.agent,
        model: state.model,
        effort: state.effort,
        cwd: state.cwd,
        providerId: state.providerId,
      };
      try {
        const meta = await createAutomation(input, "agent");
        return makeSuccessResult(
          `已创建定时任务「${meta.name}」（${describeSchedule(meta.schedule)}）。`,
          { id: meta.id, next_run_at: isoOrNull(meta.nextRunAt), enabled: meta.enabled },
        );
      } catch (e) {
        return makeErrorResult(`create_automation 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ── update_automation ──────────────────────────────────────────────────────
  mcp.registerTool(
    "update_automation",
    {
      description:
        "修改一条已有的定时任务。只传需要改的字段。" +
        "注意定时规则是**整体替换**：一旦要改时间，必须给出完整的 schedule_kind 及其配套字段。" +
        SCHEDULE_NOTE +
        INHERIT_NOTE,
      inputSchema: {
        automation_id: z.string().min(1).describe("定时任务 id（来自 list_automations）"),
        name: z.string().min(1).max(60).optional(),
        prompt: z.string().min(1).optional(),
        ...scheduleShape,
        timezone: z.string().optional(),
        notify_channels: z.array(z.enum(NOTIFY_CHANNELS)).optional(),
      },
    },
    async (args: {
      automation_id: string;
      name?: string;
      prompt?: string;
      timezone?: string;
      notify_channels?: PushChannelKind[];
    } & ScheduleInputArgs) => {
      const blocked = await ensureEnabled();
      if (blocked) return makeErrorResult(blocked);

      const patch: Partial<AutomationInput> = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.prompt !== undefined) patch.prompt = args.prompt;
      if (args.timezone !== undefined) patch.timezone = args.timezone;
      if (args.notify_channels !== undefined) patch.notifyChannels = args.notify_channels;

      // 只要碰了任一定时字段就要求给全 —— 半套字段合出来的 schedule 极可能不是用户想要的时刻。
      if (touchesSchedule(args)) {
        const schedule = buildScheduleSpec(args);
        if (!schedule.ok) return makeErrorResult(`update_automation 参数有误：${schedule.error}`);
        patch.schedule = schedule.spec;
      }
      if (Object.keys(patch).length === 0) {
        return makeErrorResult("update_automation 没有收到任何要修改的字段。");
      }

      try {
        const meta = await updateAutomation(args.automation_id, patch);
        if (!meta) {
          return makeErrorResult(
            `定时任务「${args.automation_id}」不存在。请先用 list_automations 获取正确的 id。`,
          );
        }
        return makeSuccessResult(`已更新定时任务「${meta.name}」（${describeSchedule(meta.schedule)}）。`, {
          id: meta.id,
          next_run_at: isoOrNull(meta.nextRunAt),
          enabled: meta.enabled,
        });
      } catch (e) {
        return makeErrorResult(`update_automation 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ── set_automation_enabled ─────────────────────────────────────────────────
  // 独立成工具（而非让模型走 update）：这是最高频、最低风险的写操作，独立工具让审批弹窗的语义
  // 一眼可辨（「暂停某任务」vs「修改某任务」）。
  mcp.registerTool(
    "set_automation_enabled",
    {
      description: "启用或暂停一条定时任务。暂停后不再按时触发，配置与历史记录保留。",
      inputSchema: {
        automation_id: z.string().min(1).describe("定时任务 id（来自 list_automations）"),
        enabled: z.boolean().describe("true=启用，false=暂停"),
      },
    },
    async ({ automation_id, enabled }: { automation_id: string; enabled: boolean }) => {
      const blocked = await ensureEnabled();
      if (blocked) return makeErrorResult(blocked);
      try {
        const meta = await setAutomationEnabled(automation_id, enabled);
        if (!meta) return makeErrorResult(`定时任务「${automation_id}」不存在。`);
        return makeSuccessResult(`已${enabled ? "启用" : "暂停"}定时任务「${meta.name}」。`, {
          id: meta.id,
          enabled: meta.enabled,
          next_run_at: isoOrNull(meta.nextRunAt),
        });
      } catch (e) {
        return makeErrorResult(`set_automation_enabled 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ── delete_automation ──────────────────────────────────────────────────────
  mcp.registerTool(
    "delete_automation",
    {
      description:
        "删除一条定时任务（连同它的全部执行记录，不可恢复）。" +
        "必须同时传 confirm_name，且与该任务的名称完全一致 —— 这是防止删错任务的护栏。" +
        "若只是暂时不想让它跑，请改用 set_automation_enabled 暂停。",
      inputSchema: {
        automation_id: z.string().min(1).describe("定时任务 id（来自 list_automations）"),
        confirm_name: z.string().min(1).describe("该任务的完整名称，必须逐字一致"),
      },
    },
    async ({ automation_id, confirm_name }: { automation_id: string; confirm_name: string }) => {
      const blocked = await ensureEnabled();
      if (blocked) return makeErrorResult(blocked);

      const meta = await getAutomation(automation_id).catch(() => undefined);
      if (!meta) return makeErrorResult(`定时任务「${automation_id}」不存在。`);
      // 名称复核：删除会连运行历史一并抹掉（automation/store.ts 的 deleteAutomationStore），
      // 拿错 id 的后果无法回滚，故要求模型把名字也说对，等于让它自证「确实找对了那一条」。
      if (confirm_name.trim() !== meta.name.trim()) {
        return makeErrorResult(
          `confirm_name 与任务名称不符：id ${automation_id} 对应的任务叫「${meta.name}」，` +
            `而你传的是「${confirm_name}」。已拒绝删除，请先核对。`,
        );
      }
      try {
        await deleteAutomation(automation_id);
        return makeSuccessResult(`已删除定时任务「${meta.name}」及其执行记录。`);
      } catch (e) {
        return makeErrorResult(`delete_automation 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ── run_automation_now ─────────────────────────────────────────────────────
  mcp.registerTool(
    "run_automation_now",
    {
      description:
        "立即手动执行一次定时任务（不影响它原本的定时安排）。" +
        "注意本工具**不等待执行完成**就返回，结果稍后可用 get_automation_runs 查看。",
      inputSchema: {
        automation_id: z.string().min(1).describe("定时任务 id（来自 list_automations）"),
      },
    },
    async ({ automation_id }: { automation_id: string }) => {
      const blocked = await ensureEnabled();
      if (blocked) return makeErrorResult(blocked);
      try {
        const run = await runAutomationNow(automation_id);
        if (!run) return makeErrorResult(`定时任务「${automation_id}」不存在。`);
        // skipped 是并发去重的结果，不是失败。不翻译成人话的话，模型会把它当成执行完毕汇报给用户。
        if (run.status === "skipped") {
          return makeSuccessResult(
            "该定时任务上一次执行还没结束，本次触发已跳过（同一任务同时只跑一个）。稍后可用 get_automation_runs 查看上一次的结果。",
            { run_id: run.id, status: run.status },
          );
        }
        return makeSuccessResult(
          "已开始执行。本工具不等待完成 —— 请**不要**把此刻的状态当作最终结果；" +
            "稍后用 get_automation_runs 查询该任务的最新一条记录才是真正的执行结果。",
          { run_id: run.id, status: run.status },
        );
      } catch (e) {
        return makeErrorResult(`run_automation_now 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

// ── host 生命周期 ─────────────────────────────────────────────────────────────

export function startAutomationHost(): Promise<McpHostHandle> {
  return automationHost.start(registerAutomationTools);
}

export function stopAutomationHost(): void {
  automationHost.stop();
}

export function getAutomationHostHandle(): McpHostHandle | null {
  return automationHost.getHandle();
}

// ── 注入配置构建 ──────────────────────────────────────────────────────────────

/**
 * 构建自动化 MCP server 的注入配置；不满足条件返回 null（不注入）。
 *
 * gate：
 *   1. 全局开关关闭 → null；
 *   2. host 未起 / 不可用 → null（避免给 agent 一个连不上的 url）；
 *   3. 无 sessionId → null（没有 session 就没有可继承的 agent/cwd，工具也无从授权）。
 *
 * **刻意不做「至少有一条自动化」的存在性 gate**：零任务时恰恰最需要 create_automation。
 *
 * @param sessionId pi RPC 会话 id（经 X-Cortex-Session 头回传）
 * @param state     本会话的执行上下文，写工具建任务时原样继承
 * @param settings  GeneralSettings.automationTools，缺省视为开启
 */
export function buildAutomationMcpServerConfig(
  sessionId: string | undefined,
  state: SessionState,
  settings: AutomationToolsSettings | undefined,
): McpServerConfig | null {
  if (!automationToolsEnabled(settings)) return null;
  if (!sessionId) return null;
  const handle = getAutomationHostHandle();
  if (!handle || !handle.serverAvailable || handle.port <= 0) return null;

  registerAutomationSession(sessionId, state);

  return {
    id: AUTOMATION_SERVER_ID,
    transport: "http",
    url: `http://127.0.0.1:${handle.port}/mcp`,
    headers: {
      Authorization: `Bearer ${handle.token}`,
      "X-Cortex-Session": sessionId,
    },
  };
}

// 工具名清单（供一致性测试断言：这些名字必须与 core 的审批集常量逐字一致，
// 否则审批 extension 匹配不到 → 静默放行）。
export const AUTOMATION_TOOL_NAMES = {
  readonly: AUTOMATION_READONLY_TOOLS,
  write: AUTOMATION_WRITE_TOOLS,
} as const;
