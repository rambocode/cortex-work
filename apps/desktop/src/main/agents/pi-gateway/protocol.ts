// pi gateway 的跨进程协议契约（主进程 ⇄ pi-host worker）。
//
// 本文件是**唯一真源**：主进程侧的客户端（pi-gateway/client.ts）与 worker 侧的 host
// （src/worker/pi-host/）都只依赖这里的类型，两边不得各自另写一份镜像——迁移前
// `pi-rpc.ts` 那 879 行手抄协议镜像就是这么来的，代价是「升级 pi 必须重跑 .d.ts diff」。
//
// ── 承载（KTD2，抄 research/worker/transport.ts 的实测结论）────────────────────────────
// `utilityProcess` 的 **stdin 必须是 `ignore`**（electron.d.ts 明文），配别的值子进程直接起不来，
// 且表现为「code=0、无任何输出」——最难查的一种失败。故协议走
// `child.postMessage(line)` ⇄ `process.parentPort.postMessage(line)`，一行 JSONL 进、一行 JSONL 出。
// stdout/stderr 不参与协议，只进 2KB 尾环供崩溃诊断。
//
// ── 为什么用「统一 call 收口」而不是每个方法一个 method ─────────────────────────────
// `PiSessionEngine` 有 19 个方法，逐个写 RPC 分支是机械但极易漏的活（漏掉的表现是某个命令
// 静默失效）。这里把它们收敛成一个 `call`，参数是方法名 + 参数数组，两边各一处转发即可。
// 方法名的完整性由 `ENGINE_METHODS` 与接口的编译期对账保证（见下）。
//
// ── 多会话复用（常驻 runtime）────────────────────────────────────────────────────────
// 一个 pi-host worker **常驻并同时承载多个会话**：fork 与三包纯 ESM 闭包（~18MB）的动态
// import 只付一次，开会话只剩 `createAgentSession`。因此所有**会话级**消息都带 `sessionId`
// 路由键（open / call / uiResponse / closeSession 与 event / uiRequest），两侧各持一张
// sessionId → 会话 的注册表，A 会话的事件/回写绝不能落到 B 会话。
// 两个刻意的例外：
//   · 凭据请求（credentialRequest/Response）是 **provider 级全局能力**，与会话无关，
//     `requestId` 全局唯一即可路由，不带 sessionId；
//   · `reply` 靠 `id` 关联（id 由主进程在整条连接内唯一分配），也不需要 sessionId。
// 生命周期分两级：`closeSession` 关**一个**会话（进程不退）；`shutdown` 是**进程级**
// （关全部会话 + worker 退出，app 退出时用）。

import type { PiSessionEvent, PiUiRequest, PiUiResponsePayload } from "../../ipc/types";
import type { PiSessionEngine } from "../pi-inproc";

/**
 * 可经 RPC 转发的引擎方法名。
 *
 * `stop` 不在其中：它是**会话生命周期**动作（关会话并释放其资源），由 `closeSession` 承载，
 * 不能当普通调用转发——它还要在主进程侧摘注册表、了结在途 RPC，语义远多于一次方法调用。
 * `respondUi` 也不在：它是对反向调用 `ui.request` 的应答，走 `uiResponse` 通道。
 */
export const ENGINE_METHODS = [
  "ready",
  "loadSlashCommands",
  "prompt",
  "steer",
  "followUp",
  "abort",
  "fork",
  "getForkMessages",
  "setModel",
  "setThinkingLevel",
  "compact",
  "getState",
  "getSessionStats",
  "newSession",
  "switchSession",
  "getLastAssistantText",
  "getCommands",
] as const;

export type EngineMethod = (typeof ENGINE_METHODS)[number];

/**
 * 编译期对账：`ENGINE_METHODS` 必须恰好覆盖 `PiSessionEngine` 里除 `stop`/`respondUi` 之外的全部方法。
 *
 * 少写一个 → 该命令在 gateway 路径上静默失效；多写一个 → 转发到不存在的方法。
 * 两种都不会有运行时报错，只会「某个功能不灵」，故用类型系统把它变成编译错误。
 */
