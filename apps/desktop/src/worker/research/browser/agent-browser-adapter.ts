// agent-browser 降级路径的受限适配器（spec §12.3 Browser Adapter、KTD7、U0 findings S4/S4a/S5/S6）。
//
// 这是整条 Research 链路上唯一会把 URL 交给「我们不控制的网络栈」的地方，因此它的默认姿态是
// **不信任 agent-browser 的任何安全承诺**：
//
//   1) 出站策略自己再跑一遍（checkUrlPolicy）。U0 S6 实测：`agent-browser read` 对简单页面
//      **根本不启动 Chrome**（`browserLaunched:false` / `source:"html-fallback"`），走的是它自带
//      的 HTTP 客户端——**不受 Worker 的 DNS 钉扎与私网判定保护**。`--allowed-domains` 只是第二
//      道防线（S5 实测确实拦截顶层读取），不能当作第一道。
//   2) action policy 生效与否自己探针验证。U0 S4a 实测：**畸形或缺失的 policy 文件会被
//      agent-browser 静默忽略、动作照常执行（fail-open）**，所以「命令行里有 --action-policy」
//      完全不等于「策略生效」。抓取前必须用同一份 policy 跑一次必被拒的动作，观察到
//      `denied by policy` 才继续；否则 fail closed，返回 policy_not_enforced 让上层降级回纯 HTTP。
//   3) 无论成功失败都收尾：`close` + 删 policy 文件（try/finally，异常与取消路径同样执行）。
//
// 调用方前提（fetch_prepare 侧负责，本文件不做）：URL 的 **DNS 解析 + 逐地址私网判定**。core 层
// 没有 node:dns，Worker 的 resolveAndGuard 在 net/ 下，本适配器只做纯字符串层的 checkUrlPolicy。
//
// 本文件跑在 utilityProcess Worker 里，**禁止 import electron**。
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildAgentBrowserArgs,
  buildReadOnlyActionPolicy,
  buildResearchNamespace,
  POLICY_DENIED_MARKER,
  PROBE_DENIED_ACTION,
  PROBE_DENIED_ACTION_NAME,
} from "@cortex-work/core/research/browser-policy";
import { checkUrlPolicy, type IpRange } from "@cortex-work/core/research/url-safety";

/// 单次 Browser 抓取的总超时。Chrome 冷启动就要数秒，比 HTTP 的 20s 宽松。
const DEFAULT_BROWSER_TIMEOUT_MS = 60_000;

/// 收尾动作（close）的独立超时。收尾必须在主流程已超时/已取消后仍能执行，
/// 因此它不复用主信号，只受这个短超时约束。
const CLEANUP_TIMEOUT_MS = 10_000;

/// 子进程输出缓冲上限。比 --max-output 的默认 200000 字符留足余量，避免正常输出被截断成 JSON 残片。
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/// 一次子进程执行的结果。非零退出**不算异常**（策略拒绝就是以 code=1 返回的），
/// 只有 spawn 失败 / 被 abort 才 reject。
export interface BrowserRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/// 执行 agent-browser 的注入点。生产实现走 execFile；测试注入手写替身，不起真进程。
export type BrowserRunner = (
  binary: string,
  args: string[],
  signal: AbortSignal,
) => Promise<BrowserRunResult>;

/// 适配器的可注入依赖。全部有生产默认值，测试按需替换。
export interface BrowserAdapterDeps {
  run?: BrowserRunner;
  /// 写一次性 policy 文件，返回其绝对路径。
  writePolicyFile?: (dir: string, content: string) => Promise<string>;
  removePath?: (path: string) => Promise<void>;
  /// 生成一次性 session token（同时用于默认 policy 文件名）。
  randomToken?: () => string;
}

/// 一次 Browser 抓取的入参。
export interface BrowserFetchInput {
  url: string;
  /// Research Session id，用于派生隔离的 namespace（会被清洗，见 buildResearchNamespace）。
  sessionId: string;
  /// 允许出站的域名，同时用于 checkUrlPolicy 的 allowlist 与 --allowed-domains。
  allowedDomains: string[];
  /// main 解析出的 agent-browser 绝对路径。
  binary: string;
  /// 一次性 policy 文件所在目录（<userData>/research/browser-policy/）。
  policyDir: string;
  maxOutput?: number;
  timeoutMs?: number;
  /// 仅供集成测试放行 loopback 假站；生产不传（同 safe-request 的处理）。
  forbiddenRanges?: readonly IpRange[];
  allowedPorts?: readonly number[];
}

