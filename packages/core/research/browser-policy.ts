// Research Browser（agent-browser 降级路径）的命令行与 action policy 构造（spec §12.3、KTD7）。
//
// 为什么放在 packages/core：这是**纯字符串/纯对象**逻辑，没有任何 Node API，因此可以被 Worker
// 调用、被 main 复用、也能被 renderer 用来展示「本次将用什么参数启动浏览器」。同时它是安全断言
// 的落点——参数序列一旦被改动，core 的单测立刻变红，而不是等到某次真实抓取才暴露。
//
// U0 实测（docs/superpowers/specs/2026-07-25-cre-u0-spike-findings.md，S4 / S4a / S5 / S6）是本
// 文件的事实基础，其中两条必须牢记：
//   1) action policy 的动作名是**规范名**不是子命令名（`eval` 子命令 → 动作名 `evaluate`）；
//   2) action policy 是 **fail-open** 的——畸形或缺失的 policy 文件被静默忽略，动作照常执行。
//      因此「传了 --action-policy」不等于「策略生效」，调用方必须做运行期自检（见
//      apps/desktop/src/worker/research/browser/agent-browser-adapter.ts）。
//
// 命名风格：领域层一律 camelCase；policy 文件本身的字段名由 agent-browser 定义，保持原样。

/// Research 抓取允许的只读动作白名单（agent-browser 的**规范动作名**）。
///
/// 只保留「打开页面 / 读取内容 / 等待 / 收尾」所需的最小集合：任何写、执行、文件、凭据类动作
/// 都不在内。新增条目前必须先确认它不能被用来落盘、上传、执行脚本或读取本机资源。
export const READ_ONLY_ALLOWED_ACTIONS: readonly string[] = [
  "read",
  // `open` 是**子命令名**，agent-browser 把它归一成规范动作名 `navigate` 后再比对 allow 列表，
  // 所以只写 "open" 会让导航被 deny —— 同 PROBE_DENIED_ACTION(`eval`) 与
  // PROBE_DENIED_ACTION_NAME(`evaluate`) 那个坑。两个都留着：一是不同版本判定口径可能不同，
  // 二是它们语义等价（都只是「打开一个已在 --allowed-domains 内的 URL」），多留一个不放大权限。
  //
  // 这条曾经缺失的后果远超「导航失败」：适配器只能退用 `read <url>`，而那条路走 agent-browser
  // 自带的 HTTP 客户端、**根本不启动 Chrome**，于是 Browser 兜底对它存在的全部三个触发场景
  // （403 / 429 / 空正文）统统无效。实测同一 JS 渲染页：read 拿到 0 字，navigate 后 3188 字。
  "open",
  "navigate",
  "get",
  "snapshot",
  "close",
  "session",
  "wait",
  // `wait --load networkidle` 的规范名（`wait` 只覆盖「等元素 / 等毫秒」两种模式）。
  // 少了它，导航后就只能立刻 read，实测 5 次里有 2 次读到渲染未完成的空壳（11 字 vs 3188 字）。
  "waitforloadstate",
];

/// 只读 action policy 的形状（agent-browser `--action-policy` 的 JSON schema，U0 S4 实测确定）。
export interface ReadOnlyActionPolicy {
  default: "deny";
  allow: string[];
}

/// 构造只读 action policy。
///
/// **刻意使用 `default: "deny"` 白名单模式，而不是列黑名单**：白名单下 agent-browser 将来新增的
/// 任何动作（新版本引入的下载、文件、凭据类能力）默认被拒；黑名单下新动作会默认放行，等于每次
/// 升级二进制都在悄悄扩大攻击面。这条取舍不可逆转。
///
/// 每次返回全新对象：调用方常常要 JSON.stringify 后落盘，共享同一个可变对象容易被误改。
export function buildReadOnlyActionPolicy(): ReadOnlyActionPolicy {
  return { default: "deny", allow: [...READ_ONLY_ALLOWED_ACTIONS] };
}

/// fail-open 自检探针的**子命令名**（真正执行时写在命令行上的那个词）。
export const PROBE_DENIED_ACTION = "eval";

/// fail-open 自检探针的**规范动作名**（出现在 `Action 'evaluate' denied by policy` 里的那个词）。
/// 子命令名与规范名不同是 U0 S4 的关键发现，两个常量都保留以免调用方再次踩坑。
export const PROBE_DENIED_ACTION_NAME = "evaluate";

/// agent-browser 判定「动作被策略拒绝」时输出的稳定片段（U0 S4 实测文案）。
/// 自检只认这个标记，其它任何失败都不能被当作「策略生效」。
export const POLICY_DENIED_MARKER = "denied by policy";

