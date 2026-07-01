// 主进程统一日志核心（基于 electron-log v5）。
//
// 背景（为什么引入 electron-log）：原自研 logger 仅用 fs.appendFileSync 落盘，且
// patchConsole 只接管 console.error/warn —— dev 阶段最常用的 console.log/info/debug
// 无法落盘，也没有级别阈值与命名空间（scope）维度。electron-log 提供分级、scope、
// renderer→main 统一转发、transport 级 hooks/transforms，正好补齐这些能力。
//
// 设计约束（务必遵守）：
//  - 配置集中在主进程；renderer 端只 `import electron-log/renderer`，绝不在 renderer
//    整体覆盖 console（否则与 main 回显形成无限循环，见 electron-log issue #56）。
//  - 既有契约（logs:* IPC、generalSettings.log 设置项、按天文件 + 保留 N 天清理、
//    敏感字段脱敏）在 U2/U3 迁移保留，本文件只建「传输核心 + console 接管 + scope」。
//  - 文件名沿用「按天」心智：cortex-YYYY-MM-DD.log；关闭 electron-log 的大小轮转
//    （maxSize=0），保留期清理仍由自研 cleanupOldLogs 负责（electron-log 不提供）。

import log from "electron-log/main";
import { app } from "electron";
import { join } from "path";
import { logsDir } from "../paths";
import { redactData } from "./redact";

// electron-log 的日志级别（高→低）。scope 过滤与级别阈值在 U3 接入 hooks。
export type LogLevel = "error" | "warn" | "info" | "verbose" | "debug" | "silly";

// 幂等标志：initLog 重复调用会重复注入 preload / 重复接管 console，必须防重。
let initialized = false;

// 是否 dev 环境。core 不得碰 process.env，但主进程可用 app.isPackaged 判定：
// 未打包即视为本地开发（electron-vite dev / 直接 electron .）。
export function isDevEnv(): boolean {
  return !app.isPackaged;
}

// 按天日志文件全路径：logsDir()/cortex-YYYY-MM-DD.log。
// 抽成纯函数便于单测；resolvePathFn 每次写入都会调用，故跨天自动切到新文件，无需重启。
export function resolveLogFilePath(dir: string, date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return join(dir, `cortex-${y}-${m}-${d}.log`);
}

// 文件 transport 级别：dev 落到 debug（看全部细节），prod 只留 info 及以上
// （避免高频流式 debug 噪声进生产日志）。
export function fileLevelFor(dev: boolean): LogLevel {
  return dev ? "debug" : "info";
}

// 控制台 transport 级别：dev 输出 debug，prod 完全关闭（false 即彻底关闭该通道）。
export function consoleLevelFor(dev: boolean): LogLevel | false {
  return dev ? "debug" : false;
}

// 创建带 scope 的子 logger。scope 命名沿用现有 console 前缀（cli / pi-rpc /
// automation-runner / pty / watch / ipc 等），便于 CORTEX_DEBUG 按 scope 过滤（U3）。
export function createLogger(scope: string) {
  return log.scope(scope);
}

// 初始化日志核心。必须在创建第一个 BrowserWindow 之前调用（initialize 会向 session
// 注入 renderer 端 preload，晚于建窗则渲染端日志无法转发）。幂等。
export function initLog(): void {
  if (initialized) return;
  initialized = true;

  const dev = isDevEnv();

  // renderer→main 转发：注入 electron-log 的内置 preload（与既有 contextBridge 并存）。
  log.initialize();

  // 文件 transport：按天命名 + 关闭大小轮转（保留期清理交给自研 cleanupOldLogs）。
  log.transports.file.resolvePathFn = () => resolveLogFilePath(logsDir(), new Date());
  log.transports.file.maxSize = 0;
  log.transports.file.level = fileLevelFor(dev);

  // 控制台 transport：dev 输出、prod 关闭。
  log.transports.console.level = consoleLevelFor(dev);

  // 文件落盘脱敏：对每条日志的 data 数组就地脱敏（字符串走正则、对象走 key 级）。
  // 放在 file transport 而非全局 hook —— 被级别阈值拦下的低级别日志不会触达此处，省开销。
  // 必须 unshift 到最前而非 push 到末尾：electron-log 内置 transforms 顺序是
  // [removeStyles, format, concatFirstStringElements, toString]，跑完 toString 后
  // data 已被 util.formatWithOptions 拼成单个字符串——此时再对它调 .map 会抛
  // "data.map is not a function"（曾在生产触发，见 electron-log 的
  // processInternalErrorFn 兜底打印为 "Unhandled electron-log error"）。脱敏必须在
  // data 还是原始参数数组时进行，故排在内置 transforms 最前面。
  log.transports.file.transforms.unshift(({ data }) => data.map(redactData));

  // 异步写盘：electron-log 文件 transport 默认 sync=true（fs.writeFileSync），会把每条日志的
  // 磁盘写挂在主进程事件循环上。本应用有高频日志源（agent stdout 逐行、ipc-trace 每次 invoke
  // 落 debug），同步写会累积成 IPC/UI 卡顿（adversarial+performance 评审指出）。改异步写消除该
  // 阻塞；代价是进程瞬时崩溃时缓冲中的少量日志可能丢失——崩溃现场由 crash-guards 的 error 级
  // 单独保证（其落盘在退出前 flush 的概率足够），高频 debug 丢几行可接受。
  log.transports.file.sync = false;

  // scope 标签不做对齐填充，保持日志行紧凑。
  log.scope.labelPadding = false;

  // 接管全级别 console（仅主进程）：使 console.log/info/debug/warn/error 全部进入
  // electron-log 管线 → 命中级别阈值 / scope 过滤 / 脱敏 transform，统一落盘。
  // 这一步替代自研 patchConsole，且能捕获原本不落盘的 console.log/info/debug。
  Object.assign(console, log.functions);
}

// 文件落盘开关：映射到文件 transport 级别（关=false 彻底停写，开=恢复 dev/prod 阈值）。
// 供 logger.setLogEnabled / logs:setEnabled 复用，承接既有「启用文件日志」设置项。
export function setFileLogEnabled(on: boolean): void {
  log.transports.file.level = on ? fileLevelFor(isDevEnv()) : false;
}

// 暴露底层 logger，供 logLine / logs:write handler 复用同一管线。
export default log;
