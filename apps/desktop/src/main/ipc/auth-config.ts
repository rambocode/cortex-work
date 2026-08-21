// auth-config（W1）：团队工作区「应用内登录态」的持久化域。
// 明文字段 {baseUrl, workspaceId, workspaceSlug, userName, userEmail} + JWT token（safeStorage
// 加密为 base64 密文）落 userData/auth-config.json。渲染端登录成功后经 auth:set-config 全量写入，
// 冷启动经 auth:get-config 读回填充 runtime 配置 → 动态启用真实后端 ApiClient。
//
// 密钥纪律（对齐 team-node.ts / reply.ts）：token 用 safeStorage 加密落盘，绝不入日志；
// safeStorage 不可用（无钥匙串）时不落盘密文，token 仅存本次运行内存态（下次冷启动需重登）。
// 跨进程契约：IPC 通道 auth:get-config / auth:set-config / auth:clear-config 与
// packages/core/desktop/bridge.ts（authGetConfig/authSetConfig/authClearConfig）+ preload 三处手工对齐。

import { app, ipcMain, safeStorage } from "electron";
import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";

// 渲染端 ↔ 主进程传输的完整登录配置（token 为解密后明文，仅在 IPC 边界与内存中出现）。
export interface AuthConfig {
  baseUrl: string;
  workspaceId?: string;
  workspaceSlug?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  token?: string;
}

// 落盘文件形状：token 存 safeStorage 密文（encToken），其余明文（非敏感）。
interface AuthConfigFile {
  baseUrl?: string;
  workspaceId?: string;
  workspaceSlug?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  encToken?: string;
}

function configPath(): string {
  return join(app.getPath("userData"), "auth-config.json");
}

// safeStorage 加解密：不可用（无钥匙串）时返回 null → 不落盘密文，token 仅存内存本次运行。
function encryptSecret(plain: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.encryptString(plain).toString("base64");
  } catch {
    return null;
  }
}
function decryptSecret(b64: string | undefined): string | undefined {
  if (!b64) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(b64, "base64"));
  } catch {
    return undefined;
  }
}

// 纯函数：把完整配置序列化为落盘文件形状。token 经注入的 encrypt 加密为密文；加密不可用（返回 null）
// 时丢弃 token（绝不落盘明文）。encrypt 注入化便于就近单测。
export function serializeAuthConfig(
  cfg: AuthConfig,
  encrypt: (plain: string) => string | null,
): AuthConfigFile {
  const file: AuthConfigFile = {
    baseUrl: cfg.baseUrl,
    workspaceId: cfg.workspaceId,
    workspaceSlug: cfg.workspaceSlug,
    userId: cfg.userId,
    userName: cfg.userName,
    userEmail: cfg.userEmail,
  };
  if (cfg.token) {
    const enc = encrypt(cfg.token);
    if (enc) file.encToken = enc;
  }
  return file;
}

// 纯函数：反序列化落盘文件为完整配置。缺 baseUrl（核心字段）或非对象 → null（视为无配置）；
// 其余缺字段容错为 undefined；token 解密失败 → undefined（不阻断，调用方按未登录处理）。decrypt 注入化便于单测。
export function deserializeAuthConfig(
  raw: unknown,
  decrypt: (b64: string | undefined) => string | undefined,
): AuthConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const file = raw as AuthConfigFile;
  if (typeof file.baseUrl !== "string" || !file.baseUrl) return null;
  return {
    baseUrl: file.baseUrl,
    workspaceId: typeof file.workspaceId === "string" ? file.workspaceId : undefined,
    workspaceSlug: typeof file.workspaceSlug === "string" ? file.workspaceSlug : undefined,
    userId: typeof file.userId === "string" ? file.userId : undefined,
    userName: typeof file.userName === "string" ? file.userName : undefined,
    userEmail: typeof file.userEmail === "string" ? file.userEmail : undefined,
    token: decrypt(file.encToken),
  };
}

// 读回登录配置：文件缺失/损坏/无核心字段 → null。
function loadConfig(): AuthConfig | null {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
    return deserializeAuthConfig(raw, decryptSecret);
  } catch {
    return null;
  }
}

// 全量覆盖写入登录配置（token 加密）。
function saveConfig(cfg: AuthConfig): void {
  const file = serializeAuthConfig(cfg, encryptSecret);
  const p = configPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(file, null, 2), "utf8");
}

// 清除登录配置（登出）：物理删文件，不存在忽略。
function clearConfig(): void {
  try {
    rmSync(configPath());
  } catch {
    /* 不存在 → 已是登出态 */
  }
}

// register.ts 挂载入口：注册三条 IPC handler。
export function registerAuthConfigHandlers(): void {
  ipcMain.handle("auth:get-config", () => loadConfig());
  ipcMain.handle("auth:set-config", (_e, cfg: AuthConfig) => saveConfig(cfg));
  ipcMain.handle("auth:clear-config", () => clearConfig());
}
