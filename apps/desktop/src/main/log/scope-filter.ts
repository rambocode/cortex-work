// 按 scope 的细粒度日志过滤（dev 噪声治理）。
//
// 诉求：dev 默认放开 debug 落盘已能看全部，但有时只想盯某几个子系统（如只看
// cli + pi-rpc 的流式细节）。electron-log 无内置 per-scope level，用 hook 实现白名单：
//  - 仅约束「细粒度级别」(debug/verbose/silly)；info 及以上始终放行（错误/告警不能被过滤掉）。
//  - 白名单 = CORTEX_DEBUG 环境变量 ∪ 设置项 generalSettings.log.debugScopes。
//  - 白名单为空 → 不额外过滤，交给全局级别阈值（dev=debug 即全放行）。
//
// 在源头按 level/scope 拦截，比写完再过滤便宜（被丢弃的低级别日志不触达脱敏 transform）。

import log from "./index";

// CORTEX_DEBUG 环境变量解析的 scope 白名单（进程级，启动即定）。
// 主进程可用 process.env（core 层禁用，主进程不受该约束）。
const envScopes = new Set(
  (process.env["CORTEX_DEBUG"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// 设置项下发的 scope 白名单（initLogger 读 generalSettings.log.debugScopes 后注入）。
let settingScopes = new Set<string>();
let installed = false;

// 更新设置项 scope 白名单（启动读设置时调用；运行时改设置后可再次调用刷新）。
export function setDebugScopes(scopes: string[] | undefined): void {
  settingScopes = new Set((scopes ?? []).map((s) => s.trim()).filter(Boolean));
}

// 细粒度级别（低于 info）才受 scope 白名单约束。
function isFineLevel(level: string): boolean {
  return level === "debug" || level === "verbose" || level === "silly";
}

// 判定一条日志是否放行。纯函数，便于单测。
export function shouldPass(level: string, scope: string | undefined): boolean {
  if (!isFineLevel(level)) return true;
  if (envScopes.size === 0 && settingScopes.size === 0) return true;
  const s = scope ?? "";
  return envScopes.has(s) || settingScopes.has(s);
}

// 安装 scope 过滤 hook（幂等：electron-log 的 hooks 是长生命周期数组，重复 push 会叠加）。
export function installScopeFilter(): void {
  if (installed) return;
  installed = true;
  // hook 对每个 transport 调用一次，返回 false 表示该 transport 丢弃这条 → 全 transport 丢弃。
  log.hooks.push((message) =>
    shouldPass(message.level, (message as { scope?: string }).scope) ? message : false,
  );
}

// 仅供单测重置已安装标志，避免跨用例串状态。生产代码不要调用。
export function __resetScopeFilterForTests(): void {
  installed = false;
  settingScopes = new Set();
}
