// in-process pi 会话的**模型接入点**（迁移计划 U3 第 2 项 / R6）。
//
// ── 这个模块替掉了什么 ──────────────────────────────────────────────────────────
// 二进制路径下，自定义 Provider 要进入会话必须绕一大圈：
//   `custom-provider-runtime.ts` 把整段 JSON 里的 `${secret:NAME}` 换成 `${CORTEX_PI_SECRET_<N>}`
//   → `pi-providers.ts` 渲染成一个 .js extension 文件落到 `userData/pi-providers/`（0600）
//   → `pi-session.ts` 用 `-e` 让 pi 加载它，密钥真值经 spawn env 注入子进程。
// 进程边界一删，这条链路整体没有存在理由：主进程本来就能直接持有 pi 的模型注册表，
// 密钥解出来就在内存里用掉。于是本模块只做三件事：
//   1. 建一份注入了 safeStorage 金库的 `ModelRuntime`（= `createAgentSession({ modelRuntime })` 的入参）；
//   2. 把用户的自定义 Provider 同步进去（**复用** `custom-provider-registry.ts` 的既有构建逻辑）；
//   3. 把 providerId/modelId 解析成可直接喂给 `createAgentSession({ model })` 的模型对象。
//
// ── 与旧实现的密钥链路差异（安全面收敛，不是放宽）────────────────────────────────
//   · 不再有 `${CORTEX_PI_SECRET_<N>}` 占位符，也不再有 spawn env 注入；
//   · 不再往 `userData/pi-providers/*.js` 落任何 provider 配置文件（连占位符版本都不落）；
//   · API Key 由 `custom-provider-registry` 的 `auth.apiKey.resolve()` 在**请求那一刻**从金库解出，
//     不在注册时捕获进闭包 —— 明文驻留窗口比旧实现更短，且用户改完 Secret 立即生效；
//   · 内建 Provider 的凭据由注入的 `CredentialStore` 原生供给，不必再往 `~/.pi/agent/auth.json`
//     同步 OAuth（`syncOAuthWithPiNativeStore` 在这条路径上不需要）。
//   · 「明文密钥永不过 IPC 桥」的既有红线不变：本模块的返回值里没有任何密钥字段。
//
// ── 强制写法（KTD1 / KTD2，见迁移计划）──────────────────────────────────────────
//   · pi 三包都是纯 ESM，主进程被 electron-vite 打成 CJS。动态 import 的 specifier **必须**是
//     变量（数组 `join("/")` 拼）并加 `@vite-ignore`，与 `pi-runtime.ts` 同款。写成字符串字面量
//     会静默把整个 ESM 依赖图打进 CJS chunk —— 正是 0.1.52 / 0.1.53 正式包「模型运行时不可用」
//     那个坑。类型侧走 `import type`（编译期擦除，零运行时/打包影响）。
//   · 本文件**不得**出现 top-level await：rollup 对 CJS 输出直接拒绝，构建期即失败。
//
// ⚠️ 本模块尚未接线到会话层（`main/agents/pi-inproc/`），与 `custom-provider-runtime.ts` /
//    `pi-providers.ts` 的二进制路径**并存**，互不影响。

