// Provider 凭据金库：safeStorage 加密 + 主进程专属文件，并实现 pi 的 `CredentialStore`。
//
// ── 存放位置（红线） ──────────────────────────────────────────────────────────
// 落在 `~/.cortex-desktop/provider-credentials.json`（0600），**刻意不放进
// personal-workspace.json**：后者由 renderer 全量读写（store:load / store:save），任何写进去的
// 东西都会过桥，密文也不例外。凭据只在主进程内存活，renderer 只能拿到 configured/type/source。
//
// ── 写入串行（为什么） ────────────────────────────────────────────────────────
// pi 的 `CredentialStore.modify` 是唯一写路径，且 `Models.getAuth()` 会**在 modify 的锁内**执行
// OAuth 刷新（见 pi-ai/dist/auth/types.d.ts:38-52）。两个并发请求同时发现 token 过期时，若没有
// 互斥就会各自刷新、后写覆盖先写，其中一份 refresh token 被服务端作废 → 用户被登出。
// 这里用一条 promise 队列（同 ipc/store.ts 的 writeQueue 做法）把**整个金库**的读-改-写串起来：
// 比 pi 要求的「按 providerId 互斥」更强，同时顺带解决了单文件读-改-写的竞态。
//
// ── safeStorage 不可用（部分 Linux） ──────────────────────────────────────────
// 降级为**只读警告**：禁止新增/修改任何密钥，且绝不做明文回写。系统钥匙串恢复后自动恢复正常。

import { safeStorage } from "electron";
import { promises as fsp } from "fs";
import { join } from "path";

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

import { cortexHome } from "../paths";
import { createLogger } from "../log";
import type { CredentialStoreHealth } from "./contract";

const log = createLogger("provider-credentials");

/** 金库文件名。与 personal-workspace.json 同目录但**不同文件**，不参与 renderer 的全量读写。 */
const VAULT_FILE = "provider-credentials.json";

/** 单次持锁上限。pi 的 OAuth 刷新是网络调用且跑在锁内，卡死会连坐所有 Provider 的读写。 */
const LOCK_TIMEOUT_MS = 120_000;

/** 金库条目：只有 cipher 是密文，type/expiresAt 是**非秘密元数据**，用于免解密列状态。 */
interface VaultCredentialEntry {
  type: Credential["type"];
  /** safeStorage 加密后的 base64。明文是 JSON 序列化的 pi `Credential`。 */
  cipher: string;
  /** OAuth 过期时间（ms）。放明文里是为了「未过期/已过期」徽标不必解密。 */
  expiresAt?: number;
  updatedAt: number;
}

interface VaultSecretEntry {
  cipher: string;
  updatedAt: number;
}

interface VaultFile {
  version: 1;
  credentials: Record<string, VaultCredentialEntry>;
  secrets: Record<string, VaultSecretEntry>;
}

/** renderer 可见的凭据元信息（不含任何密钥material）。 */
export interface StoredCredentialMeta {
  providerId: string;
  type: Credential["type"];
  expiresAt?: number;
}

const EMPTY_VAULT: VaultFile = { version: 1, credentials: {}, secrets: {} };

export function vaultPath(): string {
  return join(cortexHome(), VAULT_FILE);
}

// ── safeStorage 封装 ─────────────────────────────────────────────────────────

/** 系统钥匙串是否可用。任何异常都按「不可用」处理，绝不因此崩主进程。 */
function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 金库健康状态。UI 据此把「新增/修改密钥」置灰并给出原因。 */
export function getCredentialStoreHealth(): CredentialStoreHealth {
  return encryptionAvailable()
    ? { available: true }
    : { available: false, reason: "系统密钥库不可用，无法保存或读取凭据（已进入只读模式）" };
}

/** 写入前的统一闸门：钥匙串不可用时**拒绝写**，而不是退化成明文。 */
function assertWritable(): void {
  if (!encryptionAvailable()) {
    throw new Error("系统密钥库不可用，已拒绝写入凭据（不会退化为明文保存）");
  }
}