/// Browser 抓取的失败码。
///
/// 刻意**不复用**协议的 FetchFailureCode：`policy_not_enforced` 是本适配器特有的安全事件，
/// 协议枚举里没有对应项。调用方（fetch_prepare）把它映射成协议码时的建议：
///   policy_not_enforced / browser_error → browser_unavailable（降级回纯 HTTP 并记一条 warning）
///   blocked_by_policy / empty_content / timeout / cancelled → 同名协议码
export type BrowserFetchFailureCode =
  | "blocked_by_policy"
  | "policy_not_enforced"
  | "browser_error"
  | "empty_content"
  | "timeout"
  | "cancelled";

/// Browser 抓取结果。成功时只回传正文与最小元数据，Worker 不落库、不生成 documentId（KTD1）。
export type BrowserFetchResult =
  | {
      ok: true;
      url: string;
      finalUrl: string;
      title: string;
      text: string;
      /// agent-browser 是否真的起了 Chrome（false 表示走了它自带的 HTTP 客户端，见 U0 S6）。
      browserLaunched: boolean;
      source?: string;
    }
  | { ok: false; code: BrowserFetchFailureCode; message: string };

/// agent-browser `--json` 的输出信封。
interface AgentBrowserEnvelope {
  success?: boolean;
  data?: unknown;
  error?: string;
}

/// 主流程的截止控制：外部取消与超时合成一个信号，并保留「是超时还是取消」的判定。
interface Deadline {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

/// 合成一个「外部取消 ∪ 超时」的信号。
///
/// 为什么不用 AbortSignal.any + AbortSignal.timeout：需要区分两种终止原因（timeout / cancelled），
/// 而 any 只透传最先到达的 reason，判定要额外反查，反而更绕。
function withDeadline(external: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("browser fetch timeout"));
  }, timeoutMs);
  // 定时器不应阻止 Worker 进程退出。
  timer.unref?.();

  const onExternalAbort = (): void => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/// 从子进程输出中解析 JSON 信封。
///
/// 宽松解析的理由：agent-browser 在 `--json` 模式下仍可能先打印告警行，整段 JSON.parse 会失败；
/// 因此先整体尝试，再从后往前找第一行能解析的 JSON 对象。stdout 无果时再看 stderr。
function parseEnvelope(result: BrowserRunResult): AgentBrowserEnvelope | null {
  return parseJsonObject(result.stdout) ?? parseJsonObject(result.stderr);
}

/// 从一段文本里提取最后一个可解析的 JSON 对象。
function parseJsonObject(text: string): AgentBrowserEnvelope | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("{")) continue;
    const parsed = tryParse(line);
    if (parsed) return parsed;
  }
  return null;
}

/// JSON.parse 的安全包装：只接受对象。
function tryParse(text: string): AgentBrowserEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AgentBrowserEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

/// 判定探针是否**确实**被 action policy 拒绝（fail-open 自检的核心判据）。
///
/// 判据刻意从严，宁可误判为"未生效"而降级回 HTTP，也不能误判为"已生效"：
///   - 只要信封自称 success:true，就说明动作真的执行了 → 未生效；
///   - 输出必须同时含 `denied by policy` 与动作名（规范名 evaluate / 子命令名 eval），
///     避免把其它来源的 "denied by policy" 文案错认成本次策略生效。
function isProbeDenied(result: BrowserRunResult): boolean {
  const envelope = parseEnvelope(result);
  if (envelope?.success === true) return false;
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (!combined.includes(POLICY_DENIED_MARKER)) return false;
  return (
    combined.includes(PROBE_DENIED_ACTION_NAME) || combined.includes(`'${PROBE_DENIED_ACTION}'`)
  );
}

