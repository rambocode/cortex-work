import { app, ipcMain, safeStorage } from "electron";
import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { ImChannel, ImChannelInput, ImChannelStatus, ImWechatLogin, ImWechatQrCode } from "@cortex-work/core/desktop/im-types";
import { getCortexRuntimeHandle } from "../cortex-runtime";
import { mergeImCredentials, normalizeImPlatformSpecs, type RuntimePlatformSpec } from "./im-contract";

interface StoredChannel extends Omit<ImChannel, "hasCredentials"> { encryptedCredentials?: string }

function filePath(): string { return join(app.getPath("userData"), "im-channels.json"); }
function loadStored(): StoredChannel[] {
  try { const value = JSON.parse(readFileSync(filePath(), "utf8")); return Array.isArray(value) ? value : []; } catch { return []; }
}
function saveStored(channels: StoredChannel[]): void {
  const path = filePath(); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(channels, null, 2), "utf8");
}
function encryptCredentials(value: Record<string, string>): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法保存 IM 凭据");
  return safeStorage.encryptString(JSON.stringify(value)).toString("base64");
}
function decryptCredentials(value?: string): Record<string, string> {
  if (!value) return {};
  try { return JSON.parse(safeStorage.decryptString(Buffer.from(value, "base64"))) as Record<string, string>; } catch { return {}; }
}
function publicChannel(channel: StoredChannel): ImChannel { return { ...channel, hasCredentials: !!channel.encryptedCredentials }; }
function runtimeHeaders(): Record<string, string> {
  const handle = getCortexRuntimeHandle(); if (!handle) throw new Error("Cortex Runtime 尚未就绪");
  return { Authorization: `Bearer ${handle.token}`, "Content-Type": "application/json" };
}
function runtimeUrl(path: string): string { const handle = getCortexRuntimeHandle(); if (!handle) throw new Error("Cortex Runtime 尚未就绪"); return handle.address + path; }

async function syncStoredToRuntime(storedChannels: StoredChannel[]): Promise<void> {
  const channels = storedChannels.map((channel) => ({
    id: channel.id, name: channel.name, platform: channel.platform, mode: channel.mode,
    output_mode: channel.outputMode, session_mode: channel.sessionMode, enabled: channel.enabled,
    credentials: decryptCredentials(channel.encryptedCredentials),
    target: { kind: channel.target.kind, workspace_id: channel.target.workspaceId, agent_id: channel.target.agentId, project_id: channel.target.projectId },
    execution: channel.execution ? { agent: channel.execution.agent, provider_id: channel.execution.providerId, model: channel.execution.model, cwd: channel.execution.cwd } : undefined,
  }));
  const response = await fetch(runtimeUrl("/v1/im/channels"), { method: "PUT", headers: runtimeHeaders(), body: JSON.stringify({ channels }) });
  if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "同步 IM 渠道失败");
}
export async function syncImChannelsToRuntime(): Promise<void> { await syncStoredToRuntime(loadStored()); }

async function getRuntimeData<T>(path: string): Promise<T[]> {
  const response = await fetch(runtimeUrl(path), { headers: runtimeHeaders() });
  if (!response.ok) throw new Error(`Cortex Runtime 请求失败 (${response.status})`);
  return (await response.json() as { data: T[] }).data;
}

export function registerImChannelHandlers(): void {
  ipcMain.handle("im:list", () => loadStored().map(publicChannel));
  ipcMain.handle("im:upsert", async (_event, input: ImChannelInput): Promise<ImChannel> => {
    const channels = loadStored(); const id = input.id || randomUUID(); const index = channels.findIndex((item) => item.id === id);
    const previous = index >= 0 ? channels[index] : undefined;
    const mergedCredentials = mergeImCredentials(
      previous ? decryptCredentials(previous.encryptedCredentials) : {},
      input.credentials,
    );
    const stored: StoredChannel = { id, name: input.name, platform: input.platform, mode: input.mode, outputMode: input.outputMode,
      sessionMode: input.sessionMode, enabled: input.enabled, target: input.target, execution: input.execution,
      encryptedCredentials: Object.keys(mergedCredentials).length ? encryptCredentials(mergedCredentials) : undefined };
    if (index >= 0) channels[index] = stored; else channels.push(stored);
    // Runtime 先原子校验并接受整份配置，再持久化；失败时磁盘仍保留上一份可用配置。
    await syncStoredToRuntime(channels); saveStored(channels); return publicChannel(stored);
  });
  ipcMain.handle("im:delete", async (_event, id: string): Promise<boolean> => {
    const channels = loadStored(); const next = channels.filter((item) => item.id !== id); if (next.length === channels.length) return false;
    await syncStoredToRuntime(next); saveStored(next); return true;
  });
  ipcMain.handle("im:platforms", async () =>
    normalizeImPlatformSpecs(await getRuntimeData<RuntimePlatformSpec>("/v1/im/platforms")),
  );
  ipcMain.handle("im:statuses", async () => {
    const rows = await getRuntimeData<{ id: string; state: ImChannelStatus["state"]; message?: string; updated_at: string }>("/v1/im/status");
    return rows.map((row) => ({ id: row.id, state: row.state, message: row.message, updatedAt: row.updated_at }));
  });
  ipcMain.handle("im:wechatQrCode", async (): Promise<ImWechatQrCode> => {
    const response=await fetch(runtimeUrl("/v1/im/wechat/qrcode"),{method:"POST",headers:runtimeHeaders()});if(!response.ok)throw new Error("获取微信二维码失败");const row=await response.json() as {qrcode:string;qrcode_url:string};return {qrcode:row.qrcode,qrcodeUrl:row.qrcode_url};
  });
  ipcMain.handle("im:wechatQrStatus", async (_event,qrcode:string): Promise<ImWechatLogin> => {
    const response=await fetch(runtimeUrl(`/v1/im/wechat/qrcode/status?qrcode=${encodeURIComponent(qrcode)}`),{headers:runtimeHeaders()});if(!response.ok)throw new Error("查询微信扫码状态失败");const row=await response.json() as {status:ImWechatLogin["status"];bot_token?:string;ilink_bot_id?:string};return {status:row.status,botToken:row.bot_token,ilinkBotId:row.ilink_bot_id};
  });
}