function encrypt(plain: string): string {
  return safeStorage.encryptString(plain).toString("base64");
}

/** 解密失败返回 null 而非抛错——钥匙串换了/密文损坏时应表现为「未配置」，不是崩溃。 */
function decrypt(cipher: string): string | null {
  try {
    if (!encryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(cipher, "base64"));
  } catch {
    return null;
  }
}

// ── 文件读写 ─────────────────────────────────────────────────────────────────

// 进程内镜像。所有写都在锁内做「读镜像 → 改 → 落盘」，故镜像即权威态。
let cache: VaultFile | null = null;

async function loadVault(): Promise<VaultFile> {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(vaultPath(), "utf8");
    const parsed = JSON.parse(raw) as VaultFile;
    if (parsed && parsed.version === 1) {
      cache = {
        version: 1,
        credentials: parsed.credentials ?? {},
        secrets: parsed.secrets ?? {},
      };
      return cache;
    }
    log.warn("凭据文件版本不识别，按空金库处理");
  } catch (err) {
    // ENOENT 是首启常态，不记日志噪声；其余（权限/损坏）记一条但不抛。
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn("凭据文件读取失败，按空金库处理:", (err as Error)?.message);
    }
  }
  cache = { ...EMPTY_VAULT, credentials: {}, secrets: {} };
  return cache;
}

/** 原子落盘 + 0600。tmp 先建再 rename，避免半截文件；mode 在 writeFile 时给，rename 会保留。 */
async function saveVault(next: VaultFile): Promise<void> {
  const path = vaultPath();
  await fsp.mkdir(cortexHome(), { recursive: true });
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, path);
  // 已存在的旧文件 rename 后沿用 tmp 的 mode；这里再兜一次，防历史文件权限过宽。
  await fsp.chmod(path, 0o600).catch(() => undefined);
  cache = next;
}

// ── 串行锁 ───────────────────────────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();

/** 超时护栏：锁内任务（含 pi 的 OAuth 刷新网络调用）超时即放弃，让队列继续，不连坐后续写入。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("凭据写入超时（可能是刷新令牌的网络请求卡住）")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/**
 * 金库串行闸门：所有读-改-写都排这条队。
 * 链尾用 `.then(ok, fail)` 双分支吞掉结果，保证**一次失败不会永久卡死**后续任务。
 */
function withVaultLock<T>(task: () => Promise<T>, timeoutMs = LOCK_TIMEOUT_MS): Promise<T> {
  const run = chain.then(() => withTimeout(task(), timeoutMs));
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── 凭据读写 ─────────────────────────────────────────────────────────────────

function readCredentialFromVault(vault: VaultFile, providerId: string): Credential | undefined {
  const entry = vault.credentials[providerId];
  if (!entry) return undefined;
  const plain = decrypt(entry.cipher);
  if (plain === null) return undefined;
  try {
    return JSON.parse(plain) as Credential;
  } catch {
    log.warn(`凭据解析失败（${providerId}），按未配置处理`);
    return undefined;
  }
}

function toEntry(credential: Credential): VaultCredentialEntry {
  return {
    type: credential.type,
    cipher: encrypt(JSON.stringify(credential)),
    expiresAt: credential.type === "oauth" ? credential.expires : undefined,
    updatedAt: Date.now(),
  };
}

/** 读取存储的凭据（可能已过期）。仅主进程内部使用，**不得**经 IPC 外泄。 */
export function readStoredCredential(providerId: string): Promise<Credential | undefined> {
  return withVaultLock(async () => readCredentialFromVault(await loadVault(), providerId));
}

/** 列出凭据元信息（不解密、不含密钥）。 */
export function listStoredCredentialMetas(): Promise<StoredCredentialMeta[]> {
  return withVaultLock(async () => {
    const vault = await loadVault();
    return Object.entries(vault.credentials).map(([providerId, entry]) => ({
      providerId,
      type: entry.type,
      expiresAt: entry.expiresAt,
    }));
  });
}

/**
 * pi `CredentialStore.modify` 的实现：锁内「读当前 → 交给 fn → 写回」。
 * fn 返回 undefined 表示不改动（pi 契约），此时原样返回当前凭据。
 */
export function modifyStoredCredential(
  providerId: string,
  fn: (current: Credential | undefined) => Promise<Credential | undefined>,
): Promise<Credential | undefined> {
  return withVaultLock(async () => {
    const vault = await loadVault();
    const current = readCredentialFromVault(vault, providerId);
    const next = await fn(current);
    if (next === undefined) return current;
    assertWritable();
    await saveVault({
      ...vault,
      credentials: { ...vault.credentials, [providerId]: toEntry(next) },
    });
    return next;
  });
}

/** 删除凭据（登出）。与 modify 共用同一把锁。缺失时是 no-op（幂等）。 */
export function deleteStoredCredential(providerId: string): Promise<void> {
  return withVaultLock(async () => {
    const vault = await loadVault();
    if (!vault.credentials[providerId]) return;
    const credentials = { ...vault.credentials };
    delete credentials[providerId];
    await saveVault({ ...vault, credentials });
  });
}

/** 直接保存一个 API Key（`providerAuth:setApiKey` 的落点）。空串视为删除。 */
export async function setApiKeyCredential(providerId: string, apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await deleteStoredCredential(providerId);
    return;
  }
  assertWritable();
  await modifyStoredCredential(providerId, async (current) => {
    // 保留已有的 provider env（Cloudflare account id 之类），只换 key。
    const env = current?.type === "api_key" ? current.env : undefined;
    return { type: "api_key", key: trimmed, ...(env ? { env } : {}) };
  });
}

