// pi-host worker 侧的模型/Provider 接入点。
//
// ── 为什么不能直接复用 `providers/pi-inproc-models.ts` ────────────────────────────────
// 那个模块是「主进程版」的同一职责，但它的三份事实全都只有主进程拿得到：
//   · `createSafeStorageCredentialStore()` → `safeStorage`（主进程 API）
//   · `listCustomProviders()` / `getBaseUrlOverrides()` → 主进程的持久化存储
//   · `readSecrets()` → 同一把 safeStorage 金库
// 而它的产物 `ModelRuntime` 是**活对象**，没法经协议传过来。所以 worker 必须自己建一份，
// 只是把「凭据从哪来」换成 KTD1 的 RPC 通道。除此之外的判定（选不到模型就响亮失败等）
// 逐条对齐那个模块，措辞也照抄，保证两条路径给用户的文案一致。
//
// 自定义 Provider 的定义由主进程在 preparePiOpenRequest 边界从持久化状态读取后附到请求；
// JSON 里仍只有 `${secret:...}` 引用。worker 复用主进程同一份 builder 注册模型，真值只在
// builder 需要时经 credential RPC 读取，因此不会随 open 请求常驻或落盘。

// 类型侧 import：编译期擦除，不会把纯 ESM 的 pi 包拖进 worker 的 CJS 产物（KTD4）。
import type { CredentialStore } from "@earendil-works/pi-ai";

import type { PiInProcModelResolver, PiInProcModelSelection } from "../../main/agents/pi-inproc";
import { loadPiCodingAgent } from "../../main/agents/pi-inproc/runtime";
import type { PiOpenRequest } from "../../main/ipc/types";
import { safeId } from "../../main/agents/pi-providers";
import { buildCustomProvider } from "../../main/providers/custom-provider-builder";
import { createLogger } from "./log";

const log = createLogger("pi-host-model");

/** `ModelRuntime` 里本模块用得到的那部分（不 import 实体类，避免把纯 ESM 图拖进 bundle）。 */
interface ModelRuntimeLike {
  getProviders(): readonly { readonly id: string }[];
  getModels(providerId?: string): readonly unknown[];
  getModel(providerId: string, modelId: string): unknown;
  registerProvider(providerId: string, config: { baseUrl?: string }): void;
  registerNativeProvider(provider: unknown): void;
}

/**
 * 建 worker 侧的模型解析器（喂给 `openPiInProcSession` 的 `deps.resolveModel`）。
 *
 * `ModelRuntime` 在**每个 resolver 内缓存一份**。常驻 worker 每次 open 都新建 resolver，
 * 因而会话之间的 Provider 注册互不污染；同一会话构造期间的重复解析则复用这份 runtime。
 * 缓存失败不保留（同 `pi-inproc-models` 的取舍），修好装包/权限后重试即可恢复。
 */
export function createWorkerModelResolver(
  credentials: CredentialStore,
  readNamedSecret: (name: string) => Promise<string | null> = async () => null,
): PiInProcModelResolver {
  let runtimePromise: Promise<ModelRuntimeLike> | null = null;

  const getRuntime = (): Promise<ModelRuntimeLike> => {
    runtimePromise ??= createRuntime(credentials).catch((err: unknown) => {
      runtimePromise = null;
      throw err;
    });
    return runtimePromise;
  };

  return async (req: PiOpenRequest): Promise<PiInProcModelSelection> => {
    const runtime = await getRuntime();
    await applyCustomProvider(runtime, req, readNamedSecret);
    applyBaseUrlOverride(runtime, req);

    const providerId = req.providerId?.trim();
    // 没有 providerId 时**不猜模型**（与 `providers/default-model.ts` 的「两段必须成套」同源），
    // 但仍然要把 modelRuntime 交出去——它承载的是整个注册表与凭据通道，不只是被选中的那一个。
    if (!providerId) return { modelRuntime: runtime };

    const model = req.model ? runtime.getModel(providerId, req.model) : runtime.getModels(providerId)[0];
    if (!model) {
      // 响亮失败：`createAgentSession` 在 model 缺省时会走自己的 findInitialModel 兜底链，
      // 换成一个用户从没选过的供应商——用户以为在用选定模型、实际不是。宁可开会话失败。
      throw new Error(
        req.model
          ? `模型不存在：${providerId}/${req.model}。请在「设置 → 模型服务」中检查该供应商与模型是否仍存在。`
          : `供应商「${providerId}」没有可用模型，无法启动会话。请在「设置 → 模型服务」中检查其配置。`,
      );
    }
    return { modelRuntime: runtime, model };
  };
}