type ForwardableMethod = Exclude<keyof PiSessionEngine, "stop" | "respondUi">;
type _AssertNoMissing = Exclude<ForwardableMethod, EngineMethod> extends never ? true : never;
type _AssertNoExtra = Exclude<EngineMethod, ForwardableMethod> extends never ? true : never;
const _assertMethodsMatch: [_AssertNoMissing, _AssertNoExtra] = [true, true];
void _assertMethodsMatch;

// ── 主进程 → worker ──────────────────────────────────────────────────────────────────

/** 建会话。worker 收到后组装能力并 `createAgentSession`（进程与三包加载已就绪，只付这一段）。 */
export interface HostOpen {
  id: string;
  kind: "open";
  /** 主进程分配的会话路由键（连接内唯一）。此后该会话的全部会话级消息都带它。 */
  sessionId: string;
  /** 已经过 `preparePiOpenRequest` 的请求（含 bridgeServers / inProcExtensionPaths 等内部字段）。 */
  request: unknown;
  /** 本会话是否有 UI 回写出口（决定审批 hook 在无 UI 时的语义，见 origin 计划的 native-hooks）。 */
  hasUiOutlet: boolean;
}

/** 转发一次引擎方法调用。 */
export interface HostCall {
  id: string;
  kind: "call";
  /** 目标会话。worker 按它查注册表——发到不存在的会话回 `reply{ok:false}`，绝不落到别的会话。 */
  sessionId: string;
  method: EngineMethod;
  /** 按方法签名顺序排列的参数。两侧都不做形状校验——类型由 `PiSessionEngine` 在编译期保证。 */
  args: unknown[];
}

/** 对 worker 反向请求 `ui.request` 的应答。 */
export interface HostUiResponse {
  id: string;
  kind: "uiResponse";
  /** 目标会话。多会话下回写必须按会话路由——A 会话的审批应答落到 B 会话是最危险的串台。 */
  sessionId: string;
  /** 与 `WorkerUiRequest.requestId` 对应。 */
  requestId: string;
  payload: PiUiResponsePayload;
}

/**
 * 对 worker 反向请求 `credentials.get` 的应答（KTD1：密钥只在这一刻跨进程存在）。
 *
 * 各 op 的 `value` 语义：`read` → `JSON.stringify(Credential)`；`list` → `JSON.stringify(CredentialInfo[])`；
 * `write` → 写入后的凭据（同 read 形状）；`delete` → 恒为 null。
 *
 * 刻意**不带 sessionId**：凭据是 provider 级全局能力（多个会话共享同一金库），
 * `requestId` 全局唯一即可路由，加会话维度只会多一处可能对不上的关联键。
 */
export interface HostCredentialResponse {
  id: string;
  kind: "credentialResponse";
  requestId: string;
  /** 结果值；未配置 / 被拒绝 / delete 时为 null（**不是**空串——空串是合法的凭据值）。 */
  value: string | null;
  error?: string;
}

/**
 * 关**一个**会话：abort 在途 run → stop（解订阅/解挂起对话框）→ 释放该会话的 MCP 等资源。
 * **进程不退**——常驻 runtime 的核心语义；其它会话不受任何影响。
 * worker 侧幂等：关不存在/已关的会话回 `ok:true`（主进程是 fire-and-forget，重复关是正常竞态）。
 */
export interface HostCloseSession {
  id: string;
  kind: "closeSession";
  sessionId: string;
}

/** **进程级**终止：关全部会话并让 worker 退出。只在 app 退出（或单测强制回收）时使用。 */
export interface HostShutdown {
  id: string;
  kind: "shutdown";
}

export type HostMessage =
  | HostOpen
  | HostCall
  | HostUiResponse
  | HostCredentialResponse
  | HostCloseSession
  | HostShutdown;

// ── worker → 主进程 ──────────────────────────────────────────────────────────────────

/** 对 `open` / `call` / `shutdown` 的应答。 */
export interface WorkerReply {
  id: string;
  kind: "reply";
  ok: boolean;
  result?: unknown;
  /** `ok:false` 时的可读原因。与 `RpcResponse.error` 同义，客户端原样转成命令级失败。 */
  error?: string;
}

