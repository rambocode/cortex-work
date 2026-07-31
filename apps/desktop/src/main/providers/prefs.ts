// Provider 用户偏好（显示/隐藏 + baseUrl 覆盖）的 main-owned 落盘。
//
// ── 为什么不放 personal-workspace.json ────────────────────────────────────────
// 那份存档由 renderer **全量覆盖**写回（store:save），而 `toPersistedState`
//（packages/core/store/personal.ts）是**白名单**构造：任何主进程写进去、renderer 侧没有对应
// 字段的东西，都会被下一次全量保存悄悄抹掉。这两项偏好都由主进程窄写、经
// ProviderAuthSnapshot / ProviderAuthStatus 回读，本来就不需要 renderer 持久化，
// 落在自己的文件里才不会被 clobber。
//
// 隐藏偏好与**认证解耦**：shell 里的 ambient key 会让几十个 Provider 一并变成「已配置」，
// 模型选择器需要用户能主动收起不用的那些（替代旧 ProviderProfile.enabled 的职责）。
//
// baseUrl 覆盖是**用户偏好而非凭据**（自建网关地址不是秘密），故不进 safeStorage 金库。
//
// ── 为什么读是同步的 ─────────────────────────────────────────────────────────
// baseUrl 覆盖必须能被 `agents/pi-providers.ts` 的 `builtinProviderConfig()` 读到，而那条
// 路径（renderPiExtension → writePiExtension）是**纯同步**的、跑在 spawn 前一刻。
// 若这里只提供异步读，spawn 早于首次加载完成时会静默拿到「无覆盖」→ 请求发往官方端点，
// 而用户以为自建网关已生效 —— 正是 A5 在交接里点名要避免的那类静默失败。
// 文件不到 1KB 且 main-owned，同步读的代价可以忽略（`writePiExtension` 本就同步写文件）。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

import { cortexHome } from "../paths";
import { createLogger } from "../log";

const log = createLogger("provider-prefs");

const PREFS_FILE = "provider-prefs.json";

interface ProviderPrefsFile {
  version: 1;
  hiddenProviderIds: string[];
  /** providerId → 用户覆盖的自建网关/代理端点。缺省表示走 pi 内置目录的官方端点。 */
  baseUrlOverrides: Record<string, string>;
}

export function providerPrefsPath(): string {
  return join(cortexHome(), PREFS_FILE);
}

let cache: ProviderPrefsFile | null = null;

function emptyPrefs(): ProviderPrefsFile {
  return { version: 1, hiddenProviderIds: [], baseUrlOverrides: {} };
}

/** 同步加载并记忆。读盘失败（含首启 ENOENT）一律降级成空偏好，绝不抛错阻断 spawn。 */
function load(): ProviderPrefsFile {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(providerPrefsPath(), "utf8")) as ProviderPrefsFile;
    if (parsed?.version === 1) {
      cache = {
        version: 1,
        hiddenProviderIds: Array.isArray(parsed.hiddenProviderIds) ? parsed.hiddenProviderIds : [],
        baseUrlOverrides:
          parsed.baseUrlOverrides && typeof parsed.baseUrlOverrides === "object" ? parsed.baseUrlOverrides : {},
      };
      return cache;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn("Provider 偏好读取失败，按默认值处理:", (err as Error)?.message);
    }
  }
  cache = emptyPrefs();
  return cache;
}

/**
 * 原子落盘 + 同步更新镜像。
 * 刻意**同步且会抛错**：调用方是用户显式操作（点保存），写失败必须如实回报 ok:false，
 * 而不是像异步 fire-and-forget 那样吞进日志、UI 却显示保存成功。
 */
function persist(next: ProviderPrefsFile): void {
  const path = providerPrefsPath();
  mkdirSync(cortexHome(), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, path);
  cache = next;
}

// ── 显示/隐藏 ────────────────────────────────────────────────────────────────

export function getHiddenProviderIds(): string[] {
  return [...load().hiddenProviderIds];
}

/** 覆盖式写入（UI 每次提交完整列表）。 */
export function setHiddenProviderIds(providerIds: readonly unknown[]): void {
  const ids = [...new Set(providerIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  persist({ ...load(), hiddenProviderIds: ids });
}

// ── baseUrl 覆盖 ─────────────────────────────────────────────────────────────

/** 校验结果：合法时给出规范化后的值，非法时给出可直接展示的原因。 */
export type BaseUrlValidation = { ok: true; value: string } | { ok: false; error: string };

/**
 * 校验用户填的自建网关地址。
 *
 * 只接受 http/https 绝对地址：pi 会拿它去拼接各 API 的路径，相对路径或 `ws://`、`file://`
 * 之类协议在请求期才会失败，那时错误信息与「填错了 Base URL」完全对不上，很难自查。
 * 刻意**不**去掉尾部斜杠等做归一化 —— 原样保存用户输入，避免「我填的和显示的不一样」的困惑；
 * 「是否算覆盖」的比较由 pi-providers.ts 的 normalizeBaseUrl 负责。
 */
export function validateBaseUrl(input: string): BaseUrlValidation {
  const value = input.trim();
  if (!value) return { ok: false, error: "地址不能为空" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: "不是合法的 URL（需形如 https://gateway.example.com/v1）" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `不支持的协议 ${parsed.protocol}，只接受 http:// 或 https://` };
  }
  return { ok: true, value };
}

/**
 * 读取某 Provider 的 baseUrl 覆盖。**同步**，供 `agents/pi-providers.ts` 在渲染 extension 时调用
 * （见文件头「为什么读是同步的」）。无覆盖返回 undefined。
 */
export function getBaseUrlOverride(providerId: string): string | undefined {
  return load().baseUrlOverrides[providerId];
}

/** 全部覆盖的只读快照（拼状态快照时一次取完，省得逐个 Provider 读）。 */
export function getBaseUrlOverrides(): Readonly<Record<string, string>> {
  return { ...load().baseUrlOverrides };
}

/**
 * 写入或清除覆盖。传 undefined / 空串表示**清除**，恢复 pi 内置端点。
 * 非法地址抛错（由 IPC 层转成结构化 error），绝不落一个会让请求发错地方的值。
 */
export function setBaseUrlOverride(providerId: string, baseUrl: string | undefined): void {
  const current = load();
  const overrides = { ...current.baseUrlOverrides };
  if (baseUrl === undefined || !baseUrl.trim()) {
    if (!(providerId in overrides)) return; // 幂等：本就没有覆盖时不写盘
    delete overrides[providerId];
    persist({ ...current, baseUrlOverrides: overrides });
    return;
  }
  const validation = validateBaseUrl(baseUrl);
  if (!validation.ok) throw new Error(validation.error);
  if (overrides[providerId] === validation.value) return; // 值未变则不写盘
  overrides[providerId] = validation.value;
  persist({ ...current, baseUrlOverrides: overrides });
}

/** 单测用：清进程内镜像。 */
export function resetProviderPrefsForTests(): void {
  cache = null;
}