import type { Api, CredentialStore, Model, Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { safeId } from "../agents/pi-providers";
import { createLogger } from "../log";
import { createSafeStorageCredentialStore, listSecretNames, readSecrets } from "./credentials";
import { syncCustomProvidersInto } from "./custom-provider-registry";
import { listCustomProviders } from "./custom-providers";
import { getBaseUrlOverrides } from "./prefs";
import { collectSecretRefs, safeErrorMessage } from "./secrets";

const log = createLogger("pi-inproc-models");

/** 见文件头 KTD1：刻意不是字符串字面量，避免被打包器静态分析并把纯 ESM 图内联进 CJS chunk。 */
const PI_CODING_AGENT = ["@earendil-works", "pi-coding-agent"].join("/");

// ── 结构化错误 ────────────────────────────────────────────────────────────────

/**
 * 自定义 / 内建 Provider 无法进入 in-process 会话时抛出。
 *
 * `code` 的前三个取值与 `custom-provider-runtime.ts` 的 `CustomProviderRuntimeError` **逐字相同**：
 * 二进制路径与 in-process 路径在灰度期并存，两边对同一种失败必须给出同一个 code，
 * 否则上层（日志分流、将来渲染端的「跳转设置 → 模型服务」指引）会因为走了哪条路而行为不一致。
 * 刻意不 import 那个类：那条链路带着 extension 渲染与落盘的依赖，本模块整条都不需要。
 */
export class PiInprocProviderError extends Error {
  readonly code:
    | "custom-provider-not-found"
    | "custom-provider-invalid-json"
    | "custom-provider-secret-missing"
    /** in-process 独有：Secret 引用出现在本路径尚不能解析的位置（见 findUnsupportedSecretRefPaths）。 */
    | "custom-provider-secret-unsupported-position";
  readonly providerId: string;

  constructor(code: PiInprocProviderError["code"], providerId: string, message: string) {
    super(message);
    this.name = "PiInprocProviderError";
    this.code = code;
    this.providerId = providerId;
  }
}

// ── Secret 引用位置的体检（纯函数） ───────────────────────────────────────────

/**
 * `${secret:NAME}` 在本路径上**唯一**能被解析的位置：整段 Provider JSON 的顶层 `apiKey`。
 *
 * 为什么只有它：in-process 路径复用 `custom-provider-registry.buildProvider`，那里只对
 * `parsed.apiKey` 做 `resolveSecretRefs`（其余字段原样交给 pi-ai 的 `createProvider`）。
 * 而二进制路径是在 **JSON 文本层**整体替换成 `${CORTEX_PI_SECRET_<N>}`，再由 pi 的
 * `resolveConfigValueOrThrow` 对 `apiKey` 与 `headers` 做环境变量插值 —— 也就是说
 * **`headers` 里的引用在旧路径能用、在本路径不能用**。
 */
const SUPPORTED_SECRET_REF_PATH = "apiKey";

/**
 * 找出 JSON 里出现在「不受支持位置」的 `${secret:}` 引用，返回它们的路径（如
 * `headers.Authorization`、`models[0].headers.X-Trace`）。JSON 不合法时返回空数组
 * —— 那是另一个更靠前的错误，不该在这里重复报。
 *
 * 存在的意义是**把静默失败换成响亮失败**：不体检的话，一个写在 header 里的引用会以
 * `${secret:X}` 字面量原样发到上游，表现为一次莫名其妙的 401，用户完全无从下手。
 */
export function findUnsupportedSecretRefPaths(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const found: string[] = [];
  visitForSecretRefs(parsed, "", found);
  return found;
}

/** 深度遍历 JSON 值，把「含 Secret 引用且不在受支持位置」的字符串路径收集起来。 */
function visitForSecretRefs(node: unknown, path: string, out: string[]): void {
  if (typeof node === "string") {
    if (path !== SUPPORTED_SECRET_REF_PATH && collectSecretRefs(node).length > 0) {
      out.push(path || "(root)");
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => visitForSecretRefs(item, `${path}[${index}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      visitForSecretRefs(value, path ? `${path}.${key}` : key, out);
    }
  }
}

// ── 自定义 Provider 的开会话前体检 ───────────────────────────────────────────

/**
 * 开会话前对自定义 Provider 做一次体检：JSON 合法性 → Secret 可解 → Secret 位置受支持。
 * 命中内建 Provider（不在自定义列表里）时直接返回，不做任何事。
 *
 * 为什么必须是「抛错」而不是「降级继续」：`custom-provider-registry` 的 `resolve()` 在
 * Secret 缺失时返回 undefined（= 未配置），pi 随后会报一句泛泛的「provider 未认证」，
 * 与「你删掉的那个 Secret」毫无关联。这里提前失败并指名道姓，才是可诊断的。
 * 这条取舍与 `custom-provider-runtime.resolveCustomProviderExtension` 一字不差。
 */
export async function assertCustomProviderReady(providerId: string): Promise<void> {
  const wanted = safeId(providerId);
  let definition: { id: string; json: string } | undefined;
  try {
    definition = (await listCustomProviders()).find((item) => safeId(item.id) === wanted);
  } catch (err) {
    // 读不到自定义列表（磁盘异常）时放行：体检的职责是拦下已知的错误配置，
    // 绝不该反过来成为新的失败源 —— 真有问题会在下游解析模型时响亮暴露。
    log.warn("读取自定义供应商失败，跳过本次体检:", safeErrorMessage(err));
    return;
  }
  if (!definition) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(definition.json);
  } catch (err) {
    throw new PiInprocProviderError(
      "custom-provider-invalid-json",
      wanted,
      `供应商「${definition.id}」的配置不是合法 JSON，无法启动会话：${safeErrorMessage(err, "解析失败")}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PiInprocProviderError(
      "custom-provider-invalid-json",
      wanted,
      `供应商「${definition.id}」的配置顶层必须是一个 JSON 对象`,
    );
  }

  await assertSecretsResolvable(definition, wanted);

  const unsupported = findUnsupportedSecretRefPaths(definition.json);
  if (unsupported.length) {
    throw new PiInprocProviderError(
      "custom-provider-secret-unsupported-position",
      wanted,
      `供应商「${definition.id}」在 ${unsupported.join("、")} 处使用了 \${secret:...} 引用，` +
        `当前路径只支持把引用写在顶层 apiKey 上。请把该密钥改配到 apiKey，或暂时改用内置供应商。`,
    );
  }
}

/**
 * 确认 JSON 里引用到的每个 Secret 都能从金库里**解出真值**。
 *
 * 「取不到」有两种成因，排查方向完全不同，必须分开说（沿用二进制路径的措辞，用户看到的文案一致）：
 *   · 金库里压根没有这个名字 → 用户删了它（或从没填过）；
 *   · 名字在、但解不开（`readSecrets` 会静默丢弃 decrypt 失败的条目）→ 换机 / 重装 /
 *     钥匙串变更导致 safeStorage 密钥失效。
 * 合并成一句「尚未配置，请去填写」会让第二种情况的用户对着一个明明已填的值发呆。
 */
async function assertSecretsResolvable(definition: { id: string; json: string }, providerId: string): Promise<void> {
  const refs = collectSecretRefs(definition.json);
  if (!refs.length) return;

  // ⚠️ 明文只在本函数的栈上存在，且只用来判断「是否解得开」——不写回任何对象、不进日志、
  // 不作为返回值外泄。真正拿去发请求的解密发生在 custom-provider-registry 的 resolve()。
  const vault = await readSecrets();
  const missing = refs.filter((name) => vault[name] === undefined);
  if (!missing.length) return;

  const defined = new Set(await listSecretNames());
  const undecryptable = missing.filter((name) => defined.has(name));
  const absent = missing.filter((name) => !defined.has(name));
  const detail = [
    absent.length ? `尚未配置：${absent.join("、")}` : "",
    undecryptable.length ? `已保存但无法解密（多为换机或系统钥匙串变更导致）：${undecryptable.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("；");
  throw new PiInprocProviderError(
    "custom-provider-secret-missing",
    providerId,
    `供应商「${definition.id}」的 Secret ${detail}。请在「设置 → 模型服务 → Secret 管理」中重新填写后重试。`,
  );
}

// ── 注册表同步 ───────────────────────────────────────────────────────────────

/**
 * `ModelRuntime` 的最小操作面。
 *
 * 抽成接口而不是直接吃 `ModelRuntime`：那是个带私有字段的 class，结构类型不兼容，
 * 单测就只能去实例化真实 pi 类 —— 也就被迫在测试里加载纯 ESM 的 pi-coding-agent，
 * 与文件头的加载约束正面冲突。真实 `ModelRuntime` 天然满足这个结构。
 */
export interface PiInprocProviderRegistry {
  getProviders(): readonly { readonly id: string }[];
  /** 注册一个 pi-ai `Provider` 对象（自定义供应商走这条）。 */
  registerNativeProvider(provider: Provider): void;
  /** 以「配置覆盖」的形式登记（内建供应商的 baseUrl 覆盖走这条，绝不下发 models）。 */
  registerProvider(providerId: string, config: { baseUrl?: string }): void;
  unregisterProvider(providerId: string): void;
}

/** 一次同步的结果，供调用方观测（也让单测不必去翻 registry 内部状态）。 */
export interface PiInprocSyncResult {
  /** 本轮注册进去的自定义供应商 id。 */
  customProviderIds: string[];
  /** 本轮生效的 baseUrl 覆盖（仅内建供应商）。 */
  baseUrlOverrideIds: string[];
  /** 本轮被摘除的 id（用户删了定义 / 清了覆盖）。 */
  removedIds: string[];
}

// 上一轮登记进去的 id。用户删掉定义或清掉覆盖后要据此摘除，否则会残留成
// 「选得到但配置已不存在」的幽灵供应商。
//
// ⚠️ 刻意**不**复用 `custom-provider-registry` 模块内部那份 `registeredIds`：那份状态是
// 进程级单例，`pi-runtime.ts` 的注册表也在用。两份注册表共用一个「上轮登记了什么」，
// 会出现「A 先同步并把 x 从自己这里摘了 → 状态清空 → B 再同步时以为 x 从没登记过 →
// x 永远残留在 B 里」。所以本模块自己按 setProvider 的实际调用重算差集。
let lastCustomIds = new Set<string>();
let lastBaseUrlIds = new Set<string>();

// 同步串行化：多个会话可能同时开，两轮同步交错会让上面的差集算错
//（后发起的那轮拿到的是被前一轮改到一半的状态）。
let syncChain: Promise<unknown> = Promise.resolve();

/**
 * 把「自定义供应商 + baseUrl 覆盖」同步进给定注册表（幂等，可重复调用）。
 *
 * 两段的**顺序不可调整**：先注册自定义供应商，再登记 baseUrl 覆盖，且覆盖段跳过所有自定义 id。
 * 因为 `ModelRuntime.registerProvider` 会 `nativeExtensionProviders.delete(providerId)` ——
 * 对一个刚用 `registerNativeProvider` 注册好的自定义供应商调它，等于把它整个抹掉。
 */
export function syncPiInprocProviders(registry: PiInprocProviderRegistry): Promise<PiInprocSyncResult> {
  const run = syncChain.then(() => doSync(registry));
  // 链尾双分支吞掉结果：一次失败不该永久卡死后续同步。
  syncChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 一轮真正的同步。只在 syncChain 的串行闸门内被调用。 */
async function doSync(registry: PiInprocProviderRegistry): Promise<PiInprocSyncResult> {
  const removedIds: string[] = [];

  // ① 自定义供应商：整套构建（Catalog 优先不覆盖内建、能力字段完整性校验、apiKey 懒解密）
  //    全部复用 custom-provider-registry，本模块只负责把 setProvider/deleteProvider 映射到
  //    ModelRuntime 的 registerNativeProvider/unregisterProvider，并自己重算差集（见 lastCustomIds）。
  const customIds = new Set<string>();
  await syncCustomProvidersInto<Provider>({
    setProvider: (provider) => {
      customIds.add(provider.id);
      registry.registerNativeProvider(provider);
    },
    // 摘除交给下面的差集逻辑：那份模块级 registeredIds 是与 pi-runtime 共用的，不能当本模块的账本。
    deleteProvider: () => {},
  });
  for (const id of lastCustomIds) {
    if (customIds.has(id)) continue;
    registry.unregisterProvider(id);
    removedIds.push(id);
  }
  lastCustomIds = customIds;

  // ② baseUrl 覆盖：等价于二进制路径 `builtinProviderConfig` 渲染出的
  //    `registerProvider(id, { baseUrl })`，**绝不下发 models**（保留 pi 内置目录，
  //    见 pi-providers.ts 的核心不变量），也绝不下发 apiKey ——
  //    凭据由注入的 CredentialStore 原生供给，凭空补一个 apiKey 字段会绕过 pi 的
  //    「OAuth-only provider 不伪造 API-key 登录方式」守卫（0.82.1 实测，见 pi-providers.ts authFields）。
  const knownIds = new Set(registry.getProviders().map((p) => p.id));
  const baseUrlIds = new Set<string>();
  for (const [rawId, baseUrl] of Object.entries(getBaseUrlOverrides())) {
    const id = safeId(rawId);
    // 自定义供应商的端点由它自己的 JSON 定义，与二进制路径一致：那条路径的
    // resolveCustomProviderExtension 根本不读 provider-prefs。
    if (customIds.has(id)) continue;
    if (!knownIds.has(id)) {
      log.warn(`baseUrl 覆盖指向了注册表里不存在的供应商「${rawId}」，已跳过`);
      continue;
    }
    try {
      registry.registerProvider(id, { baseUrl });
      baseUrlIds.add(id);
    } catch (err) {
      // 单条覆盖失败不该拖垮整批同步 —— 其余供应商照常可用。
      log.warn(`供应商「${rawId}」的 baseUrl 覆盖登记失败:`, safeErrorMessage(err));
    }
  }
  for (const id of lastBaseUrlIds) {
    // 已经被①注册成自定义供应商的 id 绝不能在这里 unregister（会把它整个抹掉）。
    if (baseUrlIds.has(id) || customIds.has(id)) continue;
    registry.unregisterProvider(id);
    removedIds.push(id);
  }
  lastBaseUrlIds = baseUrlIds;

  return {
    customProviderIds: [...customIds],
    baseUrlOverrideIds: [...baseUrlIds],
    removedIds,
  };
}

// ── ModelRuntime 单例 ────────────────────────────────────────────────────────

/** `ModelRuntime.create` 里本模块会用到的那部分选项（其余保持 pi 默认）。 */
export interface PiInprocModelRuntimeOptions {
  /**
   * pi 的 agent 目录。缺省沿用 pi 自己的 `~/.pi/agent`，与二进制路径保持一致 ——
   * 用户经 pi CLI 写进 `models.json` 的 provider 配置在两条路径上都继续生效。
   */
  agentDir?: string;
  /** 是否允许创建时联网刷新模型目录。默认 false：开会话不该被一次网络超时拖住。 */
  allowModelNetwork?: boolean;
}

/** 动态 import 回来的形状。只声明本模块用得到的部分，避免把 pi 的类型面整个绑死。 */
interface PiCodingAgentModule {
  ModelRuntime: {
    create(options?: {
      credentials?: CredentialStore;
      authPath?: string;
      modelsPath?: string | null;
      allowModelNetwork?: boolean;
    }): Promise<ModelRuntime>;
  };
}

let runtimePromise: Promise<ModelRuntime> | null = null;
let runtimeOverride: ModelRuntime | null = null;

/**
 * 取（并缓存）in-process 会话用的 `ModelRuntime`，可直接作为
 * `createAgentSession({ modelRuntime })` 的入参。
 *
 * 每次取都会同步一遍自定义供应商与 baseUrl 覆盖（幂等且廉价，同 `pi-runtime.getModels` 的取舍），
 * 用户刚改完的配置立刻生效、不必重启。
 */
export async function getPiInprocModelRuntime(options?: PiInprocModelRuntimeOptions): Promise<ModelRuntime> {
  if (runtimeOverride) {
    await syncPiInprocProviders(runtimeOverride);
    return runtimeOverride;
  }
  runtimePromise ??= createRuntime(options).catch((err: unknown) => {
    // 失败不缓存：装包/权限问题修好后无需重启即可恢复（同 pi-runtime 的做法）。
    runtimePromise = null;
    log.error("pi-coding-agent 运行时加载失败:", safeErrorMessage(err));
    throw new Error("模型运行时不可用（pi-coding-agent 加载失败）");
  });
  const runtime = await runtimePromise;
  await syncPiInprocProviders(runtime);
  return runtime;
}

/**
 * 建一份注入了 safeStorage 金库的 `ModelRuntime`。
 *
 * `credentials` 一旦给了，pi 就**不再**读 `~/.pi/agent/auth.json` —— 金库成为唯一凭据来源。
 * 这正是 in-process 相对二进制路径最大的收敛：不必再把 OAuth 凭据往 pi 的原生 auth.json 同步
 *（`syncOAuthWithPiNativeStore` 是为「spawn 出去的 pi 读不到主进程金库」而存在的）。
 */
async function createRuntime(options?: PiInprocModelRuntimeOptions): Promise<ModelRuntime> {
  const mod = (await import(/* @vite-ignore */ PI_CODING_AGENT)) as PiCodingAgentModule;
  const agentDir = options?.agentDir;
  return mod.ModelRuntime.create({
    credentials: createSafeStorageCredentialStore(),
    // 不传 agentDir 时留空，由 pi 自己落到 `~/.pi/agent`（authPath 因为给了 credentials 而不生效）。
    ...(agentDir ? { authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` } : {}),
    allowModelNetwork: options?.allowModelNetwork ?? false,
  });
}

