// Provider 认证 IPC 域（阶段②）：API Key / OAuth / 自定义 Provider 与 Secret。
//
// 红线：renderer 只能拿到 configured/type/source/error，**永不**接触明文或密文；
// 凭据、OAuth code、Header、token 不得进入日志、traces、argv 或错误详情
//（对外文本一律过 providers/secrets.ts 的 redactAuthText / safeErrorMessage）。
//
// 本文件只做「IPC 边界 + 状态拼装」，具体能力在 main/providers/ 下：
//   credentials.ts     safeStorage 金库 + pi CredentialStore（串行写）
//   oauth.ts           登录交互状态机（prompt/notify ↔ ProviderAuthEvent）
//   custom-providers.ts 自定义 Provider 定义的校验与落盘
//   pi-runtime.ts      pi-ai 懒加载与注入

import { BrowserWindow, ipcMain } from "electron";

import { PROVIDER_IPC } from "../providers/contract";
import type {
  CustomProviderDefinition,
  CustomProviderValidation,
  ProviderAuthEvent,
  ProviderAuthSnapshot,
  ProviderAuthStatus,
  ProviderConnectionTestResult,
  ProviderCredentialSource,
} from "../providers/contract";
import { getProviderCatalog } from "../providers/catalog";
import {
  deleteStoredCredential,
  getCredentialStoreHealth,
  listSecretNames,
  listStoredCredentialMetas,
  setApiKeyCredential,
  setSecrets,
} from "../providers/credentials";
import {
  deleteCustomProvider,
  listCustomProviders,
  saveCustomProvider,
  validateCustomProviderJson,
} from "../providers/custom-providers";
import { createLoginController } from "../providers/oauth";
import type { LoginController } from "../providers/oauth";
import { removeFromPiNativeStore, syncOAuthWithPiNativeStore } from "../providers/pi-native-auth";
import { getPiAuthRuntime, primePiRuntime } from "../providers/pi-runtime";
import {
  getBaseUrlOverride,
  getHiddenProviderIds,
  setBaseUrlOverride,
  setHiddenProviderIds,
} from "../providers/prefs";
import { safeErrorMessage } from "../providers/secrets";
import { createLogger } from "../log";
import { purgeLegacyProviderSettings } from "./store";

const log = createLogger("provider-auth");

/** 环境变量名的形态（全大写 + 下划线）。pi 的 source 标签用它区分「来自 env」与「来自 ambient 文件」。 */
const ENV_LABEL_RE = /^[A-Z][A-Z0-9_]*$/;

// ── 事件广播 ─────────────────────────────────────────────────────────────────

/** 推给所有窗口：设置页可能开在主窗口，也可能开在二级窗口，按 requestId 分发由 renderer 负责。 */
function emitAuthEvent(event: ProviderAuthEvent): void {
  // OAuth 登录一完成就把新凭据推到 pi 二进制的 auth.json（spawn 的会话只认那份文件）。
  // spawn 前的 resolvePiProviderInput 还会再同步一次，这里是让「登录完立刻发消息」也拿到新 token。
  if (event.type === "done" && event.status.configured && event.status.type === "oauth") {
    void syncOAuthWithPiNativeStore(event.providerId);
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(PROVIDER_IPC.authEvent, event);
  }
}

// ── 状态拼装 ─────────────────────────────────────────────────────────────────

/**
 * 把 pi 的 source 标签归类成契约里的来源枚举。
 *
 * pi 给的是人类可读标签（"ANTHROPIC_API_KEY" / "OAuth" / "~/.aws/credentials"）。
 * 到这一步已经确认**金库里没有**该 Provider 的凭据，所以剩下的只可能是环境变量或
 * 系统级 ambient 配置（AWS profile / gcloud ADC）—— 这两类 Cortex 都无权删除，
 * UI 据 source 禁用「删除凭据」按钮。
 */
function classifyAmbientSource(label: string | undefined): ProviderCredentialSource {
  if (label && ENV_LABEL_RE.test(label)) return "env";
  return "ambient";
}

/** 待展示的 Provider 集合：Catalog 为准；Catalog 不可用时退化成「有凭据的 + 自定义的」。 */
async function resolveProviderIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (const provider of getProviderCatalog()?.providers ?? []) ids.add(provider.id);
  for (const meta of await listStoredCredentialMetas()) ids.add(meta.providerId);
  for (const custom of await listCustomProviders()) ids.add(custom.id);
  return [...ids];
}

/**
 * 单个 Provider 的认证状态。判定顺序固定：
 *   ① 金库里有凭据 → source="safe-storage"（Cortex 自己保存的，可删）
 *   ② pi 认为已配置 → env / ambient（Cortex 无权删）
 *   ③ 都没有 → 未配置
 * ①优先于②是 pi 自己的语义（"a stored credential owns the provider"，见 auth/resolve.d.ts:14-19）。
 */
