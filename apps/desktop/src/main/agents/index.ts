// Agent CLI 声明式适配注册表(M2)。每个 agent 是一个声明式 `AgentDef`:两个纯函数
// (buildArgs 构造命令 / parseLine 解析输出)+ 一组**能力位**。
// 能力位当前的消费情况(避免误读):
//   - mcpInjection 由公共管线(cli.ts)真正消费 —— spawn 前按它 + 全局开关决定 MCP 注入方式(U2)。
//   - 其余位(promptDelivery / sessionResume / imageDelivery / appendSystemPrompt)目前是**声明式文档**:
//     如实描述各 adapter 在自己 buildArgs 内的处理策略,管线尚未据此分流(分支仍内联在 adapter)。
//     后续可按需把对应分流上提到公共管线;在此之前它们是 def 的「策略说明」,不是已生效的管线开关。
// 能力位取值:
//   promptDelivery   stdin-stream-json(claude)/ stdin-eof(codex)/ argv(pi)
//   mcpInjection     claude-mcp-json(写 cwd .mcp.json)/ codex-c(-c 注入)/ none  ← 管线消费
//   sessionResume    continue+resume / resume-only / none
//   imageDelivery    native-flag(--image)/ prompt-text(拼进文本)/ none
//   appendSystemPrompt native-flag(原生 flag)/ prompt-wrap(<user_request> 包裹)/ none
//   transport        spawn(缺省,claude/pi:每轮 spawn CLI + 逐行解析)/ ws(codex 主交互会话:
//                    长驻 `codex app-server --listen ws://` + WebSocket 持久连接)  ← 管线消费(U5)
//   ⚠️ transport 与 mcpInjection 一样**由公共管线真正消费**(cli:start 据 (transport ?? "spawn")
//      分流到 ws 路径或现有 spawn 路径);仅 codex 主交互会话(cli:start)走 ws,轻量路径
//      (oneshot/ask/automation/workflow-headless)不读该位、恒走 spawn+`codex exec`。

import type { AgentKind, CliStartRequest, CliStreamEvent, DerivedAgentMeta } from "../ipc/types";
import {
  defaultAgentProfilesPath,
  deriveAgentDef,
  readLocalAgentProfilesFile,
  type LocalAgentProfile,
} from "./agent-profiles";
import { claudeDef } from "./claude";
import { codexDef } from "./codex";
import { piDef } from "./pi";
import { createLogger, isDevEnv } from "../log";
import { redactString } from "../log/redact";

// 解析失败盲区专用 scope:未被映射的「结构化帧」(看似 JSON 却没解析出事件)在此可观测。
// 正是 Pi RPC 终态卡死类 bug 的盲区——adapter 静默 return null,排障时无从复盘原始帧。
const parseLog = createLogger("parse");

export type PromptDelivery = "stdin-stream-json" | "stdin-eof" | "argv";
export type McpInjection = "claude-mcp-json" | "codex-c" | "none";
export type SessionResume = "continue+resume" | "resume-only" | "none";
export type ImageDelivery = "native-flag" | "prompt-text" | "none";
export type AppendSystemPrompt = "native-flag" | "prompt-wrap" | "none";
export type Transport = "spawn" | "ws";

export interface AgentDef {
  // 内置 def 用 AgentKind;M3-A 用户 JSON 派生的 def 可为任意合法 id,故放宽为 string。
  id: string;
  // ── 能力位(声明式)。mcpInjection 由公共管线消费;其余位描述各 adapter 自身策略(见文件头注释)──
  promptDelivery: PromptDelivery;
  mcpInjection: McpInjection;
  sessionResume: SessionResume;
  imageDelivery: ImageDelivery;
  appendSystemPrompt: AppendSystemPrompt;
  // 传输方式(可选,缺省 "spawn")。由公共管线消费:cli:start 据 (transport ?? "spawn") 分流。
  // 仅 codex 标 "ws"(主交互会话走 app-server WebSocket);claude/pi 省略 → 缺省 spawn,零改动。
  // 派生 agent(base:codex)经 deriveAgentDef 的 {...base} 展开继承本位。
  transport?: Transport;
  // 传输为 "ws" 时,spawn `codex app-server` 的可执行名(缺省 "codex")。派生 agent 若覆写
  // 二进制路径(profile.bin)应填此字段,否则 ws 路径会静默用系统 codex 而非自定义 bin。
  serverCmd?: string;
  // 注入子进程的额外环境变量(M3-A 派生 def 用;内置 def 为 undefined)。由 spawn 站点合并进 env。
  extraEnv?: Record<string, string>;
  // 已知会被 parseLine 静默忽略、但**不是**盲区(已评审过、故意不产出事件)的帧 type 集合。
  // 盲区补点(下方 parseLineEvents)只想告警"真正没被适配过的新帧",这些帧命中后即便解析出 []
  // 也不应算作信号——否则每轮都刷屏,把该关注的协议漂移淹没在已知噪声里(见 pi.ts 的
  // agent_start/turn_start/turn_end/agent_end/message_start)。缺省 undefined = 沿用现状,
  // 所有空解析的 `{` 开头行都告警(claude/codex 未声明此位,行为不变)。
  ignoredFrameTypes?: ReadonlySet<string>;
  // ── 两个纯函数 ──
  // 返回可执行名与参数(可执行名不带路径，由 cli.ts 结合 PATH 解析),以及可选的 stdin 负载。
  // stdin 存在时(claude/codex):prompt 经 stdin 投递、不进 argv,绕开命令行长度上限(E2BIG/ENAMETOOLONG);
  // cli.ts 写入后立即 end() 发 EOF。stdin 省略时(pi):prompt 仍在 argv。
  // mcpArgs(U2):公共管线为 mcpInjection:"codex-c" 的 def 预算好的 `-c` 注入参数,def 负责放到正确位置
  //(codex 放进 common,落在位置参数之前);其它 def(claude 文件注入 / pi 不注入)忽略。
  buildArgs(req: CliStartRequest, mcpArgs?: string[]): { cmd: string; args: string[]; stdin?: string };
  // 解析一行 stdout，返回归一化事件；无法识别的行返回 null(忽略)。一行可携带多个事件
  // (如 claude/codex 收尾行同时含 usage 与 result),此时返回数组。
  parseLine(line: string): CliStreamEvent | CliStreamEvent[] | null;
}