/// agent-browser 自报的域名/动作拦截文案 → 我们的 blocked_by_policy（U0 S4/S5 实测文案）。
function isBlockedByBrowserPolicy(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("not in the allowed domains") || lower.includes(POLICY_DENIED_MARKER);
}

/// 从 `read` 的 data 里宽松提取正文。
///
/// 为什么宽松：U0 只实测了 `success` / `lifecycle` / `source` 字段，正文字段名未被文档固定，
/// 不同版本可能是 text / content / markdown / body。全部取不到时返回空串，由调用方判 empty_content
/// ——**绝不用标题或 URL 顶替正文**（KTD3：抓不到正文就不产生 Document）。
function extractText(data: unknown): string {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "";
  const record = data as Record<string, unknown>;
  for (const key of ["text", "content", "markdown", "body"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}

/// 读取字符串字段。
function readString(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/// 判断 agent-browser 本次是否真的起了 Chrome（U0 S6 的两处字段都认）。
function readBrowserLaunched(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const lifecycle = (data as Record<string, unknown>).lifecycle;
  if (!lifecycle || typeof lifecycle !== "object") return false;
  const record = lifecycle as Record<string, unknown>;
  if (record.launched === true) return true;
  const effective = record.effectiveLaunch;
  return (
    !!effective &&
    typeof effective === "object" &&
    (effective as Record<string, unknown>).browserLaunched === true
  );
}

/// 生产用的子进程执行实现。
///
/// 两点刻意为之：
///   - 非零退出**不 reject**：策略拒绝、域名拦截都以 code=1 + JSON 信封返回，属于正常业务结果；
///   - 剥掉 *_PROXY 环境变量：spec §12.3 要求禁用环境代理，而 agent-browser 自带的 HTTP 客户端
///     很可能读取它们，代理会让我们的出站判定形同虚设。
function defaultRun(binary: string, args: string[], signal: AbortSignal): Promise<BrowserRunResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
    }

    execFile(
      binary,
      args,
      { signal, encoding: "utf8", maxBuffer: MAX_STDOUT_BYTES, env },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code !== "number") {
          // spawn 失败（ENOENT）或被 abort：无法得到任何可信输出。
          reject(error);
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: error ? ((error as NodeJS.ErrnoException).code as unknown as number) : 0,
        });
      },
    );
  });
}

/// 生产用的 policy 文件写入：目录按需创建，文件名带随机 token，权限 0600。
/// 文件名随机是为了避免并发抓取互相覆盖同一份 policy（覆盖窗口内会退化成 fail-open）。
async function defaultWritePolicyFile(dir: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `policy-${randomBytes(12).toString("hex")}.json`);
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}

/// 生产用的删除实现。force 让"文件已不存在"不算错误。
async function defaultRemovePath(path: string): Promise<void> {
  await rm(path, { force: true });
}

/// 把异常归类成失败码。
///
/// 判定顺序是 timeout → cancelled → 其它：外部取消会连带触发我们的合成信号，若先看
/// external.aborted 就会把「超时」误报成「用户取消」，UI 上是两件完全不同的事。
function classifyError(
  deadline: Deadline,
  external?: AbortSignal,
): "timeout" | "cancelled" | "browser_error" {
  if (deadline.timedOut()) return "timeout";
  if (external?.aborted) return "cancelled";
  return "browser_error";
}