/**
 * 丢弃缓存的运行时，下次取时重建。
 *
 * 供应商定义 / Secret / baseUrl 的变更**不需要**调它（每次取都会重新同步）；
 * 真正需要的是「pi 包被替换」「金库被重置」这类整体失效的场景。
 */
export function invalidatePiInprocModelRuntime(): void {
  runtimePromise = null;
}

/** 单测注入点：传入替身 `ModelRuntime`，传 null 恢复真实实现并清空缓存。 */
export function setPiInprocModelRuntimeForTests(next: ModelRuntime | null): void {
  runtimeOverride = next;
  if (!next) runtimePromise = null;
}

/** 单测用：清掉「上一轮登记了哪些」的进程内状态与同步队列。 */
export function resetPiInprocProviderSyncStateForTests(): void {
  lastCustomIds = new Set();
  lastBaseUrlIds = new Set();
  syncChain = Promise.resolve();
}

// ── 会话模型解析 ─────────────────────────────────────────────────────────────

/** 会话要用的模型引用。`modelId` 缺省时取该供应商的第一个模型（同 pi-runtime.probe 的取舍）。 */
export interface PiInprocModelRequest {
  providerId: string;
  modelId?: string;
}

/**
 * 解析结果，字段名与 `CreateAgentSessionOptions` 对齐，可直接展开：
 * `createAgentSession({ ...(await resolvePiInprocModel(req)), cwd, tools, ... })`。
 */