export async function resolveProviderStatus(providerId: string): Promise<ProviderAuthStatus> {
  // baseUrl 覆盖与认证正交：用户可以先配好自建网关再填 key，故不论 configured 与否都带出来。
  const override = getBaseUrlOverride(providerId);
  const withOverride = <T extends ProviderAuthStatus>(status: T): T =>
    override ? { ...status, baseUrlOverride: override } : status;

  const stored = (await listStoredCredentialMetas()).find((meta) => meta.providerId === providerId);
  if (stored) {
    return withOverride({
      providerId,
      configured: true,
      type: stored.type === "oauth" ? "oauth" : "api-key",
      source: "safe-storage",
      ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
    });
  }

  try {
    const check = await getPiAuthRuntime().checkAuth(providerId);
    if (check) {
      return withOverride({
        providerId,
        configured: true,
        type: check.type === "oauth" ? "oauth" : "api-key",
        source: classifyAmbientSource(check.source),
      });
    }
    return withOverride({ providerId, configured: false, source: "none" });
  } catch {
    // pi 运行时不可用时的降级：只按 Catalog 声明的环境变量名探一次 process.env。
    // 探不到 AWS profile / gcloud ADC 这类 ambient 来源，故只敢标 env 或 none。
    const envVars = getProviderCatalog()?.providers.find((item) => item.id === providerId)?.envVars ?? [];
    const hit = envVars.some((name) => Boolean(process.env[name]));
    return withOverride(
      hit
        ? { providerId, configured: true, type: "api-key", source: "env" }
        : { providerId, configured: false, source: "none" },
    );
  }
}

async function buildSnapshot(): Promise<ProviderAuthSnapshot> {
  const ids = await resolveProviderIds();
  const statuses = await Promise.all(ids.map((id) => resolveProviderStatus(id)));
  return { statuses, health: getCredentialStoreHealth(), hiddenProviderIds: getHiddenProviderIds() };
}

// ── 登录控制器 ───────────────────────────────────────────────────────────────

let loginController: LoginController | null = null;

function getLoginController(): LoginController {
  loginController ??= createLoginController({
    runtime: getPiAuthRuntime(),
    emit: emitAuthEvent,
    resolveStatus: resolveProviderStatus,
  });
  return loginController;
}

// ── 注册 ─────────────────────────────────────────────────────────────────────

