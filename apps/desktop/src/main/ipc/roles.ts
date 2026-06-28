// 全局角色库 CRUD（~/.cortex-desktop/roles.json 持久化）。
// 对齐 agent-profiles.ts 模式：解析失败/字段非法不抛错不阻断启动，跳过 + warn。
// 不依赖 electron（用 os.homedir），便于单测。

import { ipcMain, BrowserWindow } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import type { RoleConfig } from "./types";

// ── 持久化路径（对齐 agents.local.json 同根） ──
export function defaultRolesPath(): string {
  return join(homedir(), ".cortex-desktop", "roles.json");
}

// ── 校验 ──

// id 约束与 agent-profiles 一致：小写字母数字 + 单连字符。
function isValidRoleId(id: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id);
}

function validateRole(raw: unknown): RoleConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.label !== "string" || !o.label) return null;
  if (typeof o.agent !== "string" || !o.agent) return null;
  if (typeof o.systemPrompt !== "string") return null;
  const role: RoleConfig = {
    id: o.id,
    label: o.label,
    agent: o.agent,
    systemPrompt: o.systemPrompt,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : new Date().toISOString(),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : new Date().toISOString(),
  };
  if (typeof o.color === "string") role.color = o.color;
  if (typeof o.avatar === "string") role.avatar = o.avatar;
  return role;
}

// ── 读写 ──

export function loadRoles(path?: string): RoleConfig[] {
  const filePath = path ?? defaultRolesPath();
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[roles] 读取 ${filePath} 失败:`, (e as Error).message);
    }
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.warn(`[roles] 解析 ${filePath} 失败(非法 JSON):`, (e as Error).message);
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: RoleConfig[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const r = validateRole(entry);
    if (!r) {
      console.warn("[roles] 跳过非法角色条目:", JSON.stringify(entry)?.slice(0, 200));
      continue;
    }
    if (seen.has(r.id)) {
      console.warn(`[roles] 重复角色 id「${r.id}」,保留首个、忽略后续`);
      continue;
    }
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function saveRoles(roles: RoleConfig[], path?: string): void {
  const filePath = path ?? defaultRolesPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(roles, null, 2), "utf8");
}

// ── CRUD ──

// id 生成：如果用户提供的 label 能转成合法 id 则用，否则 uuid 截短。
function labelToId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug && isValidRoleId(slug)) return slug;
  return randomUUID().slice(0, 8);
}

export interface CreateRolePayload {
  label: string;
  agent: string;
  systemPrompt: string;
  color?: string;
  avatar?: string;
}

export interface UpdateRolePayload {
  label?: string;
  agent?: string;
  systemPrompt?: string;
  color?: string;
  avatar?: string;
}

export function createRole(payload: CreateRolePayload, path?: string): RoleConfig {
  const roles = loadRoles(path);
  let id = labelToId(payload.label);
  // id 冲突时追加随机后缀
  if (roles.some((r) => r.id === id)) {
    id = `${id}-${randomUUID().slice(0, 4)}`;
  }
  const now = new Date().toISOString();
  const role: RoleConfig = {
    id,
    label: payload.label,
    agent: payload.agent,
    systemPrompt: payload.systemPrompt,
    color: payload.color,
    avatar: payload.avatar,
    createdAt: now,
    updatedAt: now,
  };
  roles.push(role);
  saveRoles(roles, path);
  return role;
}

export function updateRole(id: string, patch: UpdateRolePayload, path?: string): RoleConfig | null {
  const roles = loadRoles(path);
  const idx = roles.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const existing = roles[idx];
  const updated: RoleConfig = {
    ...existing,
    ...(patch.label !== undefined && { label: patch.label }),
    ...(patch.agent !== undefined && { agent: patch.agent }),
    ...(patch.systemPrompt !== undefined && { systemPrompt: patch.systemPrompt }),
    ...(patch.color !== undefined && { color: patch.color }),
    ...(patch.avatar !== undefined && { avatar: patch.avatar }),
    updatedAt: new Date().toISOString(),
  };
  roles[idx] = updated;
  saveRoles(roles, path);
  return updated;
}

export function deleteRole(id: string, path?: string): boolean {
  const roles = loadRoles(path);
  const filtered = roles.filter((r) => r.id !== id);
  if (filtered.length === roles.length) return false;
  saveRoles(filtered, path);
  return true;
}

// ── IPC 注册 ──

// 广播角色变更给所有渲染窗口，渲染端 store 据此刷新。
function broadcastRolesChanged(): void {
  const roles = loadRoles();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("roles:changed", roles);
  }
}

export function registerRoleHandlers(): void {
  ipcMain.handle("roles:list", () => loadRoles());

  ipcMain.handle("roles:create", (_e, payload: CreateRolePayload) => {
    const role = createRole(payload);
    broadcastRolesChanged();
    return role;
  });

  ipcMain.handle("roles:update", (_e, id: string, patch: UpdateRolePayload) => {
    const role = updateRole(id, patch);
    if (role) broadcastRolesChanged();
    return role;
  });

  ipcMain.handle("roles:delete", (_e, id: string) => {
    const deleted = deleteRole(id);
    if (deleted) broadcastRolesChanged();
    return deleted;
  });
}