// 把 parseLine 的「单事件 | 数组 | null」三态归一为数组,供 spawn 管线统一迭代(cli.ts / ask.ts)。
export function parseLineEvents(def: AgentDef, line: string): CliStreamEvent[] {
  const r = def.parseLine(line);
  const events = Array.isArray(r) ? r : r ? [r] : [];
  // 盲区补点(R10):只对「看似结构化帧却没解析出事件」告警——即 trim 后以 `{` 开头的行。
  // claude/codex 的 parseLine 对大量正常行(ping / content_block_start-stop / 纯文本块 /
  // user-tool_result 等)也返回 null,若一律告警会在每次流式运行刷屏、淹没真正的协议漂移信号
  // (correctness 评审指出),且 warn 非细粒度级别不受 scope 过滤、prod 也会落盘。故:
  //  - 收窄到 `{` 开头(疑似 JSON 帧未被映射 = 真正值得关注的协议漂移);
  //  - 降为 debug 级 + 仅 dev(prod 不落、dev 可经 CORTEX_DEBUG=parse 精确放行);
  //  - 落盘失败 try/catch 吞掉,绝不阻断解析主流程(R14)。返回行为保持不变。
  if (events.length === 0 && isDevEnv()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && !isKnownIgnoredFrame(def, trimmed)) {
      try {
        parseLog.debug(`未映射的 ${def.id} 输出帧`, redactString(line));
      } catch {
        /* 日志失败不影响解析 */
      }
    }
  }
  return events;
}

// 命中 def.ignoredFrameTypes 的帧不算盲区(已评审、故意忽略),不告警。JSON 解析失败/无
// type 字段/def 未声明该位 → 视为「不是已知忽略帧」,回退到现状告警(保守,不漏真正的盲区)。
function isKnownIgnoredFrame(def: AgentDef, trimmedLine: string): boolean {
  if (!def.ignoredFrameTypes) return false;
  try {
    const obj = JSON.parse(trimmedLine) as Record<string, unknown>;
    return typeof obj?.type === "string" && def.ignoredFrameTypes.has(obj.type);
  } catch {
    return false;
  }
}

const AGENT_DEFS: Record<string, AgentDef> = {
  claude: claudeDef,
  codex: codexDef,
  pi: piDef,
};

// ── M3-A:用户 JSON(agents.local.json)派生/覆盖 agent ──────────────────────────────
// profiles 懒加载 + 缓存:首次 getAgentDef/listAgentProfiles 时读盘派生,之后命中缓存,直到
// refreshLocalAgentProfiles() 失效(用户改文件后由 IPC 触发)。loader 可注入便于单测。

let profilesLoader: () => LocalAgentProfile[] = () =>
  readLocalAgentProfilesFile(defaultAgentProfilesPath());

let derivedCache: Record<string, AgentDef> | null = null;
let derivedMetaCache: DerivedAgentMeta[] | null = null;

function loadDerived(): Record<string, AgentDef> {
  if (derivedCache) return derivedCache;
  const map: Record<string, AgentDef> = {};
  const meta: DerivedAgentMeta[] = [];
  for (const p of profilesLoader()) {
    const base = AGENT_DEFS[p.base];
    if (!base) continue; // base 必是内置(parseLocalAgentProfiles 已校验),防御性跳过
    map[p.id] = deriveAgentDef(base, p);
    meta.push({ id: p.id, base: p.base, label: p.label });
  }
  derivedCache = map;
  derivedMetaCache = meta;
  return map;
}

// 用户改 agents.local.json 后失效缓存,下次访问重新读盘派生。
export function refreshLocalAgentProfiles(): void {
  derivedCache = null;
  derivedMetaCache = null;
}

// 测试注入点:传 null 恢复默认(读真实文件)。设置后自动失效缓存。
export function setLocalAgentProfilesLoader(fn: (() => LocalAgentProfile[]) | null): void {
  profilesLoader = fn ?? (() => readLocalAgentProfilesFile(defaultAgentProfilesPath()));
  refreshLocalAgentProfiles();
}

// 解析 agent → def。派生/覆盖优先(用户 JSON 覆盖内置同名 id),否则取内置;均无则抛错。
export function getAgentDef(agent: string): AgentDef {
  const derived = loadDerived()[agent];
  if (derived) return derived;
  const def = AGENT_DEFS[agent];
  if (!def) throw new Error(`未知 agent: ${agent}`);
  return def;
}

// 列出用户派生的 agent 元数据(供渲染端在 agent 选择器列出新 agent)。覆盖内置同名的也在内。
export function listAgentProfiles(): DerivedAgentMeta[] {
  loadDerived();
  return derivedMetaCache ?? [];
}

// 把任意 agent(可能是派生新 id)解析为其内置 base AgentKind(U7)。内置→自身;派生→其 base;
// 未知 id→兜底 "claude"。用于会话文件/续接等只识内置语义的主进程逻辑(派生与 base 共用 CLI、会话文件)。
export function baseAgentKindOf(agent: string): AgentKind {
  if (agent === "claude" || agent === "codex" || agent === "pi") return agent;
  return listAgentProfiles().find((p) => p.id === agent)?.base ?? "claude";
}