/// 异常的可读文案。
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/// 通过受限的 agent-browser 抓取一个 URL。
///
/// 流程：URL 策略 → 写一次性 policy → **fail-open 自检探针** → read → finally 收尾。
/// 任何一步不满足安全前提都 fail closed，由调用方降级回纯 HTTP。
export async function browserFetch(
  input: BrowserFetchInput,
  deps: BrowserAdapterDeps = {},
  signal?: AbortSignal,
): Promise<BrowserFetchResult> {
  const run = deps.run ?? defaultRun;
  const writePolicyFile = deps.writePolicyFile ?? defaultWritePolicyFile;
  const removePath = deps.removePath ?? defaultRemovePath;
  const randomToken = deps.randomToken ?? (() => randomBytes(16).toString("hex"));

  if (signal?.aborted) {
    return { ok: false, code: "cancelled", message: "已取消" };
  }

  // 空白名单在 checkUrlPolicy 里语义是「不限制域名」，对 Browser 路径必须相反地 fail closed
  // ——没有 --allowed-domains 兜底的浏览器等于放任跳转到任意站点。
  if (input.allowedDomains.length === 0) {
    return { ok: false, code: "blocked_by_policy", message: "未提供 allowedDomains，拒绝启动浏览器" };
  }

  // 第一道闸：即便 --allowed-domains 生效，也不能把 URL 先递给 agent-browser 再指望它拦截
  // ——U0 S6 的 html-fallback 路径完全绕过我们的网络防护。
  const policyCheck = checkUrlPolicy({
    url: input.url,
    allowlist: input.allowedDomains,
    ...(input.forbiddenRanges ? { forbiddenRanges: input.forbiddenRanges } : {}),
    ...(input.allowedPorts ? { allowedPorts: input.allowedPorts } : {}),
  });
  if (!policyCheck.ok) {
    return { ok: false, code: "blocked_by_policy", message: policyCheck.message };
  }

  let policyPath: string;
  try {
    policyPath = await writePolicyFile(input.policyDir, JSON.stringify(buildReadOnlyActionPolicy()));
  } catch (error) {
    // 没有 policy 文件 = agent-browser 无策略运行（fail-open），绝不能继续。
    return { ok: false, code: "browser_error", message: `无法写入 action policy: ${messageOf(error)}` };
  }

  // 参数拼装可能因非法域名条目抛错。此时 policy 文件已经落盘，必须先清掉再返回，
  // 否则每次失败都会在 browser-policy/ 目录留一份垃圾文件。
  let baseArgs: string[];
  try {
    baseArgs = buildAgentBrowserArgs({
      sessionToken: randomToken(),
      namespace: buildResearchNamespace(input.sessionId),
      allowedDomains: input.allowedDomains,
      policyPath,
      ...(input.maxOutput === undefined ? {} : { maxOutput: input.maxOutput }),
    });
  } catch (error) {
    await removePath(policyPath).catch(() => undefined);
    return { ok: false, code: "browser_error", message: messageOf(error) };
  }

  const deadline = withDeadline(signal, input.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS);
  try {
    return await runProbeAndFetch(input, baseArgs, run, deadline, signal);
  } finally {
    deadline.dispose();
    // 收尾用独立信号：主流程可能已超时/已取消，但 close 与删文件仍必须执行，
    // 否则会残留临时 namespace、活着的浏览器进程和一份可被复用的 policy 文件。
    await cleanup(input.binary, baseArgs, policyPath, run, removePath);
  }
}

