// pi 二进制原生凭据文件（`~/.pi/agent/auth.json`）与 Cortex 金库的 OAuth 同步。
//
// ── 为什么需要（实测事故） ────────────────────────────────────────────────────
// 设置页登录与连接测试走的是**主进程内**的 pi-ai（凭据来自 safeStorage 金库，
// credentials.ts），而聊天会话是独立 spawn 的 pi 二进制，只认它自己的
// `~/.pi/agent/auth.json`。两边不同步时会出现：「设置页已登录、连接测试通过，
// 会话却拿着旧 token 报 deactivated_workspace」——旧 token 是用户早前经 pi CLI
// 登录时留在 auth.json 里的，Cortex 重新登录只更新了金库，会话进程完全看不见。
//
// ── 同步规则 ─────────────────────────────────────────────────────────────────
//   · 只同步 oauth 型凭据。api_key 型经 CORTEX_PI_KEY 环境变量在 spawn 时注入，
//     绝不写进 auth.json（避免明文 key 多落一处磁盘）。
//   · 双向按 `expires` 较新者为准：spawn 出去的 pi 进程会自己刷新并回写 auth.json，
//     且 refresh token 是轮换的——单向用旧金库覆盖新文件会把两边的凭据一起打死。
//   · 金库没有凭据时**不导入也不删除**文件条目：用户可能只在 pi CLI 里登录过，
//     那是他自己的登录态；注销的清理由 removeFromPiNativeStore 显式完成
//     （不清的话旧 token 在下一次 spawn 复活，正是本次事故的形态）。
//   · auth.json 解析失败时跳过同步（宁可不同步，不覆盖用户文件）。

import { promises as fsp } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import type { Credential } from "@earendil-works/pi-ai";

import { createLogger } from "../log";
import { modifyStoredCredential, readStoredCredential } from "./credentials";

const log = createLogger("pi-native-auth");

// 测试注入点：单测里指向临时目录，避免碰真实 ~/.pi。
let authPathOverride: string | null = null;

/** 单测用：覆盖 auth.json 路径；传 null 复位。 */
export function setPiNativeAuthPathForTest(path: string | null): void {
  authPathOverride = path;
}

/** pi 二进制的原生凭据文件路径（与 pi CLI 同一份，spawn 共用 HOME）。 */
export function piNativeAuthPath(): string {
  return authPathOverride ?? join(homedir(), ".pi", "agent", "auth.json");
}

/** auth.json 的形状：providerId → pi Credential（与金库解密后的形状逐字一致）。 */
type NativeAuthFile = Record<string, Credential>;

/** 读文件。ENOENT → 空对象；解析失败 → null（调用方跳过同步，绝不写回覆盖）。 */
async function readNativeFile(): Promise<NativeAuthFile | null> {
  try {
    const raw = await fsp.readFile(piNativeAuthPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as NativeAuthFile;
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    return null;
  }
}

/** 原子落盘 + 0600（含 token 明文，与 pi CLI 自己的写法同权限）。 */
async function writeNativeFile(next: NativeAuthFile): Promise<void> {
  const path = piNativeAuthPath();
  await fsp.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, path);
  await fsp.chmod(path, 0o600).catch(() => undefined);
}

/** oauth 凭据的过期时间；非 oauth / 缺失记 0（任何有效凭据都比它「新」）。 */
function expiresOf(credential: Credential | undefined): number {
  return credential?.type === "oauth" && typeof credential.expires === "number" ? credential.expires : 0;
}

/**
 * 按新鲜度对齐某 Provider 的 OAuth 凭据。登录成功后与每次 pi spawn 前调用；
 * 任何失败只记日志不抛——同步挂了不该拦下 spawn（最坏回到「会话报未登录」的响亮失败）。
 */
export async function syncOAuthWithPiNativeStore(providerId: string): Promise<void> {
  try {
    const vaultCredential = await readStoredCredential(providerId);
    const vaultOauth = vaultCredential?.type === "oauth" ? vaultCredential : undefined;
    const file = await readNativeFile();
    if (file === null) {
      log.warn(`auth.json 不可解析，跳过 OAuth 同步（${providerId}）`);
      return;
    }
    const fileCredential = file[providerId];
    const fileOauth = fileCredential?.type === "oauth" ? fileCredential : undefined;
    if (!vaultOauth && !fileOauth) return;

    // 金库较新（或文件缺失/非 oauth）→ 推到文件。内容一致时不写盘，spawn 高频路径别空转磁盘。
    if (vaultOauth && expiresOf(vaultOauth) >= expiresOf(fileOauth)) {
      if (JSON.stringify(fileCredential) !== JSON.stringify(vaultOauth)) {
        await writeNativeFile({ ...file, [providerId]: vaultOauth });
      }
      return;
    }

    // 文件较新（pi 会话进程刚刷新过）→ 导回金库，让设置页/Gateway 也用上新 token。
    // 金库为空时刻意不导入：注销后旧 token 不该经这条路复活。
    if (fileOauth && vaultOauth) {
      await modifyStoredCredential(providerId, async () => fileOauth);
    }
  } catch (err) {
    log.warn(`OAuth 凭据同步失败（${providerId}）:`, (err as Error)?.message);
  }
}

/** 注销时从 auth.json 移除该 Provider 的条目（不清的话旧 token 会在下一次 spawn 复活）。 */
export async function removeFromPiNativeStore(providerId: string): Promise<void> {
  try {
    const file = await readNativeFile();
    if (!file || !(providerId in file)) return;
    const next = { ...file };
    delete next[providerId];
    await writeNativeFile(next);
  } catch (err) {
    log.warn(`auth.json 注销清理失败（${providerId}）:`, (err as Error)?.message);
  }
}
