// 个人工作区会话消息持久化：~/.cortex-desktop/chats/<sessionId>.json。
// 消息结构对主进程不透明（core 的 Message 类型），按 unknown[] 读写。

import { ipcMain } from "electron";
import { promises as fsp } from "fs";
import { join } from "path";
import { chatsDir, ensureMigrated } from "../paths";

const SAFE_ID = /^[\w-]+$/;

function chatDir(): string {
  return chatsDir();
}

function chatPath(sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error(`非法 session id: ${sessionId}`);
  return join(chatDir(), `${sessionId}.json`);
}

// 按 session 串行化写入，避免同一文件交错。
const writeQueues = new Map<string, Promise<void>>();

export function registerChatHandlers(): void {
  ipcMain.handle("chat:load", async (_e, sessionId: string) => {
    await ensureMigrated();
    try {
      const raw = await fsp.readFile(chatPath(sessionId), "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return []; // 首次或文件不存在
    }
  });

  ipcMain.handle("chat:save", (_e, sessionId: string, messages: unknown[]) => {
    const path = chatPath(sessionId);
    const prev = writeQueues.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await ensureMigrated();
        await fsp.mkdir(chatDir(), { recursive: true });
        const tmp = path + ".tmp";
        await fsp.writeFile(tmp, JSON.stringify(messages), "utf8");
        await fsp.rename(tmp, path);
      })
      .catch((err) => {
        console.error("[personal-chats] save failed:", err);
      });
    writeQueues.set(sessionId, next);
    return next;
  });

  ipcMain.handle("chat:delete", (_e, sessionId: string) => {
    const path = chatPath(sessionId); // 复用 SAFE_ID 校验
    // 排进同一写队列，避免与正在进行的 chat:save 交错。
    const prev = writeQueues.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await ensureMigrated();
        await fsp.rm(path, { force: true }); // 不存在不报错
      })
      .catch((err) => {
        console.error("[personal-chats] delete failed:", err);
      });
    writeQueues.set(sessionId, next);
    return next;
  });
}