/** 把本次 open 对应的自定义定义同步进 worker 注册表；只传定义，不传任何 Secret 真值。 */
async function applyCustomProvider(
  runtime: ModelRuntimeLike,
  req: PiOpenRequest,
  readNamedSecret: (name: string) => Promise<string | null>,
): Promise<void> {
  const requestedId = req.providerId ? safeId(req.providerId) : "";
  const definition = req.customProvider;
  if (!definition) return;

  const definitionId = safeId(definition.id);
  if (!requestedId || definitionId !== requestedId) {
    throw new Error(`自定义供应商定义与请求不匹配：${definitionId || "(empty)"}/${requestedId || "(empty)"}`);
  }
  const built = await buildCustomProvider(definition, {
    readSecrets: async (names) => {
      const entries = await Promise.all(
        names.map(async (name) => [name, await readNamedSecret(name)] as const),
      );
      return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null));
    },
    onMissingHeaderSecrets: (providerId, header, missing) => {
      log.warn("自定义供应商 Header 引用的 Secret 缺失，该 Header 已丢弃", {
        providerId,
        header,
        missing,
      });
    },
  });
  if (!built) throw new Error(`自定义供应商「${definition.id}」没有可注册的模型`);
  runtime.registerNativeProvider(built.provider);
}

/**
 * 建 `ModelRuntime` 并注入 RPC 凭据仓（KTD1）。
 *
 * `credentials` 一给，pi 就**不再**读 `~/.pi/agent/auth.json` —— 主进程的 safeStorage 金库
 * 成为唯一凭据来源，与 in-process 路径语义一致，且 worker 侧不落盘任何密钥。
 * `allowModelNetwork: false`：开会话不该被一次模型目录刷新的网络超时拖住。
 */
async function createRuntime(credentials: CredentialStore): Promise<ModelRuntimeLike> {
  // 复用 `pi-inproc/runtime.ts` 的加载器：它已经处理了「变量 specifier + @vite-ignore」
  // 这条不可让步的写法（写成字面量会把纯 ESM 依赖图静默打进 CJS 产物，KTD4）。
  const mod = await loadPiCodingAgent();
  const runtime = await mod.ModelRuntime.create({ credentials, allowModelNetwork: false });
  return runtime as unknown as ModelRuntimeLike;
}

/**
 * 把主进程解析出的 baseUrl 覆盖登记到注册表。
 *
 * `preparePiOpenRequest` 已经在主进程侧把 Catalog + provider-prefs 合成了 `req.provider`
 * （见 `providers/pi-provider-input.ts`），worker 这边不必也不该再读一遍存储。
 *
 * **绝不下发 models、绝不下发 apiKey**：前者会顶掉 pi 的内置模型目录（`pi-providers.ts` 的
 * 核心不变量），后者会绕过 pi「OAuth-only provider 不伪造 API-key 登录方式」的守卫。
 * 单条登记失败只 warn：一个供应商的覆盖登记不该拖垮整个会话。
 */
function applyBaseUrlOverride(runtime: ModelRuntimeLike, req: PiOpenRequest): void {
  const provider = req.provider;
  if (!provider?.id || !provider.baseUrl) return;
  const known = runtime.getProviders().some((p) => p.id === provider.id);
  if (!known) {
    // 注册表里没有这个 id（多为自定义供应商——它的定义还没有跨进程通道，见文件头）。
    // 不静默：否则表现为「设置里配好了却还是走官方地址」，而日志里一片干净。
    log.warn("baseUrl 覆盖指向注册表里不存在的供应商，已跳过", { providerId: provider.id });
    return;
  }
  try {
    runtime.registerProvider(provider.id, { baseUrl: provider.baseUrl });
  } catch (err) {
    log.warn("baseUrl 覆盖登记失败", {
      providerId: provider.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