export interface PiInprocModelSelection {
  modelRuntime: ModelRuntime;
  model: Model<Api>;
}

/**
 * 由 providerId（+ 可选 modelId）解析出会话要用的 `{ modelRuntime, model }`。
 *
 * 解析不出模型时**响亮失败**，绝不返回一个「没有 model」的结果：`createAgentSession` 在
 * `model` 缺省时会走自己的 `findInitialModel` 兜底链换一个用户从没选过的供应商 ——
 * 那正是 2026-08-03 那次「配置保存成功、聊天却报一个毫不相干的错」的成因。
 * 宁可开会话失败，也不可让用户以为在用选定的模型、实际不是。
 *
 * 注意：内建供应商的 baseUrl 覆盖已在同步阶段以 `registerProvider({ baseUrl })` 落到
 * **该供应商的全部模型**上（pi 的 applyExtension 会逐个改写 model.baseUrl），
 * 所以这里拿到的 model 天然带着覆盖，无需再做一次浅拷贝改写。
 */
export async function resolvePiInprocModel(request: PiInprocModelRequest): Promise<PiInprocModelSelection> {
  const providerId = safeId(request.providerId);
  // 体检放在建运行时之前：Secret 缺失这类问题在这里能给出指名道姓的错误，
  // 而落到 pi 侧只会得到一句泛泛的「provider 未认证」。
  await assertCustomProviderReady(request.providerId);

  const modelRuntime = await getPiInprocModelRuntime();
  const model = request.modelId
    ? modelRuntime.getModel(providerId, request.modelId)
    : modelRuntime.getModels(providerId)[0];
  if (!model) {
    throw new PiInprocProviderError(
      "custom-provider-not-found",
      providerId,
      request.modelId
        ? `模型不存在：${providerId}/${request.modelId}。请在「设置 → 模型服务」中检查该供应商与模型是否仍存在。`
        : `供应商「${request.providerId}」没有可用模型，无法启动会话。请在「设置 → 模型服务」中检查其配置。`,
    );
  }
  return { modelRuntime, model };
}