/** 注册认证与自定义 Provider 通道。 */
export function registerProviderAuthHandlers(): void {
  // §5：新版本首启清掉旧 providerSettings（含明文 apiKey）。刻意不 await——清理与 IPC 注册
  // 无依赖关系，且失败也不该阻断启动；提示的一次性标记随清理一起落盘。
  void purgeLegacyProviderSettings().catch((err) => {
    log.warn("旧供应商配置清理失败:", safeErrorMessage(err));
  });

  // 后台预热 pi 运行时（纯 ESM，首次 import 较慢），使首次打开 Provider 设置页不必等加载。
  void primePiRuntime();

  ipcMain.handle(PROVIDER_IPC.authStatus, async (): Promise<ProviderAuthSnapshot> => {
    try {
      return await buildSnapshot();
    } catch (err) {
      log.warn("认证状态读取失败:", safeErrorMessage(err));
      return { statuses: [], health: getCredentialStoreHealth(), hiddenProviderIds: [] };
    }
  });

  ipcMain.handle(PROVIDER_IPC.authLogin, async (_e, providerId: string) => {
    if (!getCredentialStoreHealth().available) {
      return { ok: false, error: "系统密钥库不可用，无法保存登录凭据" };
    }
    return getLoginController().start(providerId);
  });

  // requestId 对回具体那一问：OAuth 会连续多问（先选登录方式，再贴回调码），
  // 只按 providerId 匹配会把第二问的答案错配给第一问。
  ipcMain.handle(PROVIDER_IPC.authRespond, (_e, requestId: string, value: string) =>
    getLoginController().respond(requestId, value),
  );

  ipcMain.handle(PROVIDER_IPC.authCancel, (_e, providerId: string) => getLoginController().cancel(providerId));

  ipcMain.handle(PROVIDER_IPC.authLogout, async (_e, providerId: string) => {
    try {
      const status = await resolveProviderStatus(providerId);
      // Cortex 只能删除**自己保存的**凭据：env / ambient 来源的密钥在用户的 shell 与系统配置里，
      // 删不掉也不该假装删掉（UI 会据 source 直接禁用按钮，这里是第二道闸）。
      if (status.configured && status.source !== "safe-storage") {
        return { ok: false, error: "该 Provider 的凭据来自环境变量或系统配置，请在对应位置移除" };
      }
      // 先走 pi 的 Models.logout：pi **没有** provider 级 logout 钩子，它内部就是
      // CredentialStore.delete（见计划附表），走它可顺带清掉 pi 侧缓存。
      // 失败（运行时加载不了）也不影响后续——金库删除才是权威动作。
      await getPiAuthRuntime()
        .logout(providerId)
        .catch(() => undefined);
      // 无条件再删一次金库：delete 幂等，这样即便 pi 侧实现变化，Cortex 自己保存的凭据一定被清掉。
      await deleteStoredCredential(providerId);
      // 同时清掉 pi 二进制 auth.json 里的条目：不清的话旧 token 会在下一次会话 spawn 时复活
      //（spawn 侧同步「金库为空不删文件」是为保护纯 CLI 登录态，注销必须在这里显式清）。
      await removeFromPiNativeStore(providerId);
      emitAuthEvent({ type: "done", providerId, status: await resolveProviderStatus(providerId) });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err, "注销失败") };
    }
  });

  // 明文 key 只在这一次调用里过桥，立刻 safeStorage 加密落盘，之后 renderer 再也读不回来。
  ipcMain.handle(PROVIDER_IPC.authSetApiKey, async (_e, providerId: string, apiKey: string) => {
    try {
      await setApiKeyCredential(providerId, apiKey);
      emitAuthEvent({ type: "done", providerId, status: await resolveProviderStatus(providerId) });
      return { ok: true };
    } catch (err) {
      // 刻意不带 providerId 之外的任何上下文：错误对象里可能夹带用户刚输入的 key。
      return { ok: false, error: safeErrorMessage(err, "保存失败") };
    }
  });

  ipcMain.handle(PROVIDER_IPC.authSetSecrets, async (_e, secrets: Record<string, string>) => {
    try {
      await setSecrets(secrets ?? {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err, "保存失败") };
    }
  });

  ipcMain.handle(PROVIDER_IPC.authSetHidden, (_e, providerIds: string[]) => {
    try {
      setHiddenProviderIds(Array.isArray(providerIds) ? providerIds : []);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err, "保存失败") };
    }
  });

  // 高级：自建网关 / 代理端点覆盖（计划 §4.2）。传 undefined 或空串清除覆盖、恢复 pi 内置端点。
  // 校验失败一律拒绝落盘 —— 一个填错的地址会让请求静默发往别处，比"没配上"危险得多。
  ipcMain.handle(PROVIDER_IPC.authSetBaseUrl, async (_e, providerId: string, baseUrl: string | undefined) => {
    try {
      if (typeof providerId !== "string" || !providerId) return { ok: false, error: "缺少 Provider id" };
      setBaseUrlOverride(providerId, typeof baseUrl === "string" ? baseUrl : undefined);
      emitAuthEvent({ type: "done", providerId, status: await resolveProviderStatus(providerId) });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err, "保存失败") };
    }
  });

  // 显式连接测试：真发一次最小请求，**保存配置不会自动触发**（会产生费用，须用户显式点）。
  ipcMain.handle(
    PROVIDER_IPC.connectionTest,
    async (_e, providerId: string, modelId?: string): Promise<ProviderConnectionTestResult> => {
      const startedAt = Date.now();
      try {
        const result = await getPiAuthRuntime().probe(providerId, modelId);
        return { ok: true, modelId: result.modelId, latencyMs: Date.now() - startedAt };
      } catch (err) {
        return { ok: false, ...(modelId ? { modelId } : {}), error: safeErrorMessage(err, "连接测试失败") };
      }
    },
  );

  ipcMain.handle(PROVIDER_IPC.customList, (): Promise<CustomProviderDefinition[]> => listCustomProviders());

  ipcMain.handle(PROVIDER_IPC.customSave, async (_e, def: CustomProviderDefinition) => {
    try {
      const result = await saveCustomProvider(def, await listSecretNames());
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err, "保存失败") };
    }
  });

  ipcMain.handle(PROVIDER_IPC.customDelete, async (_e, id: string) => {
    try {
      return await deleteCustomProvider(id);
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err, "删除失败") };
    }
  });

  ipcMain.handle(PROVIDER_IPC.customValidate, async (_e, json: string): Promise<CustomProviderValidation> => {
    try {
      return validateCustomProviderJson(json ?? "", await listSecretNames());
    } catch (err) {
      return { ok: false, errors: [{ message: safeErrorMessage(err, "校验失败") }] };
    }
  });
}

/** 单测用：清掉登录控制器单例（否则用例之间会共用同一个 runtime 替身）。 */
export function resetProviderAuthForTests(): void {
  loginController = null;
}