/// `--max-output` 的默认值（spec §12.3）。
export const DEFAULT_BROWSER_MAX_OUTPUT = 200_000;

/// 首版**绝对禁止**出现在 Research Browser 命令行上的开关（spec §12.3、KTD7）。
///
/// 它们各自的危害：复用已登录 profile / 持久化状态（--profile / --state / --restore /
/// --auto-connect）、可见窗口干扰用户（--headed）、读本机文件（--allow-file-access）、
/// 绕过我们的出站策略（--proxy / --cdp）、执行任意二进制（--executable-path）。
/// 该数组同时被单测逐条断言，新增危险开关时先加到这里。
export const FORBIDDEN_AGENT_BROWSER_FLAGS: readonly string[] = [
  "--profile",
  "--state",
  "--restore",
  "--auto-connect",
  "--headed",
  "--allow-file-access",
  "--proxy",
  "--cdp",
  "--executable-path",
];

/// buildAgentBrowserArgs 的入参。sessionToken 一次性、namespace 由 buildResearchNamespace 生成、
/// policyPath 指向本次抓取专用的临时 policy 文件。
export interface AgentBrowserArgsInput {
  sessionToken: string;
  namespace: string;
  allowedDomains: string[];
  policyPath: string;
  maxOutput?: number;
}

/// 域名条目的合法字面量：不含逗号（会被 --allowed-domains 的分隔符切开）、空白与以 "-" 开头
/// （否则会被当成新的命令行开关）。这里只做「能否安全放进命令行」的判定，真正的 URL 策略由
/// checkUrlPolicy 负责。
const DOMAIN_ENTRY_PATTERN = /^[a-zA-Z0-9_.*[\]:-]+$/;

/// 构造 agent-browser 的固定参数序列（spec §12.3 的命令行模板，顺序确定、可逐字断言）。
///
/// 顺序固定不是洁癖：它让单测可以做 `toEqual` 全量比对，任何「顺手加一个 flag」的改动都会被拦下。
/// 动作（read / eval / close）由调用方追加在返回值之后。
///
/// 空的 allowedDomains 直接抛错而不是产出 `--allowed-domains ""`：后者在 agent-browser 里的语义
/// 未经实测，很可能等同「不限制」，属于 fail-open，必须在构造期就 fail closed。
export function buildAgentBrowserArgs(input: AgentBrowserArgsInput): string[] {
  if (input.sessionToken.length === 0) throw new Error("sessionToken 不能为空");
  if (input.namespace.length === 0) throw new Error("namespace 不能为空");
  if (input.policyPath.length === 0) throw new Error("policyPath 不能为空");
  if (input.allowedDomains.length === 0) {
    throw new Error("allowedDomains 不能为空：空白名单等于不限制出站域名");
  }
  for (const domain of input.allowedDomains) {
    if (!DOMAIN_ENTRY_PATTERN.test(domain) || domain.startsWith("-")) {
      throw new Error(`非法的 allowedDomains 条目: ${JSON.stringify(domain)}`);
    }
  }

  const maxOutput = input.maxOutput ?? DEFAULT_BROWSER_MAX_OUTPUT;
  return [
    "--session",
    input.sessionToken,
    "--namespace",
    input.namespace,
    // 不复用默认 profile / Cookie：每次抓取都是一次性无状态会话（KTD7）。
    "--restore-save",
    "never",
    "--allowed-domains",
    input.allowedDomains.join(","),
    "--content-boundaries",
    "--max-output",
    String(maxOutput),
    "--action-policy",
    input.policyPath,
    "--json",
  ];
}

/// namespace 前缀。带上产品名以便用户在进程列表 / 临时目录里一眼认出这是 Research 起的浏览器。
const NAMESPACE_PREFIX = "cortex-research-";

/// 清洗后的 sessionId 上限长度：namespace 会参与临时目录命名，过长在部分文件系统上会被截断。
const MAX_NAMESPACE_ID_LENGTH = 64;

/// 由 sessionId 构造隔离的 namespace。
///
/// **只保留 `[a-zA-Z0-9_-]`，其余字符一律丢弃**：sessionId 名义上是内部生成的 id，但它会原样
/// 进入命令行和临时目录路径，任何 `..`、`/`、`;`、`$()` 都是路径穿越与命令注入的入口。清洗后为空
/// 时回退到固定占位，避免产出裸前缀（多个 Session 共享同一 namespace 会互相污染会话状态）。
export function buildResearchNamespace(sessionId: string): string {
  const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, MAX_NAMESPACE_ID_LENGTH);
  return `${NAMESPACE_PREFIX}${sanitized.length > 0 ? sanitized : "unknown"}`;
}