/** 会话事件流。`runId` 与 in-process 路径同义，渲染端据此丢弃迟到/串台事件。 */
export interface WorkerEvent {
  kind: "event";
  /** 事件归属的会话。主进程按它路由到对应 handle；无主（会话已关）的事件直接丢弃。 */
  sessionId: string;
  event: PiSessionEvent;
  runId?: string;
}

/**
 * 反向请求：需要用户回写的 UI 交互（审批 / askquestion）。
 * 主进程收到后转 `emitUiRequest`，用户回写经 `HostUiResponse` 送回。
 */
export interface WorkerUiRequest {
  kind: "uiRequest";
  /** 请求归属的会话。回写（HostUiResponse）必须原样带回，保证会话间的审批互不串台。 */
  sessionId: string;
  requestId: string;
  request: PiUiRequest;
}

/**
 * 反向请求：访问凭据金库（KTD1）。
 *
 * worker 侧给 pi 的 `ModelRuntime` 注入的 `CredentialStore` 在 pi 真要用密钥时才发这条，
 * 主进程用 safeStorage 解密后经 `HostCredentialResponse` 返回。密钥因此不常驻 worker、不落盘——
 * 严格优于 binary 路径（烘焙进 `.js` 文件 0600 + spawn env 占位符）。
 *
 * ── `op` 为什么必须存在（不是「读」一件事）────────────────────────────────────────
 * pi 的 `CredentialStore` 是四方法接口（read / list / modify / delete），其中 **`modify` 承载
 * OAuth 刷新后的 token 落盘**（`Models.getAuth()` 在锁内刷新并写回）。只支持读的话刷新结果
 * 只活在 worker 内存里，下次开会话仍拿旧 refresh token——而服务端很可能已经把它轮换作废，
 * 表现为**用户莫名其妙被登出**（`providers/credentials.ts` 文件头记的正是这个事故形态）。
 *
 * `op` 缺省是 `"read"`，故先落地的「只读」实现与本字段完全向后兼容。
 */
export interface WorkerCredentialRequest {
  kind: "credentialRequest";
  requestId: string;
  /**
   * 目标键。命名空间（语义定死在主进程侧的 `readGatewayCredential`）：
   *   · `provider:<id>` / 裸 `<id>` → 该 Provider 的凭据，值是 `JSON.stringify(Credential)`；
   *   · `secret:<NAME>`            → 命名 Secret 的明文（自定义 Provider 的 `${secret:NAME}`）；
   *   · `credentials:list`         → 凭据元信息清单，值是 `JSON.stringify(CredentialInfo[])`。
   */
  key: string;
  /** 操作。缺省 `"read"`。 */
  op?: "read" | "list" | "write" | "delete";
  /** `op:"write"` 时的新值（`JSON.stringify(Credential)`）。其余 op 忽略。 */
  value?: string;
}

/** worker 侧的日志转发（worker 的 stdout 不连终端，日志要经主进程的 logger 落盘）。 */
export interface WorkerLog {
  kind: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export type WorkerMessage =
  | WorkerReply
  | WorkerEvent
  | WorkerUiRequest
  | WorkerCredentialRequest
  | WorkerLog;

// ── 成帧 ────────────────────────────────────────────────────────────────────────────

/**
 * 一行 JSONL。
 *
 * 刻意不用结构化克隆直接传对象：事件里可能带 pi 的活对象（in-process 路径踩过——
 * 命令返回值与 `tool-start.input` 是活对象，`webContents.send` 会抛 "could not be cloned"，
 * 且堆栈里看不到 pi）。JSON 往返把序列化语义一次性钉死，与 binary 路径的 JSONL 完全一致。
 */
export function encodeLine(msg: HostMessage | WorkerMessage): string {
  return JSON.stringify(msg);
}

/** 解一行；非法 JSON 返回 null（调用方跳过该行并留痕，绝不因一行坏数据中断通道）。 */
export function decodeLine<T extends HostMessage | WorkerMessage>(line: string): T | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as T;
  } catch {
    return null;
  }
}