/**
 * 注入给 pi `createModels({ credentials })` 的 CredentialStore。
 *
 * 逐字对齐 `@earendil-works/pi-ai/dist/auth/types.d.ts:53-75`：read 缺失解析为 undefined、
 * list 不解密、modify 是唯一写路径且序列化、delete 与 modify 互斥。
 */
export function createSafeStorageCredentialStore(): CredentialStore {
  return {
    read: (providerId) => readStoredCredential(providerId),
    list: async (): Promise<readonly CredentialInfo[]> =>
      (await listStoredCredentialMetas()).map(({ providerId, type }) => ({ providerId, type })),
    modify: (providerId, fn) => modifyStoredCredential(providerId, fn),
    delete: (providerId) => deleteStoredCredential(providerId),
  };
}

// ── 命名 Secret ──────────────────────────────────────────────────────────────

/** 已定义的 Secret 名（不解密）。自定义 Provider 校验 `${secret:NAME}` 引用时用。 */
export function listSecretNames(): Promise<string[]> {
  return withVaultLock(async () => Object.keys((await loadVault()).secrets).sort());
}

/**
 * 批量写入命名 Secret。值为空串表示删除该项（UI 的「清空」语义）。
 * 一次调用内的全部改动在同一把锁里落盘，避免部分成功。
 */
export function setSecrets(secrets: Readonly<Record<string, string>>): Promise<void> {
  return withVaultLock(async () => {
    assertWritable();
    const vault = await loadVault();
    const next = { ...vault.secrets };
    for (const [name, value] of Object.entries(secrets)) {
      if (!value) {
        delete next[name];
        continue;
      }
      next[name] = { cipher: encrypt(value), updatedAt: Date.now() };
    }
    await saveVault({ ...vault, secrets: next });
  });
}

/**
 * 解密全部 Secret。**仅主进程内部**消费（渲染 extension 文件、连接测试拼 Header），
 * 返回值绝不可经 IPC 过桥、绝不可进日志。
 */
export function readSecrets(): Promise<Record<string, string>> {
  return withVaultLock(async () => {
    const vault = await loadVault();
    const out: Record<string, string> = {};
    for (const [name, entry] of Object.entries(vault.secrets)) {
      const plain = decrypt(entry.cipher);
      if (plain !== null) out[name] = plain;
    }
    return out;
  });
}

/** 单测用：清掉进程内镜像与队列，避免用例之间串状态。 */
export function resetCredentialVaultForTests(): void {
  cache = null;
  chain = Promise.resolve();
}