/// 自检 + 抓取。抽出来是为了让 browserFetch 的 try/finally 只负责收尾，不掺业务分支。
async function runProbeAndFetch(
  input: BrowserFetchInput,
  baseArgs: string[],
  run: BrowserRunner,
  deadline: Deadline,
  external: AbortSignal | undefined,
): Promise<BrowserFetchResult> {
  // ---- fail-open 自检（U0 S4a）----
  // 用**同一份 policy 文件**跑一次必被拒的动作；观察不到拒绝就判定策略未生效。
  let probe: BrowserRunResult;
  try {
    probe = await run(input.binary, [...baseArgs, PROBE_DENIED_ACTION, "1+1"], deadline.signal);
  } catch (error) {
    const code = classifyError(deadline, external);
    if (code !== "browser_error") return { ok: false, code, message: messageOf(error) };
    // 探针进程本身失败 → 无法确认策略生效 → 与"未生效"同等对待（fail closed）。
    return {
      ok: false,
      code: "policy_not_enforced",
      message: `action policy 自检无法完成: ${messageOf(error)}`,
    };
  }

  if (!isProbeDenied(probe)) {
    return {
      ok: false,
      code: "policy_not_enforced",
      message: "action policy 未生效（探针动作未被拒绝），已放弃 Browser 路径",
    };
  }

  // ---- 抓取：先导航，再读当前页 ----
  //
  // **不能只发 `read <url>`**：那条路走的是 agent-browser 自带的 HTTP 客户端
  // （`source: "html-fallback"`、`browserLaunched: false`），根本不启动 Chrome。
  // 而 Browser 兜底存在的全部理由就是「纯 HTTP 拿不到」—— 403 / 429 会原样再吃一次，
  // JS 渲染页拿到空正文。实测同一 JS 页：`read <url>` 0 字，`open` 后再 `read` 3188 字。
  //
  // 导航失败就直接返回，不再 read：此时当前标签页要么是空白页、要么还停在上一次的内容上，
  // 读出来的正文会被当成这个 URL 的正文写进证据库——比抓取失败严重得多。
  let navigated: BrowserRunResult;
  try {
    navigated = await run(input.binary, [...baseArgs, "open", input.url], deadline.signal);
  } catch (error) {
    return { ok: false, code: classifyError(deadline, external), message: messageOf(error) };
  }
  const navEnvelope = parseEnvelope(navigated);
  if (!navEnvelope || navEnvelope.success !== true) {
    const message = navEnvelope?.error ?? "agent-browser 导航失败";
    return {
      ok: false,
      code: isBlockedByBrowserPolicy(message) ? "blocked_by_policy" : "browser_error",
      message,
    };
  }

  // 等页面静默下来再读。**这一步不是保险而是必需**：实测 SPA 页面在 open 返回后立刻 read，
  // 5 次里有 2 次读到尚未渲染完的空壳（11 字 vs 完整的 3188 字）。加上 networkidle 后 5/5 稳定。
  // 等待失败**不阻断**：拿不到 networkidle（比如页面有长轮询）时读到的仍可能是完整正文，
  // 直接放弃这次抓取比读到部分内容更糟。
  try {
    await run(input.binary, [...baseArgs, "wait", "--load", "networkidle"], deadline.signal);
  } catch {
    // 忽略：下面的 read 仍会执行，读到什么算什么。
  }

  let fetched: BrowserRunResult;
  try {
    // 刻意不带 URL：带了 agent-browser 会重新用 HTTP 客户端抓一遍，白费上面那次导航。
    fetched = await run(input.binary, [...baseArgs, "read"], deadline.signal);
  } catch (error) {
    return { ok: false, code: classifyError(deadline, external), message: messageOf(error) };
  }

  const envelope = parseEnvelope(fetched);
  if (!envelope) {
    return { ok: false, code: "browser_error", message: "agent-browser 输出不是合法 JSON" };
  }
  if (envelope.success !== true) {
    const message = envelope.error ?? "agent-browser 抓取失败";
    return {
      ok: false,
      code: isBlockedByBrowserPolicy(message) ? "blocked_by_policy" : "browser_error",
      message,
    };
  }

  const text = extractText(envelope.data);
  if (text.trim().length === 0) {
    return { ok: false, code: "empty_content", message: "未能从页面中抽取出正文" };
  }

  const finalUrl = readString(envelope.data, "url") ?? input.url;
  const source = readString(envelope.data, "source");
  return {
    ok: true,
    url: input.url,
    finalUrl,
    title: readString(envelope.data, "title") ?? "",
    text,
    browserLaunched: readBrowserLaunched(envelope.data),
    ...(source === undefined ? {} : { source }),
  };
}

/// 收尾：close 会话 + 删除一次性 policy 文件。
///
/// 两个动作都 best-effort：收尾失败不得覆盖本次抓取的真实结果（那会把成功变成失败），
/// 但两者互不阻断——close 抛错也要继续删文件。
/// `--restore-save never` 保证会话不落盘，因此"清临时 namespace"就是对同一 namespace 执行 close。
async function cleanup(
  binary: string,
  baseArgs: string[],
  policyPath: string,
  run: BrowserRunner,
  removePath: (path: string) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("cleanup timeout")), CLEANUP_TIMEOUT_MS);
  timer.unref?.();
  try {
    await run(binary, [...baseArgs, "close"], controller.signal);
  } catch {
    // 忽略：浏览器可能压根没起来，或已经被 abort 杀掉。
  } finally {
    clearTimeout(timer);
  }

  try {
    await removePath(policyPath);
  } catch {
    // 忽略：残留文件由 main 的启动清理兜底（见 notes）。
  }
}
